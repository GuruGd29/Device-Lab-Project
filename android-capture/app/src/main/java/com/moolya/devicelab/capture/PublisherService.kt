package com.moolya.devicelab.capture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import org.webrtc.EglBase

/**
 * Foreground service that hosts the WebRTC publisher + heartbeat (spec §3:
 * "Foreground service for the publisher so it survives backgrounding").
 *
 * A `camera`-typed foreground service (manifest `foregroundServiceType="camera"`) is what lets
 * the mounted phone keep its rear camera open and keep ingesting to the SFU after the Activity
 * is backgrounded or the screen is off — which is the normal state for a rack-mounted capture
 * phone.
 *
 * Lifecycle:
 *   START_PUBLISH  → go foreground, build EglBase, start [CameraPublisher] + [HeartbeatScheduler].
 *   STOP_PUBLISH   → stop both, release EglBase, leave the foreground, stopSelf().
 */
class PublisherService : Service() {

    private var eglBase: EglBase? = null
    private var publisher: CameraPublisher? = null
    private var heartbeat: HeartbeatScheduler? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopPublishing()
                stopForegroundCompat()
                stopSelf()
                return START_NOT_STICKY
            }
            else -> startPublishing()
        }
        // STICKY: if the OS kills us under memory pressure, restart and resume publishing —
        // the capture phone should self-heal without operator intervention.
        return START_STICKY
    }

    private fun startPublishing() {
        if (publisher != null) return // already running

        val config = CaptureConfig.load(this)
        if (!config.isComplete) {
            Log.w(TAG, "Config incomplete (sfu=${config.sfuSignalingUrl}, cam=${config.cameraId}); not starting")
            stopSelf()
            return
        }

        goForeground()

        val egl = EglBase.create()
        eglBase = egl

        val pub = CameraPublisher(applicationContext, config, egl)
        val hb = HeartbeatScheduler(config) {
            // Advisory publish state reported alongside the heartbeat.
            pub.lastState?.name ?: "STARTING"
        }
        publisher = pub
        heartbeat = hb

        pub.start()
        hb.start()
        Log.i(TAG, "Publishing started for camera=${config.cameraId} -> ${config.sfuSignalingUrl}")
    }

    private fun stopPublishing() {
        heartbeat?.stop()
        publisher?.stop()
        eglBase?.release()
        heartbeat = null
        publisher = null
        eglBase = null
    }

    override fun onDestroy() {
        stopPublishing()
        super.onDestroy()
    }

    // ── Foreground notification plumbing ───────────────────────────────────────
    private fun goForeground() {
        createChannel()
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.publisher_notification_title))
            .setContentText(getString(R.string.publisher_notification_text))
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setOngoing(true)
            .setContentIntent(openApp)
            .build()

        // On API 34+ the camera foreground-service type must be declared at startForeground time.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    private fun createChannel() {
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.publisher_channel_name),
            NotificationManager.IMPORTANCE_LOW, // silent, persistent
        )
        mgr.createNotificationChannel(channel)
    }

    companion object {
        private const val TAG = "PublisherService"
        private const val CHANNEL_ID = "capture_publisher"
        private const val NOTIFICATION_ID = 1001

        const val ACTION_START = "com.moolya.devicelab.capture.START_PUBLISH"
        const val ACTION_STOP = "com.moolya.devicelab.capture.STOP_PUBLISH"

        fun start(context: Context) {
            val intent = Intent(context, PublisherService::class.java).setAction(ACTION_START)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, PublisherService::class.java).setAction(ACTION_STOP)
            context.startService(intent)
        }
    }
}
