// Standalone Gradle build for the Yaver Feedback Kotlin SDK.
//
// This module existed as SOURCE ONLY — `src/` and a README, with no build file
// and no CI job anywhere. Nothing compiled it, so every "fix" landed here was
// unverified by construction, including its own unit test. Found 2026-08-02
// while adding the mode badge; this closes it.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "yaver-feedback-kotlin"
