# Yaver Android TV

Standalone Jetpack Compose Android TV client. It is intentionally separate
from `mobile/android`: Expo prebuild can regenerate the phone project, while
this app owns the lean-back package, D-pad interaction, LAN/relay transport,
and TV-specific runtime screens.

## Current slice

- Keystore-backed device-code/email sign-in with LAN approval beacon.
- LAN-first, relay-fallback agent transport with relay credential repair.
- Machine picker, wake lifecycle, settings, agent update requests.
- D-pad-activated dashboard controls and a real task list/detail flow.
- Shared failure classification and route-to-fix data model.

The remaining placeholder routes are intentionally visible in the navigation
until their transport contracts are implemented: task composer, live session,
Vibing preview, Android-device stream, and project preview.

## Verify locally

```bash
gradle -p androidtv assembleDebug --no-daemon
gradle -p androidtv test --no-daemon
```

Install the debug APK on an Android TV emulator or Google TV and exercise all
controls with the D-pad and Select key. A focused control must show its accent
state and Select must invoke its action; touch is not a supported test path.
