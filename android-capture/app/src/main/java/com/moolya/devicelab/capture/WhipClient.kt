package com.moolya.devicelab.capture

import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Minimal WHIP (WebRTC-HTTP Ingestion Protocol, draft-ietf-wish-whip) ingest client.
 *
 * Spec §3: "publish it to the lab agent's SFU via WHIP: HTTP POST the SDP offer to
 * {SFU_SIGNALING_URL}/whip/{camera_id}, apply the returned answer, and trickle ICE."
 *
 * WHIP flow this implements:
 *   1. POST  {base}/whip/{cameraId}   body = SDP offer, Content-Type: application/sdp
 *        → 201 Created, body = SDP answer, Location: <resource url> (the session handle).
 *   2. PATCH {resource}               body = ICE candidate(s) as an SDP fragment
 *        (Content-Type: application/trickle-ice-sdpfrag) — trickle a candidate up.
 *   3. DELETE {resource}              → end the ingest session on teardown.
 *
 * All calls are blocking and MUST be invoked off the main thread (the publisher uses a
 * background executor / coroutine dispatcher).
 */
class WhipClient(private val sfuSignalingBaseUrl: String) {

    /** Opaque per-session resource URL returned by the SFU in the POST's Location header. */
    @Volatile
    var resourceUrl: String? = null
        private set

    private val http = OkHttpClient.Builder()
        .callTimeout(15, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /**
     * POST the local SDP offer for [cameraId]; return the SFU's SDP answer.
     * Captures the Location header as [resourceUrl] for subsequent trickle/teardown.
     *
     * @throws IOException on transport failure or a non-201/200 response.
     */
    fun postOffer(cameraId: String, sdpOffer: String): String {
        val url = "$sfuSignalingBaseUrl/whip/$cameraId"
        val request = Request.Builder()
            .url(url)
            .post(sdpOffer.toRequestBody(SDP))
            .build()

        http.newCall(request).execute().use { response ->
            // WHIP mandates 201 Created; tolerate 200 from lenient SFUs.
            if (response.code != 201 && response.code != 200) {
                throw IOException("WHIP POST $url failed: HTTP ${response.code}")
            }
            val answer = response.body?.string()
                ?: throw IOException("WHIP POST $url returned no SDP answer body")

            // Location may be absolute or relative to the request URL — resolve against it.
            response.header("Location")?.let { loc ->
                resourceUrl = response.request.url.resolve(loc)?.toString() ?: loc
            }
            Log.i(TAG, "WHIP session established, resource=${resourceUrl ?: "<none>"}")
            return answer
        }
    }

    /**
     * Trickle a single ICE candidate up to the ingest session via PATCH.
     * The body is a minimal SDP fragment carrying the candidate for [sdpMid] / [sdpMLineIndex].
     * No-op (with a warning) if the SFU did not hand back a resource URL.
     */
    fun trickleCandidate(sdpMid: String?, sdpMLineIndex: Int, candidate: String) {
        val resource = resourceUrl ?: run {
            Log.w(TAG, "trickleCandidate before resourceUrl known; dropping candidate")
            return
        }
        // SDP fragment per draft-ietf-wish-whip §4.1: an m-line context plus the a=candidate.
        val frag = buildString {
            append("a=ice-ufrag:\r\n")
            append("a=ice-pwd:\r\n")
            append("m=${sdpMid ?: "video"} 9 UDP/TLS/RTP/SAVPF 0\r\n")
            append("a=mid:${sdpMid ?: sdpMLineIndex}\r\n")
            // WebRTC hands us the candidate WITHOUT the leading "a="; WHIP wants the SDP line.
            append("a=$candidate\r\n")
        }
        val request = Request.Builder()
            .url(resource)
            .patch(frag.toRequestBody(TRICKLE))
            .build()
        try {
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful && response.code != 204) {
                    Log.w(TAG, "WHIP PATCH trickle failed: HTTP ${response.code}")
                }
            }
        } catch (e: IOException) {
            // Trickle is best-effort; the host candidates in the offer usually suffice on a LAN.
            Log.w(TAG, "WHIP PATCH trickle error: ${e.message}")
        }
    }

    /** End the ingest session (DELETE the resource). Best-effort; safe to call repeatedly. */
    fun delete() {
        val resource = resourceUrl ?: return
        val request = Request.Builder().url(resource).delete().build()
        try {
            http.newCall(request).execute().use { /* ignore body */ }
        } catch (e: IOException) {
            Log.w(TAG, "WHIP DELETE error: ${e.message}")
        } finally {
            resourceUrl = null
        }
    }

    companion object {
        private const val TAG = "WhipClient"
        private val SDP = "application/sdp".toMediaType()
        private val TRICKLE = "application/trickle-ice-sdpfrag".toMediaType()
    }
}
