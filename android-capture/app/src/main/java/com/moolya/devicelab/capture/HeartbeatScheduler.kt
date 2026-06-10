package com.moolya.devicelab.capture

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Periodic camera heartbeat (spec §3): every [intervalSeconds] POST to
 *   {SFU_SIGNALING_URL}/camera/{camera_id}/heartbeat
 * so the lab agent can report this camera as `online`. The agent then folds that liveness
 * into the `agent.heartbeat` it sends the cloud (cameras[].status, see agent-protocol.ts),
 * which ultimately drives `CameraStatus` (domain.ts) and the TV's testable gate.
 *
 * Runs on its own single-thread scheduler so it is independent of the WebRTC pipeline:
 * the camera should report "I'm alive and trying" even during a publish reconnect.
 *
 * NOTE: a 10s cadence is far below WorkManager's 15-minute periodic floor, so this is a plain
 * ScheduledExecutorService living inside the foreground [PublisherService] (which keeps the
 * process alive). The service is START_STICKY, so the OS restarts it (and this scheduler) after
 * a low-memory kill — which is the recovery path instead of a coarse WorkManager backstop.
 */
class HeartbeatScheduler(
    private val config: CaptureConfig,
    private val intervalSeconds: Long = 10L,
    private val publisherStateProvider: () -> String,
) {
    private var scheduler: ScheduledExecutorService? = null

    private val http = OkHttpClient.Builder()
        .callTimeout(8, TimeUnit.SECONDS)
        .build()

    fun start() {
        if (scheduler != null) return
        val exec = Executors.newSingleThreadScheduledExecutor()
        scheduler = exec
        exec.scheduleWithFixedDelay(
            ::beat,
            0L,
            intervalSeconds,
            TimeUnit.SECONDS,
        )
    }

    fun stop() {
        scheduler?.shutdownNow()
        scheduler = null
    }

    private fun beat() {
        val url = "${config.sfuSignalingUrl}/camera/${config.cameraId}/heartbeat"
        // A tiny JSON body lets the agent log/observe the phone-side publish state; the agent
        // only needs the hit itself to mark the camera online, so contents are advisory.
        val body = """{"camera_id":"${config.cameraId}","publish_state":"${publisherStateProvider()}"}"""
            .toRequestBody(JSON)
        val request = Request.Builder().url(url).post(body).build()
        try {
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.w(TAG, "Heartbeat $url -> HTTP ${response.code}")
                }
            }
        } catch (e: IOException) {
            // Transient — the agent will let the camera lapse to offline if beats stop; we keep trying.
            Log.w(TAG, "Heartbeat failed: ${e.message}")
        }
    }

    companion object {
        private const val TAG = "HeartbeatScheduler"
        private val JSON = "application/json".toMediaType()
    }
}
