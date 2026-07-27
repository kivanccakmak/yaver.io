using NUnit.Framework;

namespace Yaver.Feedback.Tests
{
    public sealed class YaverReloadActionsTests
    {
        private static YaverDevServerSnapshot Running(string framework)
        {
            return new YaverDevServerSnapshot { Running = true, Framework = framework };
        }

        // ─── THE GUARD ───────────────────────────────────────────────────────
        //
        // Prove it by breaking it: change `if (!isDevBuild) return actions;`
        // in YaverReloadActions.Build to `if (isDevBuild)` and this single
        // test fails while every other test in this file still passes.
        [Test]
        public void ReleaseBuildGetsNoReloadActionsAtAll()
        {
            var actions = YaverReloadActions.Build(Running("unity"), isDevBuild: false, connected: true);

            Assert.That(actions, Is.Empty);
        }

        [Test]
        public void DevBuildGetsHotAndFull()
        {
            var actions = YaverReloadActions.Build(Running("unity"), isDevBuild: true, connected: true);

            Assert.That(actions.Count, Is.EqualTo(2));
            Assert.That(actions[0].Id, Is.EqualTo(YaverReloadActionId.Hot));
            Assert.That(actions[1].Id, Is.EqualTo(YaverReloadActionId.Full));
            Assert.That(actions[0].Enabled, Is.True);
            Assert.That(actions[1].Enabled, Is.True);
        }

        [Test]
        public void FrameworkFamilyMapsTheAgentNames()
        {
            Assert.That(YaverReloadActions.FrameworkFamily("flutter"), Is.EqualTo(YaverReloadFrameworkFamily.Flutter));
            Assert.That(YaverReloadActions.FrameworkFamily("expo"), Is.EqualTo(YaverReloadFrameworkFamily.ReactNative));
            Assert.That(YaverReloadActions.FrameworkFamily("react-native"), Is.EqualTo(YaverReloadFrameworkFamily.ReactNative));
            Assert.That(YaverReloadActions.FrameworkFamily("vite"), Is.EqualTo(YaverReloadFrameworkFamily.Web));
            Assert.That(YaverReloadActions.FrameworkFamily("nextjs"), Is.EqualTo(YaverReloadFrameworkFamily.Web));
            Assert.That(YaverReloadActions.FrameworkFamily(""), Is.EqualTo(YaverReloadFrameworkFamily.Unknown));
            Assert.That(YaverReloadActions.FrameworkFamily("godot"), Is.EqualTo(YaverReloadFrameworkFamily.Unknown));
        }

        [Test]
        public void FlutterSecondActionIsAHotRestartNotAFullReload()
        {
            var actions = YaverReloadActions.Build(Running("flutter"), isDevBuild: true, connected: true);

            Assert.That(actions[0].Label, Is.EqualTo("Hot Reload"));
            Assert.That(actions[1].Label, Is.EqualTo("Hot Restart"));
            Assert.That(actions[1].Hint, Does.Contain("(R)"));
        }

        [Test]
        public void PayloadIsFastThenFullBothOnDevReload()
        {
            var actions = YaverReloadActions.Build(Running("unity"), isDevBuild: true, connected: true);

            Assert.That(actions[0].Path, Is.EqualTo("/dev/reload"));
            Assert.That(actions[0].BodyJson, Is.EqualTo("{\"mode\":\"fast\"}"));
            Assert.That(actions[1].Path, Is.EqualTo("/dev/reload"));
            Assert.That(actions[1].BodyJson, Is.EqualTo("{\"mode\":\"full\"}"));
        }

        [Test]
        public void NeverOffersTheHermesBundlePathAUnityPlayerCannotLoad()
        {
            var actions = YaverReloadActions.Build(Running("unity"), isDevBuild: true, connected: true);

            foreach (var action in actions)
            {
                Assert.That(action.Path, Is.Not.EqualTo(YaverReloadActions.ReloadAppPath));
            }
        }

        [Test]
        public void NoDevServerNamesTheMachineAndTheCommandThatStartsIt()
        {
            var actions = YaverReloadActions.Build(
                new YaverDevServerSnapshot { Running = false },
                isDevBuild: true,
                connected: true,
                machineLabel: "primary");

            foreach (var action in actions)
            {
                Assert.That(action.Enabled, Is.False);
                Assert.That(action.DisabledReason, Does.Contain("primary"));
                Assert.That(action.DisabledReason, Does.Contain("yaver dev start"));
            }
        }

        [Test]
        public void BuildingSaysStillBuildingNotNoDevServer()
        {
            var actions = YaverReloadActions.Build(
                new YaverDevServerSnapshot { Running = true, Building = true, Framework = "unity" },
                isDevBuild: true,
                connected: true);

            Assert.That(actions[0].DisabledReason, Does.Contain("still building"));
        }

        [Test]
        public void DisconnectedSaysNotConnectedNotNoDevServer()
        {
            var actions = YaverReloadActions.Build(Running("unity"), isDevBuild: true, connected: false);

            Assert.That(actions[0].DisabledReason, Does.Contain("Not connected"));
        }

        [Test]
        public void DescribeFailureNamesACauseNeverJustFailed()
        {
            Assert.That(
                YaverReloadActions.DescribeFailure(503, "dev server not available"),
                Does.Contain("No dev server is running"));

            Assert.That(
                YaverReloadActions.DescribeFailure(500, "vite does not support hot reload", Running("vite")),
                Does.Contain("vite"));

            Assert.That(
                YaverReloadActions.DescribeFailure(
                    502,
                    "Get \"http://127.0.0.1:8081/reload\": dial tcp 127.0.0.1:8081: connect: connection refused"),
                Does.Contain("not listening"));

            Assert.That(YaverReloadActions.DescribeFailure(401, ""), Does.Contain("sign in again"));
            Assert.That(YaverReloadActions.DescribeFailure(403, ""), Does.Contain("sign in again"));
            Assert.That(YaverReloadActions.DescribeFailure(404, "not found"), Does.Contain("yaver-cli@latest"));
            Assert.That(YaverReloadActions.DescribeFailure(500, "boom"), Does.Contain("yaver logs"));
            Assert.That(YaverReloadActions.DescribeFailure(0, ""), Does.Contain("yaver serve"));
        }
    }
}
