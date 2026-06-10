package com.moolya.devicelab.capture

import android.app.Application

/**
 * Application entry point. Kept deliberately thin: libwebrtc's
 * PeerConnectionFactory.initialize() is called lazily inside [CameraPublisher] on its own
 * worker thread (it must run before any factory is built, but not necessarily at process
 * start), so there is nothing heavyweight to do here.
 */
class CaptureApplication : Application()
