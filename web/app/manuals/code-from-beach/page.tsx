import Link from "next/link";

export default function CodeFromBeachManual() {
  return (
    <div className="px-6 py-20">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/manuals"
          className="mb-8 inline-flex items-center gap-1 text-xs text-surface-500 hover:text-surface-50"
        >
          &larr; Back to Manuals
        </Link>

        <h1 className="mb-4 text-3xl font-bold text-surface-50 md:text-4xl">
          Code from the Beach &mdash; Remote Build, Test &amp; Deploy
        </h1>
        <p className="mb-12 text-sm leading-relaxed text-surface-400">
          Develop from your phone, build on your machine, test automatically,
          and deploy to your phone, TestFlight, or Play Store &mdash; all over
          encrypted P2P connections. No CI queue. No waiting. Your build goes
          straight to your device.
        </p>

        {/* Overview */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            Overview
          </h2>
          <p className="mb-4 text-sm text-surface-400">
            Yaver turns your phone into a remote control for your entire
            development workflow. Chat with an AI agent that writes code on your
            home machine, then build, test, and deploy &mdash; all from the
            beach, a cafe, or wherever you happen to be. Artifacts transfer P2P
            directly to your phone. No cloud CI needed.
          </p>
          <ul className="space-y-2 text-sm text-surface-400">
            <li className="flex gap-3">
              <span className="text-surface-500">&#8226;</span>
              <span>
                <strong className="text-surface-300">Build</strong> &mdash;
                Flutter, native Android (Gradle), native iOS (Xcode), React
                Native, or any custom build command
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-surface-500">&#8226;</span>
              <span>
                <strong className="text-surface-300">Test</strong> &mdash;
                auto-detect and run unit tests, platform tests, and E2E tests
                with pass/fail results and screenshots
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-surface-500">&#8226;</span>
              <span>
                <strong className="text-surface-300">Deploy</strong> &mdash;
                P2P to your phone (tap to install), TestFlight, Play Store, or
                trigger CI/CD pipelines
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-surface-500">&#8226;</span>
              <span>
                <strong className="text-surface-300">Hot reload</strong> &mdash;
                remote Flutter hot reload over P2P tunnels
              </span>
            </li>
          </ul>
        </section>

        {/* Prerequisites */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            Prerequisites
          </h2>
          <ul className="space-y-2 text-sm text-surface-400">
            <li className="flex gap-3">
              <span className="text-surface-500">&#8226;</span>
              <span>
                <strong className="text-surface-300">Yaver CLI</strong> &mdash;
                installed and signed in on your dev machine ({" "}
                <Link
                  href="/manuals/cli-setup"
                  className="text-surface-300 underline underline-offset-2 hover:text-surface-100"
                >
                  CLI setup guide
                </Link>
                )
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-surface-500">&#8226;</span>
              <span>
                <strong className="text-surface-300">Yaver mobile app</strong>{" "}
                &mdash; installed on your phone (
                <Link
                  href="/download"
                  className="text-surface-300 underline underline-offset-2 hover:text-surface-100"
                >
                  download
                </Link>
                )
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-surface-500">&#8226;</span>
              <span>
                <strong className="text-surface-300">Signing keys</strong>{" "}
                &mdash; Android JKS keystore and/or Apple certificates set up on
                your dev machine
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-surface-500">&#8226;</span>
              <span>
                <strong className="text-surface-300">Build tools</strong> &mdash;
                Flutter SDK, Xcode, Gradle, or whatever your project needs
              </span>
            </li>
          </ul>
        </section>

        {/* Quick Start */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            Quick start
          </h2>
          <p className="mb-4 text-sm text-surface-400">
            Four commands from zero to an APK on your phone.
          </p>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body space-y-3 text-[13px]">
              <div className="text-surface-500">
                # Sign in and start the agent
              </div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">
                  yaver auth &amp;&amp; yaver serve
                </span>
              </div>
              <div className="h-px bg-surface-800/60" />
              <div className="text-surface-500">
                # Switch to your project
              </div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">
                  yaver repo switch my-app
                </span>
              </div>
              <div className="h-px bg-surface-800/60" />
              <div className="text-surface-500"># Build a debug APK</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">
                  yaver build flutter apk
                </span>
              </div>
              <div className="h-px bg-surface-800/60" />
              <div className="text-surface-500">
                # Artifact transfers P2P to your phone &mdash; tap to install
              </div>
              <div className="pl-2 text-green-400/80">
                Build complete. APK sent to iPhone (P2P).
              </div>
            </div>
          </div>
          <p className="text-xs text-surface-500">
            All of this works from your phone too &mdash; just type the commands
            in the Yaver mobile app or ask your AI agent to do it.
          </p>
        </section>

        {/* Repo Management */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            Repo management
          </h2>
          <p className="mb-4 text-sm text-surface-400">
            Yaver discovers projects on your machine automatically. Switch
            between them to set the build/test context.
          </p>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body space-y-3 text-[13px]">
              <div className="text-surface-500"># List all discovered projects</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver repo list</span>
              </div>
              <div className="pl-2 text-surface-400">
                {`  1. my-flutter-app     ~/projects/my-flutter-app\n  2. backend-api        ~/projects/backend-api\n  3. landing-page       ~/projects/landing-page`}
              </div>
              <div className="h-px bg-surface-800/60" />
              <div className="text-surface-500"># Switch to a project</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">
                  yaver repo switch my-flutter-app
                </span>
              </div>
              <div className="pl-2 text-green-400/80">
                Switched to my-flutter-app (~/projects/my-flutter-app)
              </div>
              <div className="h-px bg-surface-800/60" />
              <div className="text-surface-500"># See current project</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver repo current</span>
              </div>
              <div className="pl-2 text-surface-400">
                my-flutter-app &mdash; ~/projects/my-flutter-app
              </div>
            </div>
          </div>
        </section>

        {/* Building */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            Building
          </h2>
          <p className="mb-4 text-sm text-surface-400">
            Build apps for any platform. Yaver detects your project type and
            runs the right build commands on your dev machine.
          </p>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            Flutter
          </h3>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body space-y-2 text-[13px]">
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver build flutter apk</span>
                <span className="ml-2 text-surface-500"># Debug APK</span>
              </div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver build flutter aab</span>
                <span className="ml-2 text-surface-500"># Play Store bundle</span>
              </div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver build flutter ipa</span>
                <span className="ml-2 text-surface-500"># iOS archive</span>
              </div>
            </div>
          </div>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            Native Android (Gradle)
          </h3>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body space-y-2 text-[13px]">
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver build gradle apk</span>
                <span className="ml-2 text-surface-500"># Debug APK</span>
              </div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver build gradle aab</span>
                <span className="ml-2 text-surface-500"># Release bundle</span>
              </div>
            </div>
          </div>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            Native iOS (Xcode)
          </h3>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body text-[13px]">
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver build xcode ipa</span>
                <span className="ml-2 text-surface-500">
                  # Archive &amp; export IPA
                </span>
              </div>
            </div>
          </div>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            React Native
          </h3>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body space-y-2 text-[13px]">
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">
                  yaver build rn android
                </span>
                <span className="ml-2 text-surface-500"># Android APK</span>
              </div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver build rn ios</span>
                <span className="ml-2 text-surface-500"># iOS IPA</span>
              </div>
            </div>
          </div>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            Expo (managed workflow)
          </h3>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body space-y-2 text-[13px]">
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver build expo-android</span>
                <span className="ml-2 text-surface-500"># Android APK/AAB via Expo</span>
              </div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver build expo-ios</span>
                <span className="ml-2 text-surface-500"># iOS IPA via Expo</span>
              </div>
            </div>
          </div>
          <p className="mb-6 text-xs text-surface-500">
            For Expo-managed projects, Yaver runs{" "}
            <code className="rounded bg-surface-900 px-1.5 py-0.5 text-surface-400">
              eas build
            </code>{" "}
            or{" "}
            <code className="rounded bg-surface-900 px-1.5 py-0.5 text-surface-400">
              expo prebuild
            </code>{" "}
            + native build depending on your project configuration.
          </p>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            Platform-aware builds
          </h3>
          <p className="mb-6 text-sm text-surface-400">
            When you request a build from your phone, Yaver knows whether
            you&apos;re on iOS or Android and builds the right artifact
            automatically. Say &quot;build this app&quot; from your Android phone
            and Yaver builds an APK. Say it from your iPhone and it builds an
            IPA. You can also specify the target explicitly with{" "}
            <code className="rounded bg-surface-900 px-1.5 py-0.5 text-surface-400">
              yaver build flutter apk
            </code>{" "}
            or{" "}
            <code className="rounded bg-surface-900 px-1.5 py-0.5 text-surface-400">
              yaver build flutter ipa
            </code>
            .
          </p>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            Custom build commands
          </h3>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body text-[13px]">
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">
                  {`yaver build custom "make build"`}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Testing */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            Testing
          </h2>
          <p className="mb-4 text-sm text-surface-400">
            Run tests remotely and get results with pass/fail counts and
            screenshots delivered to your phone.
          </p>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body space-y-3 text-[13px]">
              <div className="text-surface-500">
                # Auto-detect framework and run unit tests
              </div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver test unit</span>
              </div>
              <div className="pl-2 text-green-400/80">
                42 passed, 0 failed (3.2s)
              </div>
              <div className="h-px bg-surface-800/60" />
              <div className="text-surface-500"># Platform-specific tests</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver test flutter</span>
                <span className="ml-2 text-surface-500">
                  # flutter test
                </span>
              </div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver test android</span>
                <span className="ml-2 text-surface-500">
                  # ./gradlew test
                </span>
              </div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver test ios</span>
                <span className="ml-2 text-surface-500">
                  # xcodebuild test
                </span>
              </div>
              <div className="h-px bg-surface-800/60" />
              <div className="text-surface-500">
                # E2E tests (Playwright, Cypress, Maestro)
              </div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver test e2e</span>
              </div>
              <div className="pl-2 text-surface-400">
                12 passed, 1 failed (28.4s) &mdash; 3 screenshots attached
              </div>
            </div>
          </div>
          <p className="text-xs text-surface-500">
            Test results include pass/fail counts. E2E tests can attach
            screenshots that transfer to your phone automatically.
          </p>
        </section>

        {/* Deploying */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            Deploying
          </h2>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            P2P to phone (free, instant)
          </h3>
          <p className="mb-3 text-sm text-surface-400">
            Build artifacts transfer directly to your phone over Yaver&apos;s
            encrypted P2P connection. Tap the notification to install. No
            TestFlight queue, no Play Store review.
          </p>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body space-y-2 text-[13px]">
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver build flutter apk</span>
              </div>
              <div className="pl-2 text-green-400/80">
                Build complete. APK sent to iPhone (P2P). Tap to install.
              </div>
            </div>
          </div>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            TestFlight
          </h3>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body text-[13px]">
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">
                  yaver build push testflight &lt;build-id&gt;
                </span>
              </div>
            </div>
          </div>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            Play Store
          </h3>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body text-[13px]">
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">
                  yaver build push playstore &lt;build-id&gt;
                </span>
              </div>
            </div>
          </div>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            CI/CD triggers
          </h3>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body space-y-2 text-[13px]">
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">
                  yaver deploy --ci github --workflow build.yml
                </span>
              </div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">
                  yaver deploy --ci gitlab --repo &lt;id&gt;
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Full Pipeline */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            Full pipeline
          </h2>
          <p className="mb-4 text-sm text-surface-400">
            Run the entire build &rarr; test &rarr; deploy cycle in one command.
          </p>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body space-y-3 text-[13px]">
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">
                  yaver pipeline --test --deploy p2p
                </span>
              </div>
              <div className="pl-2 text-surface-400">
                Building... flutter build apk
              </div>
              <div className="pl-2 text-surface-400">
                Testing... 42 passed, 0 failed
              </div>
              <div className="pl-2 text-green-400/80">
                Deployed. APK sent to iPhone (P2P).
              </div>
            </div>
          </div>
          <p className="text-xs text-surface-500">
            The pipeline stops on test failure by default. Add{" "}
            <code className="rounded bg-surface-900 px-1.5 py-0.5 text-surface-400">
              --force
            </code>{" "}
            to deploy even if tests fail.
          </p>
        </section>

        {/* Hot Reload */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            Hot reload
          </h2>
          <p className="mb-4 text-sm text-surface-400">
            For Flutter projects, run a remote hot reload session over P2P
            tunnels. Edit code on your dev machine (or via AI agent) and see
            changes instantly on your phone.
          </p>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body space-y-2 text-[13px]">
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver debug flutter</span>
              </div>
              <div className="pl-2 text-surface-400">
                Hot reload session started. Watching for changes...
              </div>
              <div className="pl-2 text-green-400/80">
                Hot reload (324ms)
              </div>
            </div>
          </div>
        </section>

        {/* Key Vault */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            Key vault
          </h2>
          <p className="mb-4 text-sm text-surface-400">
            Store signing keys, API tokens, and other secrets securely. Keys are
            encrypted locally and sync automatically over P2P when your phone
            connects to the agent &mdash; no manual key management needed on each
            connect. Keys are encrypted at rest (NaCl secretbox + Argon2id) and
            never leave your devices unencrypted.
          </p>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body space-y-3 text-[13px]">
              <div className="text-surface-500"># Add a signing key</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">
                  yaver vault add android-keystore --file ~/keys/release.jks
                </span>
              </div>
              <div className="h-px bg-surface-800/60" />
              <div className="text-surface-500"># Add an API token</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">
                  yaver vault add play-store-key --file ~/keys/service-account.json
                </span>
              </div>
              <div className="h-px bg-surface-800/60" />
              <div className="text-surface-500"># List stored secrets</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver vault list</span>
              </div>
              <div className="pl-2 text-surface-400">
                {`  android-keystore     ~/keys/release.jks\n  play-store-key       ~/keys/service-account.json`}
              </div>
            </div>
          </div>
        </section>

        <div className="rounded-lg border border-surface-800 bg-surface-900/50 p-6">
          <h3 className="mb-2 text-sm font-semibold text-surface-200">
            Need more?
          </h3>
          <p className="text-sm text-surface-400">
            Check the{" "}
            <Link
              href="/manuals/cli-setup"
              className="text-surface-300 underline underline-offset-2 hover:text-surface-100"
            >
              CLI setup guide
            </Link>{" "}
            for installation and auth, or the{" "}
            <Link
              href="/manuals/relay-setup"
              className="text-surface-300 underline underline-offset-2 hover:text-surface-100"
            >
              relay setup guide
            </Link>{" "}
            if you need to reach your machine from outside your home network.
          </p>
        </div>

        <div className="mt-12 flex items-center justify-between">
          <Link
            href="/manuals"
            className="text-xs text-surface-500 hover:text-surface-50"
          >
            &larr; All manuals
          </Link>
          <Link
            href="/manuals/cli-setup"
            className="text-xs text-surface-500 hover:text-surface-50"
          >
            CLI setup guide &rarr;
          </Link>
        </div>
      </div>
    </div>
  );
}
