package com.moolya.devicelab.capture

import android.view.View
import android.view.Window
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Keep the device screen on and go immersive (spec §3: "Keep the device screen on / immersive
 * while publishing (mounted capture phone)"). A rack-mounted phone should never sleep or show
 * system bars; this is shared by [MainActivity] (while the publisher runs) and the QR overlay.
 */
fun keepScreenOnAndImmersive(window: Window) {
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    val controller = WindowInsetsControllerCompat(window, window.decorView)
    controller.hide(WindowInsetsCompat.Type.systemBars())
    controller.systemBarsBehavior =
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
}

/** Release the keep-screen-on flag (e.g. when publishing stops). */
fun clearKeepScreenOn(window: Window) {
    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    @Suppress("DEPRECATION")
    window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
}
