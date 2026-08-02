plugins {
    id("com.android.library") version "8.5.2"
    id("org.jetbrains.kotlin.android") version "1.9.24"
}

android {
    namespace = "io.yaver.feedback"
    compileSdk = 34

    defaultConfig {
        // The SDK is dropped into consumer apps; 21 keeps it usable in the
        // widest range of them and costs nothing here.
        minSdk = 21
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets {
        // The SDK predates this build file and uses the plain
        // src/main/kotlin layout rather than AGP's default. Point at what
        // exists instead of moving 6 files and rewriting their history.
        getByName("main") {
            java.srcDirs("src/main/kotlin")
            // No AndroidManifest.xml: AGP 7+ takes the namespace from the
            // `namespace` property above, and this library declares no
            // components or permissions of its own.
            manifest.srcFile("build/generated-manifest/AndroidManifest.xml")
        }
        getByName("test") {
            java.srcDirs("src/test/kotlin")
        }
    }

    testOptions {
        unitTests {
            // The SDK's pure seams (ReloadActions) use org.json. On the JVM
            // the android.jar stub throws "not mocked" for every method, which
            // would make a PASSING test impossible and a FAILING one
            // uninformative. The real org.json below shadows the stub, so the
            // test exercises the actual parsing.
            isReturnDefaultValues = true
        }
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    // Real org.json for unit tests — see the note above.
    testImplementation("org.json:json:20240303")
}

// AGP still wants a manifest file to exist even when the namespace comes from
// the DSL. Generating it keeps the source tree free of a file whose only
// content would be an empty <manifest/>.
val generateManifest = tasks.register("generateManifest") {
    val out = layout.buildDirectory.file("generated-manifest/AndroidManifest.xml")
    outputs.file(out)
    doLast {
        val f = out.get().asFile
        f.parentFile.mkdirs()
        f.writeText("<manifest />\n")
    }
}

tasks.configureEach {
    if (name.startsWith("process") && name.endsWith("Manifest")) {
        dependsOn(generateManifest)
    }
}
