# R8/ProGuard rules for the capture app.
#
# The WebRTC prebuilt uses JNI: native code calls back into these Java/Kotlin classes
# by name, so they must not be renamed or stripped. Keep the whole org.webrtc package.
-keep class org.webrtc.** { *; }
-keepclassmembers class org.webrtc.** { *; }
-dontwarn org.webrtc.**

# OkHttp / Okio ship their own consumer rules; this silences optional-dependency warnings.
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
