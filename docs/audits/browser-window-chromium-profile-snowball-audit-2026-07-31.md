# Browser-Window Chromium Profile Failure Snowball Audit — 2026-07-31

## Trigger

Runtime Lab on `yaver.io` failed opening an Expo mobile project with a Linux render machine:

```text
Runtime target probe failed
launch headless chromium: chrome failed to start:
[...:ERROR:chrome/browser/process_singleton_posix.cc:1043] Failed to create socket directory.
[...:ERROR:chrome/app/chrome_main_delegate.cc:520] Failed to create a ProcessSingleton for your profile directory.
This means that running multiple instances would start multiple browser processes rather than opening a new window in the existing process.
Aborting now to avoid profile corruption.
```

The same card also reported:

```text
Connection to the render machine: OK via relay (...) — the box is up; the failure is in the operation, not the connection.
```

That connection diagnosis is correct. This incident is not a relay reachability failure. It is a browser launch/profile/runtime-dir failure on the render machine.

## Observed Facts

- The Linux render machine is reachable over the relay.
- Chrome exists and can launch when given a fresh, explicit profile directory:

```text
google-chrome --headless=new --no-sandbox --disable-gpu --user-data-dir="$(mktemp -d /tmp/yaver-chrome-smoke.XXXXXX)" --dump-dom about:blank
rc=0
```

- The box has stale/default browser singleton state:

```text
/root/.config/chromium/SingletonSocket -> /tmp/org.chromium.Chromium.<suffix>/SingletonSocket
/root/.config/chromium/SingletonCookie -> <redacted singleton cookie>
/root/.config/chromium/SingletonLock -> <redacted host-pid lock>
/tmp/com.google.Chrome.<suffix>/SingletonSocket
/tmp/com.google.Chrome.<suffix>/SingletonCookie
```

- Disk pressure is real:

```text
/dev/sda1 75G 71G 1.7G 98% /
```

- The coding-runner repair task worked in the app project and added project-local scripts that isolate `HOME`, `TMPDIR`, and `XDG_RUNTIME_DIR` for `expo export`.

## Current Repair Route Assessment

The running repair may unblock this specific mobile export, but it is not the correct product-layer fix for the observed Runtime Lab failure.

Why: the failure happens when Yaver’s agent launches the `browser-window` runtime target through `chromedp`, not inside the application source code. A project-local `npm run build` wrapper can make Expo export cleaner, but it does not guarantee that `browserWindowPool.open()` will launch Chrome with an isolated profile when Runtime Lab creates `browser-window`.

This is the snowball issue: the product routed a deterministic runtime host failure to a general coding task. That task naturally patched the app because its working directory is the app. The failing operation belongs to the agent/browser-window runtime layer.

## Root Cause Shape

`desktop/agent/remote_runtime_browser.go` launches Chromium via `chromedp.NewExecAllocator` with default allocator options plus flags, but no explicit per-session `--user-data-dir`, no explicit `XDG_RUNTIME_DIR`, and no per-session `TMPDIR`.

When Chrome defaults to `/root/.config/...` and `/tmp/...`, stale singleton links or concurrent launches can make Chrome abort with `ProcessSingleton` before Yaver can stream anything.

The inventory probe is insufficient:

- `probeBrowserWindowTarget()` verifies a Chrome binary exists and can print `--version`.
- The actual operation needs Chrome to create a socket directory, create a singleton, open a profile, start a CDP browser, navigate, and capture a frame.

This is the exact class: inventory says yes, operation says no.

## Product Hardening Required

### 1. Agent must isolate Chrome per browser-window session

In `browserWindowPool.open()`:

- Create a per-session directory under a Yaver-owned runtime root, for example:
  - `$XDG_RUNTIME_DIR/yaver/browser-window/<session-id>` when valid
  - fallback: `os.MkdirTemp("", "yaver-browser-window-*")`
- Pass explicit Chrome flags:
  - `--user-data-dir=<session-profile-dir>`
  - `--data-path=<session-data-dir>` if needed
  - `--disk-cache-dir=<session-cache-dir>`
  - keep `--no-sandbox` for container/root Linux lanes
- Set allocator environment where chromedp supports it, or launch through a wrapper when not:
  - `TMPDIR=<session-tmp-dir>`
  - `XDG_RUNTIME_DIR=<session-runtime-dir>` with `0700`
- Cleanup these directories on `browserPool.close()` and stale reaper.

This makes profile collisions impossible by construction.

### 2. Capability probe must test the real launch contract

Replace or extend `probeBrowserWindowTarget()` so “enabled” means:

- Chrome binary resolves.
- A one-shot headless Chrome launch succeeds with an isolated temp profile.
- A simple page can be opened or CDP can attach.
- A screenshot can be captured, or the failure carries a structured reason.

Do not block for a long time. Use a short timeout and cache the result with TTL.

### 3. Structured failure code

Add named failure classification for this case. Suggested stable codes:

- `browser_window.chrome_profile_lock`
- `browser_window.chrome_runtime_dir`
- `browser_window.chrome_launch_failed`
- `browser_window.chrome_missing`
- `browser_window.disk_full`

The current prose is useful for a developer, but the product needs typed fields:

```json
{
  "code": "browser_window.chrome_profile_lock",
  "operation": "remote_runtime.browser_window.launch",
  "targetId": "browser-window",
  "browser": "google-chrome",
  "profileDir": "...",
  "runtimeDir": "...",
  "diskFreeBytes": 1700000000,
  "repair": {
    "method": "POST",
    "path": "/remote-runtime/browser-window/repair",
    "label": "Repair browser runtime"
  }
}
```

### 4. Deterministic route before AI fallback

For this failure class, Runtime Lab should not lead with “Fix with OpenAI Codex”.

Correct order:

1. Run deterministic repair:
   - verify/create runtime dirs
   - remove only Yaver-owned stale browser-window dirs
   - leave user/default Chrome profiles untouched
   - run one-shot Chrome launch smoke
   - retry target creation
2. If deterministic repair fails, then offer AI fallback with the structured repair transcript attached.

The UI can still show an AI fallback, but it should be secondary and should name that deterministic repair already failed.

### 5. Disk pressure must be surfaced as a contributing condition

The Linux render machine was at 98% root disk. That may not be the direct cause because a fresh temp profile did launch, but it is close enough to break future cache/profile creation.

The agent should include disk pressure in the failure context and offer a Yaver-artifact cleanup route that only deletes known Yaver temp/artifact paths.

Never ask a coding runner to “free space” blindly.

## Tests To Add

### Unit

- `browserWindowPool.open` includes an explicit `user-data-dir`.
- per-session profile path is unique for concurrent opens.
- close/reaper removes only Yaver-owned profile dirs.
- launch failures classify `ProcessSingleton` as `browser_window.chrome_profile_lock`.
- launch failures classify `Failed to create socket directory` as `browser_window.chrome_runtime_dir` or profile-lock depending on stderr.

### Integration

- Create a fake stale `SingletonLock` in the default Chrome profile and verify browser-window still opens because Yaver uses a per-session profile.
- Start two browser-window sessions concurrently and verify both stream pixels.
- Force temp/runtime dir unwritable and verify UI gets a named failure with a deterministic repair route.
- Force low disk in a test sandbox and verify disk pressure is included without claiming it is the only cause.

### Closed Loop

- From web Runtime Lab, select Ubuntu render machine, `Load Targets`, open `WebRTC over browser`.
- Verify:
  - no `ProcessSingleton` failure
  - target creation succeeds
  - WebRTC JPEG frame arrives
  - browser logs route over events channel
  - cleanup reports zero live sessions after close

## Snowball Conclusion

The product should learn this incident as:

Chrome being installed is not enough. Browser-window support requires a launchable, isolated, writable browser runtime. Yaver must own that runtime directory and verify the real operation before advertising or starting the lane.

The repair route should be deterministic first. AI fallback is appropriate only after the product has tried the bounded, idempotent repair and captured why it failed.
