// Device Lab — Android Capture App (spec §3 component 1).
// The mounted capture phone: publishes ONE WebRTC video track to the lab agent's SFU
// over WHIP, heartbeats so the agent can mark the camera online, and can render a
// fullscreen QR overlay on command (a secondary calibration aid — the CANONICAL §5.1
// QR handshake renders on the TV itself, not here).

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    // FAIL_ON_PROJECT_REPOS keeps all repo declarations centralized here, so the
    // webrtc-sdk + zxing coordinates resolve from exactly these sources.
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "DeviceLabCapture"
include(":app")
