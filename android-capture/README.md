# Android Capture App — Device Lab Phase 1

The phone mounted at each TV. It does exactly the three jobs the orchestration spec assigns
to component 1 (`docs/03-PHASE1-ORCHESTRATION-SPEC.md` §3):

1. **Publish one WebRTC video stream** — the REAR camera at **720p@30**, sent to the lab
   agent's local SFU via **WHIP** (`POST {SFU_SIGNALING_URL}/whip/{camera_id}`), answer
   applied, ICE trickled. Auto-reconnects and keeps the screen on while publishing.
2. **Heartbeat** — every 10 s `POST {SFU_SIGNALING_URL}/camera/{camera_id}/heartbeat` so the
   lab agent can mark this camera `online` and fold that into the `agent.heartbeat` it sends
   the cloud (`packages/contracts/src/agent-protocol.ts`).
3. **Fullscreen QR overlay** — renders a high-contrast QR (default: the `camera_id`) on command.

> **Media stays local.** Per the spec's critical placement rule (§3, README architecture
> diagram), the phone publishes to the **lab agent's SFU on the local LAN**, never to the
> cloud. `SFU_SIGNALING_URL` must be the agent's local address (e.g. `http://192.168.1.50:8089`),
> reachable from the phone on the lab VLAN — the same value the agent advertises to the cloud as
> `host.sfu_signaling_url` in its `agent.hello` frame. The cloud control plane is **not** in the
> media path; this app never talks to it directly.

> **Calibration note (§5.1).** The CANONICAL QR-handshake calibration renders the TV's `tv_id`
> as a QR **on the TV's own screen** (pushed via the TV control channel) and the lab agent scans
> the camera feeds. The fullscreen QR here is a **secondary aid / camera self-identification**
> (which physical phone is `cam-rack-A-03`?), not the primary calibration mechanism.

---

## Library coordinates (pinned)

| Purpose | Coordinate | Version | Notes |
|---|---|---|---|
| WebRTC (org.webrtc.*) | `io.github.webrtc-sdk:android` | **125.6422.07** | Maintained prebuilt of Google's libwebrtc Android build (Chromium M125). Confirmed on Maven Central; bundles the `org.webrtc.*` Java API + native `.so`s. |
| QR encoding | `com.google.zxing:core` | **3.5.3** | Pure-Java QR encoder; `QRCodeWriter` → `BitMatrix` → Android `Bitmap`. |
| HTTP (WHIP + heartbeat) | `com.squareup.okhttp3:okhttp` | **4.12.0** | SDP `POST`/`PATCH`/`DELETE` and the heartbeat `POST`. |
| UI | Jetpack Compose via `androidx.compose:compose-bom` | **2024.06.00** | Material3. |
| Build | Android Gradle Plugin | **8.5.2** | with Gradle **8.7**. |
| Build | Kotlin | **1.9.24** | Compose compiler extension **1.5.14** (the matching pair). |

`compileSdk` / `targetSdk` = **34**, `minSdk` = **26** (spec).

All `org.webrtc.*` and `com.google.zxing.*` symbols referenced in the Kotlin sources were
verified against the actual 125.6422.07 / 3.5.3 artifacts (class + method signatures).

---

## Project layout

```
android-capture/
├── settings.gradle.kts            repos + module include
├── build.gradle.kts               root: AGP + Kotlin plugins (apply false)
├── gradle.properties              AndroidX, JVM args
├── gradlew / gradlew.bat          wrapper scripts (JAR generated separately — see below)
├── gradle/wrapper/gradle-wrapper.properties   pins Gradle 8.7
└── app/
    ├── build.gradle.kts           deps + BuildConfig fields (SFU url / camera id)
    ├── proguard-rules.pro         keep org.webrtc.** (JNI)
    └── src/main/
        ├── AndroidManifest.xml    CAMERA + INTERNET + FOREGROUND_SERVICE(+CAMERA) perms,
        │                          activities + the camera-typed foreground service
        ├── java/com/moolya/devicelab/capture/
        │   ├── CaptureApplication.kt   thin Application
        │   ├── CaptureConfig.kt        SFU_SIGNALING_URL + camera_id (prefs + BuildConfig)
        │   ├── MainActivity.kt         Compose config screen, permissions, start/stop, QR button
        │   ├── PublisherService.kt     foreground service hosting publisher + heartbeat
        │   ├── CameraPublisher.kt      WebRTC: rear Camera2 → 720p30 track → PeerConnection → WHIP
        │   ├── WhipClient.kt           WHIP POST offer / PATCH trickle / DELETE teardown
        │   ├── HeartbeatScheduler.kt   10 s POST /camera/{id}/heartbeat
        │   ├── QrEncoder.kt            zxing payload → high-contrast Bitmap
        │   ├── QrOverlayActivity.kt    fullscreen QR overlay (calibration aid)
        │   └── UiUtils.kt              keep-screen-on + immersive helpers
        └── res/                       strings, themes (incl. fullscreen), colors, adaptive icon
```

---

## Prerequisites

- **Android Studio** (Koala 2024.1.1 or newer — ships AGP 8.5 support).
- **JDK 17** (AGP 8.5 requires it; Android Studio bundles a suitable JBR).
- **Android SDK Platform 34** + Build-Tools 34.x (install via the SDK Manager).
- A physical Android device, **API 26+**, with a rear camera. *The emulator's fake camera will
  publish but is useless for pointing at a TV.* USB debugging enabled.
- The device and the **lab agent must be on the same LAN/VLAN** so the phone can reach the SFU.

> This project **cannot be compiled in this environment** (no Android SDK here). The steps below
> are what an engineer runs in Android Studio / on a machine with the SDK installed.

---

## Generate the Gradle wrapper JAR

The binary `gradle-wrapper.jar` is intentionally not committed. Generate it once (the
`gradle-wrapper.properties` already pins the version):

```bash
cd android-capture
gradle wrapper --gradle-version 8.7      # needs a system Gradle once; or let Android Studio repair it
```

Android Studio will also offer to download/repair the wrapper automatically on first sync, so
opening the project in the IDE is enough even without a system Gradle.

---

## Build & run (Android Studio)

1. **Open** `android-capture/` as a project (File → Open → select the folder).
2. Let Gradle sync. Accept any SDK 34 / Build-Tools install prompts.
3. Plug in the device, select it in the toolbar.
4. **Run** the `app` configuration (▶). The app installs and launches to the config screen.
5. On the config screen, set:
   - **SFU_SIGNALING_URL** — the lab agent's local base URL, e.g. `http://192.168.1.50:8089`.
   - **camera_id** — must equal the registry `Camera.camera_id` for this slot, e.g.
     `cam-rack-A-03`.
6. Tap **Start publishing** → grant **Camera** (and Notifications on Android 13+). The foreground
   service starts, the rear camera opens, and the publisher WHIP-POSTs to the SFU.

### Command-line build (with the wrapper generated)

```bash
cd android-capture
./gradlew assembleDebug                     # → app/build/outputs/apk/debug/app-debug.apk
./gradlew installDebug                       # build + install to the connected device

# Bake defaults into the APK at build time instead of typing them on the device:
./gradlew assembleDebug \
  -PsfuSignalingUrl=http://192.168.1.50:8089 \
  -PcameraId=cam-rack-A-03
```

The default URL is plain `http://` on the LAN. Android blocks cleartext on API 28+ by default,
so the manifest sets `android:usesCleartextTraffic="true"` (this is an internal lab appliance on
a trusted VLAN — see the "HTTP cleartext" caveat below). If your agent serves HTTPS, drop that
flag and add a network-security-config trust anchor instead.

---

## Pointing it at a running lab agent

1. Put the **lab agent on the TV subnet** and start its SFU + WHIP endpoint. The agent reports
   its `host.sfu_signaling_url` to the cloud; that base URL is what you enter here.
2. WHIP ingest endpoint the agent must expose: `POST {base}/whip/{camera_id}`
   (`Content-Type: application/sdp` → `201 Created`, body = SDP answer, `Location:` = the session
   resource; trickle via `PATCH {resource}`, teardown via `DELETE {resource}`).
3. Heartbeat endpoint: `POST {base}/camera/{camera_id}/heartbeat` (body is advisory JSON; the
   agent only needs the hit to mark the camera online and set `sfu_publish_track`).
4. Enter that base URL + the matching `camera_id` in the app, Start publishing. The agent should
   see the ingest, expose the track, and start reporting the camera `online` to the cloud — after
   which the dashboard can calibrate/bind it to a TV.

---

## How to verify (without an SDK here)

This component can't be compiled in this repo (no Android toolchain). It was self-reviewed as
follows; reproduce on an SDK machine:

- **Every WebRTC + zxing symbol exists.** All `org.webrtc.*` classes and the exact method
  signatures used (`Camera2Enumerator.isBackFacing` / `createCapturer`, `PeerConnectionFactory`
  init + `createVideoSource(boolean)` + `createVideoTrack`, `addTransceiver(track, init)` with
  `RtpTransceiverInit(SEND_ONLY, listOf(streamId))`, `RtpSender.parameters` bitrate cap,
  `SurfaceTextureHelper.create`, the `PeerConnection.Observer` overrides, `EglBase.create`) were
  checked against `io.github.webrtc-sdk:android:125.6422.07`'s `classes.jar`. The zxing
  `QRCodeWriter.encode(String, BarcodeFormat, int, int, Map)` + `BitMatrix` + `ErrorCorrectionLevel.H`
  were checked against `com.google.zxing:core:3.5.3`.
- **Manifest declares everything used:** `CAMERA`, `INTERNET`, `ACCESS_NETWORK_STATE`,
  `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_CAMERA`, `POST_NOTIFICATIONS`; `MainActivity`,
  `QrOverlayActivity`, and the `camera`-typed `PublisherService`.
- **Gradle is internally consistent:** AGP 8.5.2 ↔ Gradle 8.7 ↔ Kotlin 1.9.24 ↔ Compose compiler
  1.5.14 ↔ compose-bom 2024.06.00 is a known-good matrix; every declared dependency is referenced
  in code.

On the SDK machine, the real verification is: `./gradlew assembleDebug` compiles, install on a
phone, point at the agent, and confirm (a) the agent logs the WHIP ingest + reports the camera
online, (b) the dashboard can stream it, (c) the QR overlay renders fullscreen.

---

## Caveats / assumptions

- **HTTP cleartext.** Lab agents commonly expose plain `http://` on the LAN, and the agent's IP
  varies per deployment. Android's network-security-config matches by hostname, not CIDR, so it
  can't cleanly whitelist "the 192.168.x.x range". The manifest therefore sets
  `android:usesCleartextTraffic="true"` — acceptable because this is an internal lab appliance on
  a trusted VLAN, not a public-internet app. For a hardened build, remove that flag and add a
  `res/xml/network_security_config.xml` with a `<domain>` for the agent's literal IP (or a
  `<trust-anchors>` block if it serves HTTPS with a self-signed cert), then reference it via
  `android:networkSecurityConfig` on `<application>`.
- **`gradle-wrapper.jar` not committed** — generate with `gradle wrapper` (above) or let Android
  Studio fetch it.
- **WHIP answer shape** assumes the agent returns the SDP answer in the POST body (201) and a
  `Location` header for trickle/teardown — the standard WHIP contract. If the agent only accepts
  candidates inside the initial offer (no trickle endpoint), the `PATCH` calls no-op gracefully;
  host candidates in the offer are usually sufficient on a flat LAN.
- **One camera : one TV** (spec §2). This app publishes a single rear-camera track under the
  configured `camera_id`; multi-camera-per-phone is out of Phase 1 scope.
- **Bitrate/resolution** are 720p@30 / ~2.5 Mbps max. Tune `CAPTURE_*` / `MAX_BITRATE_BPS` in
  `CameraPublisher.kt` if the lab link or the camera module differs.
- **Camera is the biggest latency offender** (spec §14, ~100 ms). The publisher uses the default
  encoder factory with HW acceleration enabled; if glass-to-glass exceeds the target, profile the
  capture/encode path here first.
- **Foreground-service type on Android 14** must be `camera`; the manifest and
  `startForeground(..., FOREGROUND_SERVICE_TYPE_CAMERA)` both declare it. The runtime
  `FOREGROUND_SERVICE_CAMERA` permission is normal (granted at install).
```
