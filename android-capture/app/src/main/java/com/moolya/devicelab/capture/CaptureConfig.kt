package com.moolya.devicelab.capture

import android.content.Context
import androidx.core.content.edit

/**
 * Runtime configuration for the capture phone (spec §3: "Simple config screen ...
 * SFU_SIGNALING_URL and camera_id").
 *
 * Defaults are baked in at build time via [BuildConfig] (`-PsfuSignalingUrl=... -PcameraId=...`),
 * and the in-app Config screen can override them and persist to SharedPreferences so a single
 * generic APK can be re-pointed per mounted phone without a rebuild.
 *
 * Identifiers tie directly to the contracts:
 *   - [cameraId] is `Camera.camera_id` (packages/contracts/src/domain.ts). It is the WHIP
 *     resource path segment AND the heartbeat path segment the lab agent's SFU keys on.
 *   - [sfuSignalingUrl] is the lab agent's local SFU base URL — the agent advertises this same
 *     value to the cloud as `host.sfu_signaling_url` in its `agent.hello` frame
 *     (packages/contracts/src/agent-protocol.ts). Media stays on the LOCAL link; this URL must
 *     be reachable from the phone on the lab LAN, NOT the cloud (spec §3 placement rule).
 */
data class CaptureConfig(
    val sfuSignalingUrl: String,
    val cameraId: String,
) {
    /** True once both fields look usable enough to attempt publishing. */
    val isComplete: Boolean
        get() = sfuSignalingUrl.isNotBlank() &&
            (sfuSignalingUrl.startsWith("http://") || sfuSignalingUrl.startsWith("https://")) &&
            cameraId.isNotBlank() &&
            cameraId != "cam-unconfigured"

    companion object {
        private const val PREFS = "device_lab_capture"
        private const val KEY_SFU = "sfu_signaling_url"
        private const val KEY_CAMERA = "camera_id"

        fun load(context: Context): CaptureConfig {
            val sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return CaptureConfig(
                sfuSignalingUrl = sp.getString(KEY_SFU, BuildConfig.DEFAULT_SFU_SIGNALING_URL)
                    ?: BuildConfig.DEFAULT_SFU_SIGNALING_URL,
                cameraId = sp.getString(KEY_CAMERA, BuildConfig.DEFAULT_CAMERA_ID)
                    ?: BuildConfig.DEFAULT_CAMERA_ID,
            )
        }

        fun save(context: Context, config: CaptureConfig) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit {
                // Trim a trailing slash so we can join paths uniformly downstream.
                putString(KEY_SFU, config.sfuSignalingUrl.trim().trimEnd('/'))
                putString(KEY_CAMERA, config.cameraId.trim())
            }
        }
    }
}
