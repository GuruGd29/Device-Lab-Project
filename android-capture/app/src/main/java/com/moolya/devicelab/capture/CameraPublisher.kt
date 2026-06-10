package com.moolya.devicelab.capture

import android.content.Context
import android.util.Log
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnection.RTCConfiguration
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpParameters
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Owns the WebRTC publish pipeline for ONE rear-facing camera track (spec §3 / §2: a camera
 * is "a thing producing a stream"; cardinality 1 camera : 1 TV).
 *
 *   REAR camera (Camera2Enumerator) → VideoSource (720p@30) → one VideoTrack
 *     → PeerConnection (sendonly transceiver, capped bitrate)
 *     → SDP offer → WHIP POST → apply answer → trickle ICE.
 *
 * Auto-reconnect: if the PeerConnection drops to FAILED/CLOSED (or the initial offer
 * round-trip throws), [scheduleReconnect] retries with a fixed backoff until [stop].
 *
 * Threading: all libwebrtc + signaling work runs on a single-thread [executor] so the
 * native objects are touched from one thread; callbacks marshal back onto it.
 */
class CameraPublisher(
    private val appContext: Context,
    private val config: CaptureConfig,
    private val eglBase: EglBase,
) {
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private val whip = WhipClient(config.sfuSignalingUrl)

    private var factory: PeerConnectionFactory? = null
    private var peerConnection: PeerConnection? = null
    private var videoCapturer: VideoCapturer? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var surfaceHelper: SurfaceTextureHelper? = null

    private val running = AtomicBoolean(false)

    /** Latest connection state, surfaced to the UI/service for status display. */
    @Volatile
    var lastState: PeerConnection.PeerConnectionState? = null
        private set

    fun start() {
        if (running.getAndSet(true)) return
        executor.execute { initFactoryAndConnect() }
    }

    fun stop() {
        if (!running.getAndSet(false)) return
        executor.execute {
            disposePeerConnection()
            try {
                videoCapturer?.stopCapture()
            } catch (e: InterruptedException) {
                Log.w(TAG, "stopCapture interrupted", e)
            }
            videoCapturer?.dispose()
            videoSource?.dispose()
            surfaceHelper?.dispose()
            factory?.dispose()
            videoCapturer = null
            videoSource = null
            videoTrack = null
            surfaceHelper = null
            factory = null
        }
        executor.shutdown()
    }

    // ── One-time native init + capture setup ──────────────────────────────────
    private fun initFactoryAndConnect() {
        if (factory == null) {
            // libwebrtc must be initialised once per process before any factory is built.
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(appContext)
                    .setEnableInternalTracer(false)
                    .createInitializationOptions(),
            )
            val encoderFactory = DefaultVideoEncoderFactory(
                eglBase.eglBaseContext,
                /* enableIntelVp8Encoder = */ true,
                /* enableH264HighProfile = */ true,
            )
            val decoderFactory = DefaultVideoDecoderFactory(eglBase.eglBaseContext)
            factory = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(encoderFactory)
                .setVideoDecoderFactory(decoderFactory)
                .createPeerConnectionFactory()

            createCaptureTrack()
        }
        connect()
    }

    /** Build the rear-camera capturer and a single video track at 720p@30. */
    private fun createCaptureTrack() {
        val enumerator = Camera2Enumerator(appContext)
        val rearName = enumerator.deviceNames.firstOrNull { enumerator.isBackFacing(it) }
            ?: enumerator.deviceNames.firstOrNull()
            ?: error("No camera devices found via Camera2Enumerator")
        Log.i(TAG, "Using rear camera: $rearName")

        val capturer = enumerator.createCapturer(rearName, capturerEvents)
        val source = factory!!.createVideoSource(/* isScreencast = */ false)
        val helper = SurfaceTextureHelper.create("CaptureThread", eglBase.eglBaseContext)
        capturer.initialize(helper, appContext, source.capturerObserver)
        // 720p @ 30fps — the spec's "offer 720p@30 with sane bitrate".
        capturer.startCapture(CAPTURE_WIDTH, CAPTURE_HEIGHT, CAPTURE_FPS)

        val track = factory!!.createVideoTrack(VIDEO_TRACK_ID, source)
        track.setEnabled(true)

        videoCapturer = capturer
        videoSource = source
        surfaceHelper = helper
        videoTrack = track
    }

    // ── Per-connection lifecycle (re-runnable on reconnect) ───────────────────
    private fun connect() {
        if (!running.get()) return
        val f = factory ?: return
        val track = videoTrack ?: return

        // STUN helps if the SFU is a hop away; on a flat lab LAN host candidates suffice.
        val iceServers = listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302")
                .createIceServer(),
        )
        val rtcConfig = RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            // Trickle ICE: emit candidates as they're gathered and PATCH them to the SFU.
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
        }

        val pc = f.createPeerConnection(rtcConfig, pcObserver)
            ?: run {
                Log.e(TAG, "createPeerConnection returned null; will retry")
                scheduleReconnect()
                return
            }
        peerConnection = pc

        // SEND_ONLY: this peer is a publisher — it ingests to the SFU, never receives.
        val transceiver = pc.addTransceiver(
            track,
            RtpTransceiver.RtpTransceiverInit(
                RtpTransceiver.RtpTransceiverDirection.SEND_ONLY,
                listOf(STREAM_ID),
            ),
        )

        createOfferAndPublish(pc, transceiver)
    }

    /**
     * Cap the encoder so we don't flood the LAN ("sane bitrate" per the spec).
     * Applied AFTER setLocalDescription — encodings aren't populated until the sender's
     * media direction is negotiated locally, so capping earlier can be a no-op.
     */
    private fun capBitrate(transceiver: RtpTransceiver) {
        val sender = transceiver.sender
        val params: RtpParameters = sender.parameters
        if (params.encodings.isEmpty()) return
        for (encoding in params.encodings) {
            encoding.maxBitrateBps = MAX_BITRATE_BPS
            encoding.maxFramerate = CAPTURE_FPS
        }
        sender.parameters = params
    }

    private fun createOfferAndPublish(pc: PeerConnection, transceiver: RtpTransceiver) {
        val constraints = MediaConstraints().apply {
            // Publisher: offer to send video, receive nothing.
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
        }
        pc.createOffer(object : SimpleSdpObserver("createOffer") {
            override fun onCreateSuccess(desc: SessionDescription) {
                pc.setLocalDescription(object : SimpleSdpObserver("setLocal") {
                    override fun onSetSuccess() {
                        // Local description set → encodings exist; cap bitrate, then candidates
                        // start flowing via onIceCandidate. Hand the offer to the SFU over WHIP.
                        capBitrate(transceiver)
                        executor.execute { exchangeWithSfu(pc, desc.description) }
                    }
                }, desc)
            }
        }, constraints)
    }

    private fun exchangeWithSfu(pc: PeerConnection, offerSdp: String) {
        if (!running.get()) return
        try {
            val answerSdp = whip.postOffer(config.cameraId, offerSdp)
            val answer = SessionDescription(SessionDescription.Type.ANSWER, answerSdp)
            pc.setRemoteDescription(object : SimpleSdpObserver("setRemote") {
                override fun onSetSuccess() {
                    Log.i(TAG, "Remote answer applied; publishing ${config.cameraId}")
                }
                override fun onSetFailure(error: String?) {
                    Log.e(TAG, "setRemoteDescription failed: $error")
                    scheduleReconnect()
                }
            }, answer)
        } catch (e: Exception) {
            Log.w(TAG, "WHIP exchange failed: ${e.message}; reconnecting")
            scheduleReconnect()
        }
    }

    private fun scheduleReconnect() {
        if (!running.get()) return
        Log.i(TAG, "Scheduling reconnect in ${RECONNECT_DELAY_MS}ms")
        executor.schedule({
            if (!running.get()) return@schedule
            disposePeerConnection()
            connect()
        }, RECONNECT_DELAY_MS, TimeUnit.MILLISECONDS)
    }

    private fun disposePeerConnection() {
        whip.delete()
        peerConnection?.dispose()
        peerConnection = null
    }

    // ── Observers ──────────────────────────────────────────────────────────────
    private val capturerEvents = object : CameraVideoCapturer.CameraEventsHandler {
        override fun onCameraError(error: String?) {
            Log.e(TAG, "Camera error: $error")
        }
        override fun onCameraDisconnected() { Log.w(TAG, "Camera disconnected") }
        override fun onCameraFreezed(error: String?) { Log.w(TAG, "Camera freezed: $error") }
        override fun onCameraOpening(cameraName: String?) { Log.d(TAG, "Camera opening: $cameraName") }
        override fun onFirstFrameAvailable() { Log.i(TAG, "First camera frame available") }
        override fun onCameraClosed() { Log.d(TAG, "Camera closed") }
    }

    private val pcObserver = object : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate) {
            // Trickle each locally-gathered candidate up to the SFU (WHIP PATCH).
            executor.execute {
                whip.trickleCandidate(candidate.sdpMid, candidate.sdpMLineIndex, candidate.sdp)
            }
        }

        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            lastState = newState
            Log.i(TAG, "PeerConnection state: $newState")
            when (newState) {
                PeerConnection.PeerConnectionState.FAILED,
                PeerConnection.PeerConnectionState.CLOSED,
                PeerConnection.PeerConnectionState.DISCONNECTED -> scheduleReconnect()
                else -> Unit
            }
        }

        override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState) {
            Log.d(TAG, "ICE connection state: $newState")
        }

        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onAddStream(stream: org.webrtc.MediaStream) = Unit
        override fun onRemoveStream(stream: org.webrtc.MediaStream) = Unit
        override fun onDataChannel(dc: org.webrtc.DataChannel) = Unit
        override fun onRenegotiationNeeded() = Unit
        override fun onTrack(transceiver: RtpTransceiver) = Unit
        override fun onAddTrack(
            receiver: org.webrtc.RtpReceiver,
            streams: Array<out org.webrtc.MediaStream>,
        ) = Unit
    }

    /** SdpObserver that only cares about success of one direction; logs failures. */
    private open inner class SimpleSdpObserver(private val op: String) : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription) = Unit
        override fun onSetSuccess() = Unit
        override fun onCreateFailure(error: String?) {
            Log.e(TAG, "$op create failed: $error")
            scheduleReconnect()
        }
        override fun onSetFailure(error: String?) {
            Log.e(TAG, "$op set failed: $error")
            scheduleReconnect()
        }
    }

    companion object {
        private const val TAG = "CameraPublisher"

        // Track / stream identifiers exposed to the SFU. The lab agent maps the ingest
        // for camera_id to `Camera.sfu_publish_track` it reports up to the cloud.
        private const val VIDEO_TRACK_ID = "devicelab-camera-video"
        private const val STREAM_ID = "devicelab-capture"

        private const val CAPTURE_WIDTH = 1280
        private const val CAPTURE_HEIGHT = 720
        private const val CAPTURE_FPS = 30
        // ~2.5 Mbps: plenty for 720p30 on a LAN without saturating Wi-Fi.
        private const val MAX_BITRATE_BPS = 2_500_000
        private const val RECONNECT_DELAY_MS = 3_000L
    }
}
