# @yaver/feedback-react-native

Visual feedback SDK for Yaver. Lets testers and developers shake their phone (or tap a floating button) to capture screenshots, record voice notes, and send bug reports directly to a Yaver agent running on a dev machine. Built for vibe coding workflows where feedback needs to flow fast.

## Installation

```bash
npm install @yaver/feedback-react-native
```

### Peer dependencies

For full functionality, install these optional peer dependencies:

```bash
# Device discovery (stored connections)
npm install @react-native-async-storage/async-storage

# Screenshots
npm install react-native-view-shot

# Voice notes
npm install react-native-audio-recorder-player
```

## Quick Start

```tsx
import { YaverFeedback, FeedbackModal } from '@yaver/feedback-react-native';

// Initialize once at app startup
YaverFeedback.init({
  agentUrl: 'http://192.168.1.10:18080',
  authToken: 'your-token',
  trigger: 'shake',
});

// Add FeedbackModal to your root component
function App() {
  return (
    <>
      <YourApp />
      <FeedbackModal />
    </>
  );
}
```

Shake your phone to open the feedback modal. Take screenshots, record voice notes, and send everything to your Yaver agent in one tap.

## Device Discovery

The SDK can auto-discover Yaver agents on your local network. It scans common LAN subnets (192.168.1.x, 192.168.0.x, 10.0.0.x, 10.0.1.x) by probing the `/health` endpoint with a 2s timeout.

### Auto-discovery (no agentUrl needed)

```typescript
YaverFeedback.init({
  authToken: 'your-token',
  trigger: 'shake',
  // No agentUrl — SDK discovers it automatically on first report
});
```

### Manual discovery

```typescript
import { YaverDiscovery } from '@yaver/feedback-react-native';

// Scan the network
const result = await YaverDiscovery.discover();
if (result) {
  console.log(`Found ${result.hostname} at ${result.url} (${result.latency}ms)`);
}

// Probe a specific URL
const agent = await YaverDiscovery.probe('http://192.168.1.42:18080');

// Connect and store for future sessions
await YaverDiscovery.connect('http://192.168.1.42:18080');

// Clear stored connection
await YaverDiscovery.clear();
```

## Connection Screen

A full-screen UI for discovering and connecting to a Yaver agent. Shows connection status, URL/token inputs, auto-discover button, and a Start/Stop testing toggle with recording timer.

```tsx
import { YaverConnectionScreen } from '@yaver/feedback-react-native';

function App() {
  return (
    <>
      <YourApp />
      {__DEV__ && <YaverConnectionScreen />}
    </>
  );
}
```

The connection screen auto-discovers agents on mount and provides:
- Green/red connection status indicator
- Text inputs for agent URL (pre-filled from discovery) and auth token
- "Auto-discover" button to scan the network
- "Connect" button for manual connection
- "Start Testing" / "Stop & Send" toggle with recording timer

## Three Feedback Modes

### Live

Events are streamed to the agent as they happen. The agent can respond with commentary in real-time.

```typescript
YaverFeedback.init({
  agentUrl: 'http://192.168.1.10:18080',
  authToken: 'your-token',
  feedbackMode: 'live',
  agentCommentaryLevel: 5, // Agent responds to what it sees
});
```

### Narrated

Record everything (screenshots, voice notes), then send the full bundle when you tap "Stop & Send". Good for walkthrough-style bug reports.

```typescript
YaverFeedback.init({
  agentUrl: 'http://192.168.1.10:18080',
  authToken: 'your-token',
  feedbackMode: 'narrated',
});
```

### Batch (default)

Collect everything and dump it all at the end when you tap "Send Report". The classic bug report flow.

```typescript
YaverFeedback.init({
  agentUrl: 'http://192.168.1.10:18080',
  authToken: 'your-token',
  feedbackMode: 'batch',
});
```

## Agent Commentary Levels

In live mode, the agent can comment on what it sees in real-time. Control verbosity with `agentCommentaryLevel` (0-10):

| Level | Behavior |
|-------|----------|
| 0 | Silent (default) |
| 1-3 | Only critical observations |
| 4-6 | Moderate commentary |
| 7-9 | Detailed observations and suggestions |
| 10 | Agent comments on everything it sees |

Commentary messages appear in a chat-like view inside the feedback modal.

## Voice-Driven Live Coding

In live mode, the feedback modal shows a "Speak to Fix" button. When you tap it:

1. Records your voice (uses `react-native-audio-recorder-player`)
2. Sends the recording to the agent as a `voice_command` event
3. The agent can transcribe and act on your instruction

This enables a hands-free workflow: see a bug, say what to fix, and the agent makes the change.

## Error Capture

Capture JS errors with full stack traces and attach them to feedback reports. The agent gets file names, line numbers, and optional context — goes straight to the right line.

**No conflicts with Sentry, Crashlytics, Bugsnag, or any other tool.** The SDK never auto-hooks global error handlers. You explicitly insert it into your error chain wherever you want.

### Option 1: Wrap the error handler (recommended)

```typescript
import { ErrorUtils } from 'react-native';

// Insert Yaver into the error chain — works alongside Sentry, Crashlytics, etc.
const existing = ErrorUtils.getGlobalHandler();
ErrorUtils.setGlobalHandler(YaverFeedback.wrapErrorHandler(existing));

// Other tools can still wrap after this. The chain stays intact:
// Sentry → Yaver wrapper → original RN handler
```

`wrapErrorHandler` returns a pass-through function that records the error in Yaver's ring buffer, then calls the next handler. It never swallows errors.

### Option 2: Manual attach (in catch blocks)

```typescript
try {
  await riskyOperation();
} catch (err) {
  YaverFeedback.attachError(err, {
    context: 'checkout-flow',
    userId: currentUser.id,
    cartItems: cart.length,
  });
  throw err; // still propagate
}
```

### What the agent receives

```json
{
  "errors": [
    {
      "message": "Cannot read property 'id' of undefined",
      "stack": [
        "at CheckoutButton.handlePress (CheckoutScreen.tsx:47)",
        "at processQueue (react-native/Libraries/Renderer/...)"
      ],
      "isFatal": false,
      "timestamp": 1742812200000,
      "metadata": {
        "context": "checkout-flow",
        "cartItems": 3
      }
    }
  ]
}
```

### API

| Method | Description |
|--------|-------------|
| `attachError(error, metadata?)` | Manually attach an error with optional context |
| `wrapErrorHandler(next?)` | Returns a pass-through handler for the error chain |
| `getCapturedErrors()` | Get the current error buffer |
| `clearCapturedErrors()` | Clear the error buffer |

## Configuration

```typescript
YaverFeedback.init({
  // Required
  authToken: 'your-token',                // Auth token for the agent

  // Optional
  agentUrl: 'http://192.168.1.10:18080',  // Agent URL (auto-discovered if omitted)
  trigger: 'shake',                        // 'shake' | 'floating-button' | 'manual'
  enabled: true,                           // Default: __DEV__ (auto-disabled in production)
  maxRecordingDuration: 120,               // Max recording duration in seconds (default: 120)
  feedbackMode: 'batch',                   // 'live' | 'narrated' | 'batch' (default: 'batch')
  agentCommentaryLevel: 0,                 // 0-10 (default: 0, only relevant in live mode)
  maxCapturedErrors: 5,                    // Error ring buffer size (default: 5)
});
```

## Trigger Modes

### Shake (default)

Shake the device to open the feedback modal. Uses the built-in shake event on iOS and `ShakeEvent` on Android.

```typescript
YaverFeedback.init({ authToken, trigger: 'shake' });
```

### Floating Button

A small draggable "Y" button overlays the app. Tap to open the feedback modal.

```tsx
import { FloatingButton, FeedbackModal, YaverFeedback } from '@yaver/feedback-react-native';

function App() {
  return (
    <>
      <YourApp />
      <FloatingButton onPress={() => YaverFeedback.startReport()} />
      <FeedbackModal />
    </>
  );
}
```

### Manual

Trigger feedback collection programmatically from anywhere in your app.

```typescript
import { YaverFeedback } from '@yaver/feedback-react-native';

// In a button handler, debug menu, etc.
YaverFeedback.startReport();
```

## P2P Client

For direct communication with the Yaver agent beyond feedback:

```typescript
import { P2PClient } from '@yaver/feedback-react-native';

const client = new P2PClient('http://192.168.1.10:18080', 'your-token');

// Health check
const isUp = await client.health();

// Get agent info
const info = await client.info();

// Upload feedback bundle
const reportId = await client.uploadFeedback(bundle);

// List builds
const builds = await client.listBuilds();

// Start a build
const build = await client.startBuild('ios');

// Get artifact URL
const url = client.getArtifactUrl(build.id);
```

## How It Works

1. User triggers feedback (shake, button tap, or manual call)
2. Feedback modal opens with mode selector (Live / Narrated / Batch)
3. User captures screenshots, records voice notes, or speaks commands
4. In live mode: events stream to the agent in real-time, agent can respond with commentary
5. In narrated/batch mode: everything is collected and uploaded on send
6. SDK uploads via multipart POST to `/feedback` (or streams to `/feedback/stream`)
7. The agent receives the report and can create a task from it

All data flows directly to your dev machine via the Yaver agent. Nothing goes through third-party servers.

## Development vs Production

By default, the SDK is only enabled when `__DEV__` is `true` (React Native's built-in dev mode flag). In production builds, the SDK is automatically disabled and all methods are no-ops.

Override this behavior:

```typescript
// Force enable in production (e.g., for internal beta testers)
YaverFeedback.init({ authToken, enabled: true });

// Disable at runtime
YaverFeedback.setEnabled(false);
```

## Requirements

- React Native >= 0.70
- React >= 18
- Yaver CLI running on your dev machine (`yaver serve`)
- Optional: `@react-native-async-storage/async-storage` for device discovery persistence
- Optional: `react-native-view-shot` for screenshots
- Optional: `react-native-audio-recorder-player` for voice notes

## API Reference

### YaverFeedback

| Method | Description |
|--------|-------------|
| `init(config)` | Initialize the SDK with agent URL, auth token, and options |
| `startReport()` | Manually trigger the feedback modal (auto-discovers if needed) |
| `isInitialized()` | Check if the SDK has been initialized |
| `setEnabled(bool)` | Enable or disable at runtime |
| `isEnabled()` | Check if the SDK is currently enabled |
| `getP2PClient()` | Get the P2P client instance |
| `getFeedbackMode()` | Get the current feedback mode |
| `getCommentaryLevel()` | Get the agent commentary level (0-10) |
| `attachError(error, metadata?)` | Manually attach an error with optional context |
| `getCapturedErrors()` | Get the current captured errors buffer |
| `clearCapturedErrors()` | Clear the captured errors buffer |

### YaverDiscovery

| Method | Description |
|--------|-------------|
| `discover()` | Try stored connection, then scan LAN |
| `probe(url)` | Probe a specific URL for an agent |
| `connect(url)` | Connect and store for future sessions |
| `getStored()` | Get cached connection from storage |
| `store(result)` | Cache a discovery result |
| `clear()` | Clear stored connection |

### P2PClient

| Method | Description |
|--------|-------------|
| `health()` | Health check (returns boolean) |
| `info()` | Get agent hostname, version, platform |
| `uploadFeedback(bundle)` | Upload feedback bundle via multipart POST |
| `streamFeedback(events)` | Stream feedback events in live mode |
| `listBuilds()` | List available builds |
| `startBuild(platform)` | Start a build for the given platform |
| `getArtifactUrl(buildId)` | Get download URL for a build artifact |

### Components

| Component | Description |
|-----------|-------------|
| `FeedbackModal` | Modal with mode selector, commentary, screenshots, voice |
| `FloatingButton` | Draggable overlay button to trigger feedback |
| `YaverConnectionScreen` | Full-screen device discovery and connection UI |

### Helpers

| Function | Description |
|----------|-------------|
| `captureScreenshot()` | Capture the current screen (requires `react-native-view-shot`) |
| `startAudioRecording()` | Start recording a voice note |
| `stopAudioRecording()` | Stop recording, returns `{ path, duration }` |
| `uploadFeedback(url, token, bundle)` | Upload a feedback bundle to the agent |

## License

MIT
