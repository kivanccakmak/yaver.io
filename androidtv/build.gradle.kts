// Top-level build file for the standalone Yaver Android TV app.
//
// Plugin versions are declared here with `apply false` and applied per-module
// (see app/build.gradle.kts). Pinned to the toolchain installed on the build
// machine: AGP 8.2.x pairs with the repo's Gradle 8.x, Kotlin 1.9.24 + Compose
// compiler 1.5.14 is the wear/ pairing proven in this repo. If Compose fails to
// compile, the usual culprit is the kotlinCompilerExtensionVersion ↔ Kotlin
// version pairing (https://developer.android.com/jetpack/compose-kotlin).

plugins {
    id("com.android.application") version "8.2.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
