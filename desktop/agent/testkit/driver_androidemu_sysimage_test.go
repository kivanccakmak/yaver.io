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
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestSystemImageProbeUsesAndroidAVDHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	avdHome := filepath.Join(home, "custom-avds")
	t.Setenv("ANDROID_AVD_HOME", avdHome)
	sdk := filepath.Join(home, "sdk")
	t.Setenv("ANDROID_SDK_ROOT", sdk)
	t.Setenv("ANDROID_HOME", sdk)

	const sysdir = "system-images/android-34/android-wear/arm64-v8a/"
	dir := filepath.Join(avdHome, "wear.avd")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir avd: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.ini"), []byte("image.sysdir.1 = "+sysdir+"\n"), 0o644); err != nil {
		t.Fatalf("write config.ini: %v", err)
	}

	missing, remedy := avdSystemImageMissing("wear")
	if !missing {
		t.Fatal("ANDROID_AVD_HOME was ignored; the real AVD registry was not preflighted")
	}
	if !strings.Contains(remedy, "system-images;android-34;android-wear;arm64-v8a") {
		t.Fatalf("remedy did not name the exact package: %s", remedy)
	}
}

func TestSystemImageProbeUsesManagedAndroidSDKRoot(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ANDROID_SDK_ROOT", "")
	t.Setenv("ANDROID_HOME", "")

	const sysdir = "system-images/android-35/google_apis/arm64-v8a/"
	writeAVD(t, home, "managed_phone", sysdir)

	missing, remedy := avdSystemImageMissing("managed_phone")
	if !missing {
		t.Fatal("missing managed SDK system image was reported as installed")
	}
	if !strings.Contains(remedy, "system-images;android-35;google_apis;arm64-v8a") {
		t.Fatalf("remedy did not name the exact managed SDK package: %s", remedy)
	}

	managedSDK := filepath.Join(home, ".yaver", "runtimes", "android-sdk")
	if err := os.MkdirAll(filepath.Join(managedSDK, sysdir), 0o755); err != nil {
		t.Fatalf("mkdir managed sysimage: %v", err)
	}
	if missing, remedy := avdSystemImageMissing("managed_phone"); missing {
		t.Fatalf("installed managed SDK system image was still reported missing: %s", remedy)
	}
}

func TestMalformedAVDConfigIsNamedBeforeBoot(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".android", "avd", "wear.avd")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir avd: %v", err)
	}
	body := strings.Join([]string{
		"image.sysdir.1 = system-images/android-34/android-wear/arm64-v8a/",
		"avd.id=<build>",
		"avd.name=<build>",
		"disk.dataPartition.path=<temp>",
		"disk.dataPartition.size=10G",
	}, "\n")
	if err := os.WriteFile(filepath.Join(dir, "config.ini"), []byte(body), 0o644); err != nil {
		t.Fatalf("write config.ini: %v", err)
	}

	malformed, remedy := avdConfigMalformed("wear")
	if !malformed {
		t.Fatal("malformed AVD placeholders were not named before boot")
	}
	for _, want := range []string{"avd.id=<build>", "disk.dataPartition.path=<temp>", "never expose adb"} {
		if !strings.Contains(remedy, want) {
			t.Fatalf("remedy missing %q:\n%s", want, remedy)
		}
	}
}

func TestGeneratedAVDConfigRepairClearsPlaceholders(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".android", "avd", "wear.avd")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir avd: %v", err)
	}
	body := strings.Join([]string{
		"image.sysdir.1 = system-images/android-34/android-wear/arm64-v8a/",
		"avd.id=<build>",
		"avd.name=<build>",
		"disk.dataPartition.path=<temp>",
		"disk.dataPartition.size=10G",
	}, "\n")
	cfg := filepath.Join(dir, "config.ini")
	if err := os.WriteFile(cfg, []byte(body), 0o644); err != nil {
		t.Fatalf("write config.ini: %v", err)
	}

	repaired, err := repairGeneratedAVDConfig("wear")
	if err != nil {
		t.Fatalf("repairGeneratedAVDConfig: %v", err)
	}
	if !repaired {
		t.Fatal("malformed generated config was not repaired")
	}
	data, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatalf("read config.ini: %v", err)
	}
	got := string(data)
	for _, want := range []string{
		"avd.id=wear",
		"avd.name=wear",
		"disk.dataPartition.path=" + filepath.Join(dir, "userdata-qemu.img"),
		"disk.dataPartition.size=2G",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("repaired config missing %q:\n%s", want, got)
		}
	}
	if malformed, remedy := avdConfigMalformed("wear"); malformed {
		t.Fatalf("repaired config is still malformed:\n%s", remedy)
	}
}

func TestGeneratedAVDConfigRepairKeepsExplicitSmallPartition(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".android", "avd", "wear.avd")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir avd: %v", err)
	}
	body := strings.Join([]string{
		"image.sysdir.1 = system-images/android-34/android-wear/arm64-v8a/",
		"avd.id=<build>",
		"avd.name=<build>",
		"disk.dataPartition.path=<temp>",
		"disk.dataPartition.size=3G",
	}, "\n")
	cfg := filepath.Join(dir, "config.ini")
	if err := os.WriteFile(cfg, []byte(body), 0o644); err != nil {
		t.Fatalf("write config.ini: %v", err)
	}

	if _, err := repairGeneratedAVDConfig("wear"); err != nil {
		t.Fatalf("repairGeneratedAVDConfig: %v", err)
	}
	data, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatalf("read config.ini: %v", err)
	}
	got := string(data)
	if !strings.Contains(got, "disk.dataPartition.size=3G") {
		t.Fatalf("small explicit partition was changed:\n%s", got)
	}
}

func TestGeneratedAVDConfigRepairCompactsBytePartition(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".android", "avd", "auto.avd")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir avd: %v", err)
	}
	body := strings.Join([]string{
		"image.sysdir.1 = system-images/android-35-ext15/android-automotive/arm64-v8a/",
		"avd.id = <build>",
		"avd.name = <build>",
		"disk.dataPartition.path = <temp>",
		"disk.dataPartition.size = 6442450944",
	}, "\n")
	cfg := filepath.Join(dir, "config.ini")
	if err := os.WriteFile(cfg, []byte(body), 0o644); err != nil {
		t.Fatalf("write config.ini: %v", err)
	}

	if _, err := repairGeneratedAVDConfig("auto"); err != nil {
		t.Fatalf("repairGeneratedAVDConfig: %v", err)
	}
	data, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatalf("read config.ini: %v", err)
	}
	got := string(data)
	if !strings.Contains(got, "disk.dataPartition.size=2G") {
		t.Fatalf("oversized byte partition was not compacted:\n%s", got)
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

func TestChooseBootableAVDSkipsBrokenFirstCandidate(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	sdk := filepath.Join(home, "sdk")
	t.Setenv("ANDROID_SDK_ROOT", sdk)
	t.Setenv("ANDROID_HOME", sdk)

	writeAVD(t, home, "missing_image", "system-images/android-32/google_apis/arm64-v8a/")
	badDir := filepath.Join(home, ".android", "avd", "malformed.avd")
	if err := os.MkdirAll(badDir, 0o755); err != nil {
		t.Fatalf("mkdir malformed avd: %v", err)
	}
	if err := os.WriteFile(filepath.Join(badDir, "config.ini"), []byte("image.sysdir.1 = system-images/android-33/android-tv/arm64-v8a/\navd.id=<build>\n"), 0o644); err != nil {
		t.Fatalf("write malformed avd: %v", err)
	}
	const goodSysdir = "system-images/android-35/google_atd/arm64-v8a/"
	writeAVD(t, home, "good", goodSysdir)
	if err := os.MkdirAll(filepath.Join(sdk, goodSysdir), 0o755); err != nil {
		t.Fatalf("mkdir good sysimage: %v", err)
	}

	got, skipped, err := chooseBootableAVD("missing_image\nmalformed\ngood\n")
	if err != nil {
		t.Fatalf("chooseBootableAVD: %v", err)
	}
	if got != "good" {
		t.Fatalf("picked %q, want good", got)
	}
	if strings.Join(skipped, ",") != "missing_image,malformed" {
		t.Fatalf("skipped = %v", skipped)
	}
}

func TestChooseBootableAVDResolvesDisplayNameIniPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	sdk := filepath.Join(home, "sdk")
	t.Setenv("ANDROID_SDK_ROOT", sdk)
	t.Setenv("ANDROID_HOME", sdk)
	avdHome := filepath.Join(home, ".android", "avd")
	realDir := filepath.Join(avdHome, "Medium_Phone.avd")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatalf("mkdir avd: %v", err)
	}
	if err := os.WriteFile(filepath.Join(avdHome, "Medium_Phone_API_36.0.ini"), []byte("path="+realDir+"\n"), 0o644); err != nil {
		t.Fatalf("write avd ini: %v", err)
	}
	if err := os.WriteFile(filepath.Join(realDir, "config.ini"), []byte("image.sysdir.1=system-images/android-36/google_apis_playstore/arm64-v8a/\n"), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	_, skipped, err := chooseBootableAVD("Medium_Phone_API_36.0\n")
	if err == nil {
		t.Fatal("display-name AVD with missing image was treated as bootable because its .ini path was ignored")
	}
	if strings.Join(skipped, ",") != "Medium_Phone_API_36.0" {
		t.Fatalf("skipped = %v", skipped)
	}
}

func TestAndroidAVDUsableNamesMissingExactAVD(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	ok, reason := AndroidAVDUsable("wear")
	if ok {
		t.Fatal("missing exact Wear AVD was reported usable")
	}
	for _, want := range []string{"AVD \"wear\" is not configured", "avdmanager create avd", "wear"} {
		if !strings.Contains(reason, want) {
			t.Fatalf("reason missing %q:\n%s", want, reason)
		}
	}
}

func TestAndroidAVDUsableAcceptsInstalledImage(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	sdk := filepath.Join(home, "sdk")
	t.Setenv("ANDROID_SDK_ROOT", sdk)
	t.Setenv("ANDROID_HOME", sdk)

	const sysdir = "system-images/android-34/android-wear/arm64-v8a/"
	writeAVD(t, home, "wear", sysdir)
	if err := os.MkdirAll(filepath.Join(sdk, sysdir), 0o755); err != nil {
		t.Fatalf("mkdir sysimage: %v", err)
	}

	if ok, reason := AndroidAVDUsable("wear"); !ok {
		t.Fatalf("installed Wear AVD was disabled: %s", reason)
	}
}

func TestScreencapStripsWarningBeforePNG(t *testing.T) {
	raw := append([]byte("[Warning] Multiple displays were found\n"), []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 1, 2, 3}...)
	got := stripToPNGSignature(raw)
	if !bytes.Equal(got, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 1, 2, 3}) {
		t.Fatalf("did not strip warning prefix: % x", got)
	}
	plain := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
	if got := stripToPNGSignature(plain); !bytes.Equal(got, plain) {
		t.Fatalf("plain PNG changed: % x", got)
	}
}

func TestWaitForAdbDeviceNamesUnauthorized(t *testing.T) {
	_, err := adbOnlineDeviceFromList("List of devices attached\nemulator-5554\tunauthorized\n")
	if err == nil {
		t.Fatal("unauthorized adb device waited for timeout instead of naming the auth problem")
	}
	for _, want := range []string{"unauthorized", "ADB_VENDOR_KEYS", "emulator-5554"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error missing %q:\n%s", want, err)
		}
	}
}

func TestWaitForAdbDeviceForAVDNamesCallerDeadline(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := waitForAdbDeviceForAVD(ctx, time.Minute, "Medium_Phone_API_36.0")
	if err == nil {
		t.Fatal("expected canceled context to return a named AVD wait error")
	}
	for _, want := range []string{"Medium_Phone_API_36.0", "caller deadline", "context canceled"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error missing %q:\n%s", want, err)
		}
	}
}

func TestWaitForBootCompleteNamesCallerDeadline(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := waitForBootComplete(ctx, "emulator-5554", time.Minute)
	if err == nil {
		t.Fatal("expected canceled context to return a named boot wait error")
	}
	for _, want := range []string{"emulator-5554", "caller deadline", "context canceled"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error missing %q:\n%s", want, err)
		}
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
	spawnAt := strings.Index(src[bootAt:], "exec.Command(")
	if spawnAt < 0 {
		t.Fatal("Boot no longer spawns the emulator — was it rewritten?")
	}
	if strings.Contains(src[bootAt:], "exec.CommandContext(ctx, resolveTestkitCommandPath(\"emulator\")") {
		t.Fatal("Boot ties the emulator process lifetime to the attach/wait context — a successful attach can " +
			"cancel that context and kill the emulator before WebRTC captures its first frame")
	}
	if !strings.Contains(src[bootAt:bootAt+spawnAt], "onlineEmulatorForAVD(ctx, d.AVD)") {
		t.Fatal("Boot with an exact AVD can reuse the first unrelated online emulator — android-tv could attach " +
			"to a running Wear device and report a false pass")
	}
	if !strings.Contains(src[bootAt:], "waitForAdbDeviceForAVD(ctx, 120*time.Second, d.AVD)") {
		t.Fatal("Boot does not wait for the requested AVD after spawning — adb can return an older emulator first")
	}
	if !strings.Contains(src[bootAt:bootAt+spawnAt], "avdSystemImageMissing(") {
		t.Fatal("Boot spawns the emulator WITHOUT pre-flighting the system image — a missing image " +
			"then panics on the emulator's own stderr and the caller waits two minutes to report " +
			"\"no adb device online\", blaming adb for an absent download")
	}
	if !strings.Contains(src[bootAt:bootAt+spawnAt], "avdConfigMalformed(") {
		t.Fatal("Boot spawns the emulator WITHOUT pre-flighting malformed AVD config — a Wear/TV/Auto image " +
			"with placeholder fields can then hang until adb timeout or produce a silent WebRTC stream")
	}
}
