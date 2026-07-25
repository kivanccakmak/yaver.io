package testkit

// An AVD whose system image was never downloaded made the emulator PANIC
// instantly ("Cannot find AVD system path") — and because that goes to the
// emulator's own stderr, the caller sat in the adb wait and reported
//
//   no adb device online after 2m0s
//
// Two minutes to say nothing useful, blaming the wrong component: adb was fine,
// the image was absent. Measured on a Mac mini whose Pixel_4_API_32 referenced
// system-images/android-32/google_apis_playstore/arm64-v8a with system-images/
// completely empty.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeAVD(t *testing.T, home, name, sysdir string) {
	t.Helper()
	dir := filepath.Join(home, ".android", "avd", name+".avd")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir avd: %v", err)
	}
	body := "abi.type = arm64-v8a\nimage.sysdir.1 = " + sysdir + "\n"
	if err := os.WriteFile(filepath.Join(dir, "config.ini"), []byte(body), 0o644); err != nil {
		t.Fatalf("write config.ini: %v", err)
	}
}

func TestMissingSystemImageIsNamedNotTimedOut(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	sdk := filepath.Join(home, "sdk")
	t.Setenv("ANDROID_SDK_ROOT", sdk)
	t.Setenv("ANDROID_HOME", sdk)

	const sysdir = "system-images/android-32/google_apis_playstore/arm64-v8a/"
	writeAVD(t, home, "Pixel_4_API_32", sysdir)

	missing, remedy := avdSystemImageMissing("Pixel_4_API_32")
	if !missing {
		t.Fatal("an AVD with no installed system image was reported as fine — the caller then " +
			"waits two minutes and blames adb")
	}
	// The remedy must be runnable, not advisory.
	for _, want := range []string{
		"sdkmanager",
		"system-images;android-32;google_apis_playstore;arm64-v8a",
	} {
		if !strings.Contains(remedy, want) {
			t.Errorf("remedy does not contain %q — a vague remedy costs whole sessions:\n%s", want, remedy)
		}
	}
	if !strings.Contains(remedy, "adb") {
		t.Errorf("remedy should clear adb of blame, since that is what the old error accused:\n%s", remedy)
	}

	// Install the image → no longer missing.
	if err := os.MkdirAll(filepath.Join(sdk, sysdir), 0o755); err != nil {
		t.Fatalf("mkdir sysimage: %v", err)
	}
	if missing, _ := avdSystemImageMissing("Pixel_4_API_32"); missing {
		t.Error("an installed system image was still reported missing")
	}
}

func TestSystemImageProbeStaysQuietWhenItCannotKnow(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	// No AVD at all, no name, and an AVD with no sysdir line: in every case the
	// probe must defer to the emulator rather than invent a diagnosis.
	if missing, _ := avdSystemImageMissing(""); missing {
		t.Error("empty AVD name produced a diagnosis")
	}
	if missing, _ := avdSystemImageMissing("does-not-exist"); missing {
		t.Error("unknown AVD produced a diagnosis instead of deferring")
	}
	dir := filepath.Join(home, ".android", "avd", "weird.avd")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "config.ini"), []byte("abi.type = arm64-v8a\n"), 0o644)
	if missing, _ := avdSystemImageMissing("weird"); missing {
		t.Error("an AVD with no image.sysdir.1 produced a diagnosis")
	}
}

// Boot must actually CALL the probe. The helper being correct is worthless if the
// boot path skips it — that is precisely the two-minute-timeout behaviour we
// removed, and it would come back invisibly.
func TestBootPreflightsTheSystemImage(t *testing.T) {
	data, err := os.ReadFile("driver_androidemu.go")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	src := string(data)
	bootAt := strings.Index(src, "func (d *AndroidEmuDriver) Boot(")
	if bootAt < 0 {
		t.Fatal("Boot not found — was it renamed?")
	}
	spawnAt := strings.Index(src[bootAt:], "exec.CommandContext")
	if spawnAt < 0 {
		t.Fatal("Boot no longer spawns the emulator — was it rewritten?")
	}
	if !strings.Contains(src[bootAt:bootAt+spawnAt], "avdSystemImageMissing(") {
		t.Fatal("Boot spawns the emulator WITHOUT pre-flighting the system image — a missing image " +
			"then panics on the emulator's own stderr and the caller waits two minutes to report " +
			"\"no adb device online\", blaming adb for an absent download")
	}
}
