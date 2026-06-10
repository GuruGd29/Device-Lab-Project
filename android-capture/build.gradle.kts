// Root build script. Plugins are declared with `apply false` here and applied in :app.
// Versions are pinned so an engineer opening this in Android Studio gets a reproducible
// build without an editable surprise from "latest".
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
    // Compose compiler plugin is bundled with the Kotlin Gradle plugin for Kotlin 1.9.x
    // (we set composeOptions.kotlinCompilerExtensionVersion in :app instead of a separate
    //  plugin, which is the Kotlin 2.0 mechanism — see app/build.gradle.kts).
}
