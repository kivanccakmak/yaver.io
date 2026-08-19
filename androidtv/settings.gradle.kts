// Settings for the standalone Yaver Android TV app.
//
// This is a SELF-CONTAINED Gradle build that lives OUTSIDE mobile/android on
// purpose: Android TV is plain Jetpack Compose (no React Native), and an
// `:androidtv` module inside mobile/android would be clobbered on every
// `expo prebuild --clean`. Keeping it standalone — like tvos/ for Apple TV and
// wear/ for Wear OS — avoids that fight. See androidtv/README.md.
//
// Mirror of wear/settings.gradle.kts; the Android TV app is the tvOS
// (tvos/YaverTV) native-app counterpart, ported to Kotlin/Compose.

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "yaver-androidtv"
include(":app")
