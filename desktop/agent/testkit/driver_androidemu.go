package testkit

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Android Emulator driver — wraps `emulator` and `adb`. Works on macOS
// and Linux. The dev needs the Android SDK already installed (Yaver
// won't auto-download it; that's not in scope for a CI runner).

// AndroidEmuDriver is the lifecycle wrapper. Mirror of IOSSimDriver.
type AndroidEmuDriver struct {
	AVD      string // emulator AVD name (e.g. "Pixel_7_API_34")
	APKPath  string // path to .apk to install
	Package  string // package name to launch (e.g. "io.yaver.mobile")
	Activity string // optional explicit launcher activity
}

// Available returns nil if both `adb` and `emulator` are on PATH.
func (d *AndroidEmuDriver) Available() error {
	if _, err := os.Stat(resolveTestkitCommandPath("adb")); err != nil {
		return fmt.Errorf("adb not found — install Android SDK platform-tools")
	}
	if _, err := os.Stat(resolveTestkitCommandPath("emulator")); err != nil {
		return fmt.Errorf("emulator not found — install Android SDK emulator package")
	}
	return nil
}

// Boot starts the AVD and waits for it to come online. Returns the
// adb device id once boot is complete.
func (d *AndroidEmuDriver) Boot(ctx context.Context) (string, error) {
	if err := d.Available(); err != nil {
		return "", err
	}
	if d.AVD == "" {
		if deviceID := firstOnlineEmulator(ctx); deviceID != "" {
			if err := waitForBootComplete(ctx, deviceID, 30*time.Second); err != nil {
				return deviceID, err
			}
			return deviceID, nil
		}
	} else if deviceID := onlineEmulatorForAVD(ctx, d.AVD); deviceID != "" {
		if err := waitForBootComplete(ctx, deviceID, 30*time.Second); err != nil {
			return deviceID, err
		}
		return deviceID, nil
	}
	if d.AVD == "" {
		// Auto-pick the first AVD if the user didn't name one.
		out, _ := runCtx(ctx, "emulator", "-list-avds")
		avdName, skipped, err := chooseBootableAVD(out)
		if err != nil {
			return "", fmt.Errorf("no AVDs configured — run `avdmanager create avd ...`")
		}
		if len(skipped) > 0 {
			fmt.Fprintf(os.Stderr, "[android-emulator] skipped unusable AVDs: %s\n", strings.Join(skipped, ", "))
		}
		d.AVD = avdName
	}

	// PROBE THE AVD BEFORE SPAWNING.
	//
	// An AVD whose system image was never downloaded (or was removed) makes the
	// emulator PANIC instantly — "Cannot find AVD system path" — and since the
	// panic goes to the emulator's own stderr, the caller then sat in the adb wait
	// and reported `no adb device online after 2m0s`. Two minutes to say nothing
	// useful, and it names the wrong thing: adb was fine, the image is absent.
	// Measured on a Mac mini 2026-07-25 whose Pixel_4_API_32 referenced
	// system-images/android-32/google_apis_playstore/arm64-v8a with the
	// system-images directory completely empty.
	if missing, remedy := avdSystemImageMissing(d.AVD); missing {
		return "", fmt.Errorf("%s", remedy)
	}
	if repaired, err := repairGeneratedAVDConfig(d.AVD); err != nil {
		return "", err
	} else if repaired {
		fmt.Fprintf(os.Stderr, "[android-emulator] repaired generated AVD config for %s\n", d.AVD)
	}
	if malformed, remedy := avdConfigMalformed(d.AVD); malformed {
		return "", fmt.Errorf("%s", remedy)
	}

	// Spawn the emulator in the background and wait for adb to see it.
	// Many cloud / VPS hosts don't expose /dev/kvm to guests. Without
	// KVM the emulator must use QEMU TCG (pure software emulation); we
	// pass `-accel tcg` explicitly plus a modest `-cores 2` cap (TCG
	// is CPU-hungry and otherwise starves the agent + encoder). With
	// KVM (bare metal / kvm-passthrough) we let the emulator's default
	// acceleration win — it auto-picks KVM on Linux and HVF on macOS.
	// NOTE: this path is unreachable on linux/arm64 — Google publishes
	// no emulator host binary for that arch, so Available() fails first.
	// TCG only ever matters on x86-64 Linux.
	args := []string{"-avd", d.AVD, "-no-snapshot-save", "-no-window", "-no-boot-anim", "-noaudio"}
	if runtime.GOOS == "linux" && !kvmAvailable() {
		args = append(args, "-accel", "tcg", "-cores", "2")
	}
	cmd := exec.Command(resolveTestkitCommandPath("emulator"), args...)
	logFile, logPath, logErr := emulatorBootLog()
	if logErr == nil {
		defer logFile.Close()
		cmd.Stdout = logFile
		cmd.Stderr = logFile
	}
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("emulator start: %w", err)
	}
	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()

	adbWaitStarted := time.Now()
	deviceID, err := waitForAdbDeviceForAVD(ctx, 120*time.Second, d.AVD)
	if err != nil {
		adbWaitElapsed := time.Since(adbWaitStarted).Round(time.Second)
		if logFile != nil {
			_ = logFile.Sync()
		}
		select {
		case waitErr := <-waitCh:
			tail := emulatorLogTail(logPath)
			if tail != "" {
				return "", fmt.Errorf("AVD %q started but exited before adb came online: %v\nemulator log tail:\n%s", d.AVD, waitErr, tail)
			}
			return "", fmt.Errorf("AVD %q started but exited before adb came online: %v", d.AVD, waitErr)
		default:
		}
		if logPath != "" {
			terminateStartedEmulator(cmd, waitCh)
			tail := emulatorLogTail(logPath)
			adbState := adbDevicesSnapshot(context.Background())
			if tail != "" || adbState != "" {
				return "", fmt.Errorf("AVD %q did not expose an adb device after %s; emulator was stopped, log: %s\nadb devices:\n%s\nemulator log tail:\n%s", d.AVD, adbWaitElapsed, logPath, adbState, tail)
			}
			return "", fmt.Errorf("AVD %q did not expose an adb device after %s; emulator was stopped, log: %s", d.AVD, adbWaitElapsed, logPath)
		}
		terminateStartedEmulator(cmd, waitCh)
		return "", err
	}
	if err := waitForBootComplete(ctx, deviceID, 120*time.Second); err != nil {
		if logFile != nil {
			_ = logFile.Sync()
		}
		select {
		case waitErr := <-waitCh:
			tail := emulatorLogTail(logPath)
			if tail != "" {
				return deviceID, fmt.Errorf("AVD %q adb device %s appeared but emulator exited before boot completed: %v\nemulator log tail:\n%s", d.AVD, deviceID, waitErr, tail)
			}
			return deviceID, fmt.Errorf("AVD %q adb device %s appeared but emulator exited before boot completed: %v", d.AVD, deviceID, waitErr)
		default:
		}
		terminateStartedEmulator(cmd, waitCh)
		return deviceID, err
	}
	return deviceID, nil
}

func terminateStartedEmulator(cmd *exec.Cmd, waitCh <-chan error) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Kill()
	select {
	case <-waitCh:
	case <-time.After(5 * time.Second):
	}
}

func emulatorBootLog() (*os.File, string, error) {
	f, err := os.CreateTemp("", "yaver-android-emulator-*.log")
	if err != nil {
		return nil, "", err
	}
	return f, f.Name(), nil
}

func emulatorLogTail(path string) string {
	if strings.TrimSpace(path) == "" {
		return ""
	}
	b, err := os.ReadFile(path)
	if err != nil || len(b) == 0 {
		return ""
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) > 40 {
		lines = lines[len(lines)-40:]
	}
	return strings.Join(lines, "\n")
}

func adbDevicesSnapshot(ctx context.Context) string {
	out, err := runCtx(ctx, "adb", "devices", "-l")
	if err != nil && strings.TrimSpace(out) == "" {
		return err.Error()
	}
	return strings.TrimSpace(out)
}

func avdConfigPath(home, avd string) string {
	if strings.TrimSpace(avd) == "" {
		return ""
	}
	avdHome := strings.TrimSpace(os.Getenv("ANDROID_AVD_HOME"))
	if avdHome == "" {
		avdHome = filepath.Join(home, ".android", "avd")
	}
	if iniPath := filepath.Join(avdHome, avd+".ini"); iniPath != "" {
		if data, err := os.ReadFile(iniPath); err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				k, v, ok := strings.Cut(line, "=")
				if ok && strings.TrimSpace(k) == "path" {
					p := strings.TrimSpace(v)
					if p != "" {
						return filepath.Join(p, "config.ini")
					}
				}
			}
		}
	}
	if avdHome := strings.TrimSpace(os.Getenv("ANDROID_AVD_HOME")); avdHome != "" {
		return filepath.Join(avdHome, avd+".avd", "config.ini")
	}
	return filepath.Join(avdHome, avd+".avd", "config.ini")
}

func chooseBootableAVD(list string) (string, []string, error) {
	var skipped []string
	for _, line := range strings.Split(list, "\n") {
		avd := strings.TrimSpace(line)
		if avd == "" {
			continue
		}
		if missing, _ := avdSystemImageMissing(avd); missing {
			skipped = append(skipped, avd)
			continue
		}
		if malformed, _ := avdConfigMalformed(avd); malformed {
			skipped = append(skipped, avd)
			continue
		}
		return avd, skipped, nil
	}
	return "", skipped, fmt.Errorf("no usable AVDs")
}

// AndroidAVDUsable reports whether a named AVD can be offered as a picker
// target before the user starts a session. Special surfaces (Wear/TV/XR/Auto)
// do not auto-pick; advertising them from adb/emulator alone says "yes" while
// Attach later says "no AVD/image/config", which is the silent-spinner class of
// bug in capability form.
func AndroidAVDUsable(avd string) (bool, string) {
	name := strings.TrimSpace(avd)
	if name == "" {
		return false, "AVD name is empty"
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return false, fmt.Sprintf("cannot resolve HOME to find AVD %q: %v", name, err)
	}
	cfg := avdConfigPath(home, name)
	if info, err := os.Stat(cfg); err != nil || info.IsDir() {
		return false, fmt.Sprintf("AVD %q is not configured. Create it with `avdmanager create avd -n %s ...` after installing the matching Android system image.", name, name)
	}
	if missing, remedy := avdSystemImageMissing(name); missing {
		return false, remedy
	}
	if _, err := repairGeneratedAVDConfig(name); err != nil {
		return false, err.Error()
	}
	if malformed, remedy := avdConfigMalformed(name); malformed {
		return false, remedy
	}
	return true, ""
}

// AndroidAnyAVDUsable reports whether the default Android emulator target can
// honestly be offered. It mirrors Boot's auto-pick path instead of treating
// `adb + emulator` as enough: an installed emulator binary with zero bootable
// AVDs still cannot create a WebRTC session.
func AndroidAnyAVDUsable(ctx context.Context) (bool, string) {
	if ctx == nil {
		ctx = context.Background()
	}
	out, err := runCtx(ctx, "emulator", "-list-avds")
	if err != nil {
		return false, fmt.Sprintf("Android emulator AVD probe failed: %v", err)
	}
	avdName, skipped, err := chooseBootableAVD(out)
	if err != nil {
		if len(skipped) > 0 {
			return false, fmt.Sprintf("No bootable Android AVDs configured. Skipped unusable AVDs: %s.", strings.Join(skipped, ", "))
		}
		return false, "No Android AVDs configured. Create one with Android Studio Device Manager or `avdmanager create avd ...`."
	}
	if strings.TrimSpace(avdName) == "" {
		return false, "No Android AVDs configured. Create one with Android Studio Device Manager or `avdmanager create avd ...`."
	}
	return true, ""
}

func repairGeneratedAVDConfig(avd string) (bool, error) {
	name := strings.TrimSpace(avd)
	if name == "" {
		return false, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return false, nil
	}
	cfg := avdConfigPath(home, name)
	data, err := os.ReadFile(cfg)
	if err != nil {
		return false, nil
	}
	avdDir := filepath.Dir(cfg)
	changed := false
	generatedTemplate := strings.Contains(string(data), "<build>") || strings.Contains(string(data), "<temp>")
	var lines []string
	for _, line := range strings.Split(string(data), "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			lines = append(lines, line)
			continue
		}
		key := strings.TrimSpace(k)
		value := strings.TrimSpace(v)
		switch key {
		case "avd.id":
			if strings.Contains(value, "<") || strings.Contains(value, ">") {
				line = "avd.id=" + name
				changed = true
			}
		case "avd.name":
			if strings.Contains(value, "<") || strings.Contains(value, ">") {
				line = "avd.name=" + name
				changed = true
			}
		case "disk.dataPartition.path":
			if strings.Contains(value, "<") || strings.Contains(value, ">") {
				line = "disk.dataPartition.path=" + filepath.Join(avdDir, "userdata-qemu.img")
				changed = true
			}
		case "disk.dataPartition.size":
			if generatedTemplate && androidAVDPartitionSizeTooLarge(value) {
				line = "disk.dataPartition.size=2G"
				changed = true
			}
		}
		lines = append(lines, line)
	}
	if !changed {
		return false, nil
	}
	if err := os.WriteFile(cfg, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		return false, fmt.Errorf("repair AVD %q generated config: %w", name, err)
	}
	return true, nil
}

func androidAVDPartitionSizeTooLarge(value string) bool {
	v := strings.ToUpper(strings.TrimSpace(value))
	if strings.HasSuffix(v, "GB") {
		v = strings.TrimSpace(strings.TrimSuffix(v, "GB"))
	} else if strings.HasSuffix(v, "G") {
		v = strings.TrimSpace(strings.TrimSuffix(v, "G"))
	} else {
		var bytes int64
		if _, err := fmt.Sscanf(v, "%d", &bytes); err != nil {
			return false
		}
		return bytes > 4*1024*1024*1024
	}
	var n int
	if _, err := fmt.Sscanf(v, "%d", &n); err != nil {
		return false
	}
	return n > 4
}

// kvmAvailable reports whether /dev/kvm is exposed to this process.
// Most x86 cloud VMs don't expose nested KVM, so the emulator falls
// back to TCG software emulation there (minutes-long cold boot vs
// ~10s with KVM). Bare-metal Linux hosts and macOS (HVF, not
// KVM-named) take the default-acceleration path. Stat is cheap; not
// memoised since this is called once per emulator boot.
func kvmAvailable() bool {
	if _, err := os.Stat("/dev/kvm"); err == nil {
		return true
	}
	return false
}

func firstOnlineEmulator(ctx context.Context) string {
	if online := OnlineEmulators(ctx); len(online) > 0 {
		return online[0]
	}
	return ""
}

func onlineEmulatorForAVD(ctx context.Context, avd string) string {
	want := strings.TrimSpace(avd)
	if want == "" {
		return firstOnlineEmulator(ctx)
	}
	for _, serial := range OnlineEmulators(ctx) {
		if emulatorAVDName(ctx, serial) == want {
			return serial
		}
	}
	return ""
}

func emulatorAVDName(ctx context.Context, serial string) string {
	out, err := runCtx(ctx, "adb", "-s", serial, "shell", "getprop", "ro.boot.qemu.avd_name")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// OnlineEmulators returns every booted emulator serial, in adb order.
//
// A LIST, not the first one: on a machine hosting several sessions each needs a
// DIFFERENT emulator, and the caller can only arbitrate that if it can see the
// alternatives. Returning just the first is why every session on a box ended up
// driving one device (see desktop/agent/runtime_devices.go).
func OnlineEmulators(ctx context.Context) []string {
	out, _ := runCtx(ctx, "adb", "devices")
	var serials []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "List of devices") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[1] == "device" && strings.HasPrefix(fields[0], "emulator-") {
			serials = append(serials, fields[0])
		}
	}
	return serials
}

// Install installs the APK onto the booted device.
func (d *AndroidEmuDriver) Install(ctx context.Context, deviceID string) error {
	if d.APKPath == "" {
		return fmt.Errorf("install: APKPath is empty")
	}
	if _, err := runCtx(ctx, "adb", "-s", deviceID, "install", "-r", d.APKPath); err != nil {
		return fmt.Errorf("adb install: %w", err)
	}
	return nil
}

// SetPackage overrides the package to launch (a `goto: <pkg>` step). Part of the
// androidDriver interface so the redroid backend can be swapped in.
func (d *AndroidEmuDriver) SetPackage(pkg string) { d.Package = pkg }

// Launch starts the app via `monkey` (the simplest way to launch
// without knowing the activity name). Falls back to explicit
// activity if d.Activity is set.
func (d *AndroidEmuDriver) Launch(ctx context.Context, deviceID string) error {
	if d.Package == "" {
		return fmt.Errorf("launch: Package is empty")
	}
	if d.Activity != "" {
		_, err := runCtx(ctx, "adb", "-s", deviceID, "shell", "am", "start", "-n", d.Package+"/"+d.Activity)
		return err
	}
	_, err := runCtx(ctx, "adb", "-s", deviceID, "shell", "monkey", "-p", d.Package, "-c", "android.intent.category.LAUNCHER", "1")
	return err
}

// Screenshot captures a PNG to outPath via `adb exec-out screencap`.
func (d *AndroidEmuDriver) Screenshot(ctx context.Context, deviceID, outPath string) error {
	cmd := exec.CommandContext(ctx, resolveTestkitCommandPath("adb"), "-s", deviceID, "exec-out", "screencap", "-p")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg != "" {
			return fmt.Errorf("adb screencap: %w: %s", err, msg)
		}
		return fmt.Errorf("adb screencap: %w", err)
	}
	if len(out) == 0 {
		return fmt.Errorf("adb screencap produced 0 bytes for %s — device is online but not capturable", deviceID)
	}
	out = stripToPNGSignature(out)
	return writeFile(outPath, out)
}

func stripToPNGSignature(out []byte) []byte {
	pngSig := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
	if i := bytes.Index(out, pngSig); i > 0 {
		return out[i:]
	}
	return out
}

// Shutdown stops the emulator. Best-effort.
func (d *AndroidEmuDriver) Shutdown(ctx context.Context, deviceID string) error {
	_, _ = runCtx(ctx, "adb", "-s", deviceID, "emu", "kill")
	return nil
}

// waitForAdbDevice polls `adb devices` until at least one online
// device shows up or timeout. Returns the first online device id.
func waitForAdbDevice(ctx context.Context, timeout time.Duration) (string, error) {
	return waitForAdbDeviceForAVD(ctx, timeout, "")
}

func waitForAdbDeviceForAVD(ctx context.Context, timeout time.Duration, avd string) (string, error) {
	deadline := time.Now().Add(timeout)
	started := time.Now()
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			if strings.TrimSpace(avd) != "" {
				return "", fmt.Errorf("no adb device for AVD %q before caller deadline after %s: %w", avd, time.Since(started).Round(time.Second), ctx.Err())
			}
			return "", fmt.Errorf("no adb device before caller deadline after %s: %w", time.Since(started).Round(time.Second), ctx.Err())
		default:
		}
		out, _ := runCtx(ctx, "adb", "devices")
		if serial, err := adbOnlineDeviceFromList(out); err != nil {
			return "", err
		} else if serial != "" {
			if strings.TrimSpace(avd) == "" || emulatorAVDName(ctx, serial) == strings.TrimSpace(avd) {
				return serial, nil
			}
		}
		if serial := onlineEmulatorForAVD(ctx, avd); serial != "" {
			return serial, nil
		}
		time.Sleep(1 * time.Second)
	}
	if strings.TrimSpace(avd) != "" {
		return "", fmt.Errorf("no adb device for AVD %q online after %s", avd, timeout)
	}
	return "", fmt.Errorf("no adb device online after %s", timeout)
}

func adbOnlineDeviceFromList(out string) (string, error) {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "List of devices") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[1] == "device" {
			return fields[0], nil
		}
		if len(fields) >= 2 && fields[1] == "unauthorized" {
			return "", fmt.Errorf("adb device %s is unauthorized — accept the Android debugging prompt, or restart adb with ADB_VENDOR_KEYS pointing at the user's ~/.android adb key before booting the emulator", fields[0])
		}
	}
	return "", nil
}

// waitForBootComplete polls the device until `getprop sys.boot_completed`
// returns 1 (Android's "boot animation finished" signal).
func waitForBootComplete(ctx context.Context, deviceID string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	started := time.Now()
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return fmt.Errorf("device %s did not finish booting before caller deadline after %s: %w", deviceID, time.Since(started).Round(time.Second), ctx.Err())
		default:
		}
		out, _ := runCtx(ctx, "adb", "-s", deviceID, "shell", "getprop", "sys.boot_completed")
		if strings.TrimSpace(out) == "1" {
			return nil
		}
		time.Sleep(1 * time.Second)
	}
	return fmt.Errorf("device %s did not finish booting in %s", deviceID, timeout)
}

func writeFile(path string, data []byte) error {
	return writeFileImpl(path, data)
}

// Tap sends a tap event at (x, y) using `adb shell input tap`. Used
// by the runner for `target: android-emu` specs once we add coordinate
// resolution from selectors. Solo dev typically records taps via
// `yaver test record` against an android-emu target.
func (d *AndroidEmuDriver) Tap(ctx context.Context, deviceID string, x, y int) error {
	_, err := runCtx(ctx, "adb", "-s", deviceID, "shell", "input", "tap", fmt.Sprintf("%d", x), fmt.Sprintf("%d", y))
	return err
}

// Text sends keystrokes via `adb shell input text`. Spaces in text get
// converted to %s per the adb input convention.
func (d *AndroidEmuDriver) Text(ctx context.Context, deviceID, text string) error {
	escaped := ""
	for _, r := range text {
		if r == ' ' {
			escaped += "%s"
		} else {
			escaped += string(r)
		}
	}
	_, err := runCtx(ctx, "adb", "-s", deviceID, "shell", "input", "text", escaped)
	return err
}

// KeyEvent sends a hardware key (e.g. KEYCODE_BACK = 4, KEYCODE_HOME = 3).
func (d *AndroidEmuDriver) KeyEvent(ctx context.Context, deviceID string, keycode int) error {
	_, err := runCtx(ctx, "adb", "-s", deviceID, "shell", "input", "keyevent", fmt.Sprintf("%d", keycode))
	return err
}

// Swipe drags from (x1,y1) to (x2,y2) over durationMs milliseconds.
// Used by the remote-runtime web viewer for pointer drags. adb's
// `input swipe` accepts the duration as a fifth positional arg in
// every supported Android version; <=0 falls back to its default
// (~250 ms).
func (d *AndroidEmuDriver) Swipe(ctx context.Context, deviceID string, x1, y1, x2, y2, durationMs int) error {
	args := []string{"-s", deviceID, "shell", "input", "swipe",
		fmt.Sprintf("%d", x1), fmt.Sprintf("%d", y1),
		fmt.Sprintf("%d", x2), fmt.Sprintf("%d", y2)}
	if durationMs > 0 {
		args = append(args, fmt.Sprintf("%d", durationMs))
	}
	_, err := runCtx(ctx, "adb", args...)
	return err
}

// avdSystemImageMissing reports whether the AVD's system image is absent, plus a
// remedy naming the exact sdkmanager package to install.
//
// Reads the AVD's own config.ini (image.sysdir.1) and checks that directory under
// every plausible SDK root. Cheap: two stats and a small file read, versus a
// two-minute wait that blames adb.
func avdSystemImageMissing(avd string) (bool, string) {
	if strings.TrimSpace(avd) == "" {
		return false, ""
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return false, ""
	}
	cfg := avdConfigPath(home, avd)
	data, err := os.ReadFile(cfg)
	if err != nil {
		return false, "" // no config to read — let the emulator speak for itself
	}
	sysdir := ""
	for _, line := range strings.Split(string(data), "\n") {
		if k, v, ok := strings.Cut(line, "="); ok && strings.TrimSpace(k) == "image.sysdir.1" {
			sysdir = strings.TrimSpace(v)
			break
		}
	}
	if sysdir == "" {
		return false, ""
	}
	for _, root := range testkitAndroidSDKRoots() {
		if info, err := os.Stat(filepath.Join(root, sysdir)); err == nil && info.IsDir() {
			return false, "" // present
		}
	}
	// "system-images/android-32/google_apis_playstore/arm64-v8a/" →
	// "system-images;android-32;google_apis_playstore;arm64-v8a"
	pkg := strings.ReplaceAll(strings.Trim(sysdir, "/"), "/", ";")
	return true, fmt.Sprintf(
		"AVD %q needs the system image %q, which is not installed on this machine. "+
			"Install it with: sdkmanager %q   (then the Android lane works without any further setup). "+
			"Nothing is wrong with adb or the emulator binary.",
		avd, sysdir, pkg)
}

func avdConfigMalformed(avd string) (bool, string) {
	if strings.TrimSpace(avd) == "" {
		return false, ""
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return false, ""
	}
	cfg := avdConfigPath(home, avd)
	data, err := os.ReadFile(cfg)
	if err != nil {
		return false, ""
	}
	var bad []string
	for _, line := range strings.Split(string(data), "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key := strings.TrimSpace(k)
		value := strings.TrimSpace(v)
		switch key {
		case "avd.id", "avd.name", "disk.dataPartition.path":
			if strings.Contains(value, "<") || strings.Contains(value, ">") {
				bad = append(bad, key+"="+value)
			}
		}
	}
	if len(bad) == 0 {
		return false, ""
	}
	return true, fmt.Sprintf(
		"AVD %q has malformed config fields (%s). Recreate it with avdmanager after reinstalling its system image; "+
			"the emulator may start but never expose adb, so WebRTC cannot capture frames from it.",
		avd, strings.Join(bad, ", "))
}
