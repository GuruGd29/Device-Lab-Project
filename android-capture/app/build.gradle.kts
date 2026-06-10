plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.moolya.devicelab.capture"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.moolya.devicelab.capture"
        minSdk = 26          // spec: min SDK 26 (foreground services + Camera2 are mature here)
        targetSdk = 34       // spec: target/compile SDK 34
        versionCode = 1
        versionName = "1.0.0"

        // ── Build-time configuration (spec §3: "config screen OR BuildConfig fields") ──
        // These are the DEFAULTS baked into the APK; the in-app Config screen can override
        // them at runtime and persist to SharedPreferences. Override per build with e.g.
        //   ./gradlew assembleDebug -PsfuSignalingUrl=http://10.0.0.5:8089 -PcameraId=cam-rack-A-03
        val sfuSignalingUrl = (project.findProperty("sfuSignalingUrl") as String?)
            ?: "http://192.168.1.50:8089"
        val cameraId = (project.findProperty("cameraId") as String?)
            ?: "cam-unconfigured"

        buildConfigField("String", "DEFAULT_SFU_SIGNALING_URL", "\"$sfuSignalingUrl\"")
        buildConfigField("String", "DEFAULT_CAMERA_ID", "\"$cameraId\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true   // required for the buildConfigField entries above
    }
    composeOptions {
        // Compose compiler extension matching Kotlin 1.9.24 — see
        // https://developer.android.com/jetpack/androidx/releases/compose-kotlin
        kotlinCompilerExtensionVersion = "1.5.14"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    // ── WebRTC (spec §3): maintained, package-compatible (org.webrtc.*) prebuilt. ──
    // io.github.webrtc-sdk/android is the actively-maintained fork of Google's libwebrtc
    // Android build. Version pinned to a confirmed Maven Central release (Chromium M125).
    implementation("io.github.webrtc-sdk:android:125.6422.07")

    // ── QR rendering (spec §3 fullscreen QR overlay aid) ──
    implementation("com.google.zxing:core:3.5.3")

    // ── Networking: OkHttp for the WHIP signaling POST/PATCH + heartbeat POST ──
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // ── AndroidX + lifecycle ──
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")

    // ── Jetpack Compose (BOM keeps the artifacts mutually consistent) ──
    implementation(platform("androidx.compose:compose-bom:2024.06.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.compose.ui:ui-tooling-preview")
}
