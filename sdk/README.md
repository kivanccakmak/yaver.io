# Yaver SDK

Embed Yaver's P2P AI agent connectivity into your own applications.

## Install

```bash
npm install yaver-sdk          # JavaScript / TypeScript
pip install yaver              # Python
go get github.com/kivanccakmak/yaver.io/sdk/go/yaver  # Go
flutter pub add yaver          # Flutter / Dart
```

C/C++: build the shared library from source (see below).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Your App                                │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ YaverClient  │  │YaverAuthClient│ │ Transcriber / Speech │  │
│  │  (tasks)     │  │ (auth/devices)│ │   (STT / TTS)        │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────────────────┘  │
│         │                 │                                     │
└─────────┼─────────────────┼─────────────────────────────────────┘
          │ HTTP            │ HTTP
          ▼                 ▼
┌──────────────┐    ┌──────────────┐
│ Yaver Agent  │    │    Convex    │
│ (desktop)    │    │  (auth/cfg)  │
│ port 18080   │    │  cloud       │
└──────────────┘    └──────────────┘
```

**Client-side SDK** — connects to a running Yaver agent over HTTP. The agent handles the AI runner (Claude, Codex, etc.), tmux sessions, and process management.

**Server-side** — the Yaver agent (`yaver serve`) is the server. The SDK is a client library. To run your own agent, use the `yaver` CLI binary.

## API Reference

### YaverClient (Task Management)

Connects to a Yaver agent's HTTP API on port 18080.

| Method | Description |
|--------|-------------|
| `Health()` | Check if agent is reachable |
| `Ping()` | Measure round-trip time |
| `Info()` | Get agent hostname, version, work dir |
| `CreateTask(prompt, opts?)` | Create a task (returns task ID, status) |
| `GetTask(taskId)` | Get task details (status, output, result, cost) |
| `ListTasks()` | List all tasks |
| `StopTask(taskId)` | Stop a running task |
| `DeleteTask(taskId)` | Delete a task |
| `ContinueTask(taskId, message)` | Send follow-up to a running task |
| `StreamOutput(taskId, interval?)` | Stream output chunks (poll-based) |

#### CreateTaskOptions

```typescript
{
  model?: string;           // "sonnet", "opus", "haiku", "o3-mini"
  runner?: string;          // "claude", "codex", "aider", "custom"
  customCommand?: string;   // arbitrary shell command (for runner="custom")
  speechContext?: {
    inputFromSpeech?: boolean;  // task was dictated
    sttProvider?: string;       // "on-device", "openai", "deepgram", "assemblyai"
    ttsEnabled?: boolean;       // user wants audio response
    verbosity?: number;         // 0-10: response detail level
  }
}
```

#### Task object

```typescript
{
  id: string;
  title: string;
  status: "queued" | "running" | "completed" | "failed" | "stopped";
  runnerId?: string;
  output?: string;           // raw streaming output
  resultText?: string;       // extracted clean result
  costUsd?: number;          // API cost
  turns?: Turn[];            // conversation history
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}
```

### YaverAuthClient (Auth & Devices)

Connects to the Convex backend for authentication and device management.

| Method | Description |
|--------|-------------|
| `ValidateToken()` | Verify auth token, get user info |
| `ListDevices()` | List registered devices (online/offline status) |
| `GetSettings()` | Get user preferences (runner, speech, verbosity) |
| `SaveSettings(settings)` | Update user preferences |

### Speech / Transcription

| Method | Description |
|--------|-------------|
| `RecordAudio()` | Record from microphone (Go/CLI only, uses sox/ffmpeg) |
| `Transcribe(audioPath)` | Transcribe audio file to text |
| `Speak(text)` | Read text aloud via OS TTS (Go/CLI only) |
| `CheckSpeechDeps()` | Check installed speech tools (Go only) |

Providers: `whisper` (free, local), `openai`, `deepgram`, `assemblyai`

## Connection Strategy

The SDK client connects via HTTP. Your app is responsible for determining the agent's address. Typical patterns:

```
1. Direct (LAN)     → http://192.168.1.x:18080  (fastest, ~5ms)
2. Relay             → via relay server           (NAT traversal, ~50ms)
3. Cloudflare Tunnel → https://tunnel.example.com (roaming)
4. Tailscale         → http://100.x.y.z:18080    (VPN mesh)
```

Use `YaverAuthClient.ListDevices()` to discover devices and their IPs. The device's `quicHost` field contains its last known IP.

### Callback Pattern

The SDK uses poll-based streaming (not WebSocket). For event-driven updates:

```python
# Python — callback on each poll
def on_update(task):
    print(f"[{task['status']}] {len(task.get('output', ''))} chars")

for chunk in client.stream_output(task_id):
    on_update(client.get_task(task_id))
    print(chunk, end="")
```

```go
// Go — channel-based streaming
for chunk := range client.StreamOutput(taskID, 500*time.Millisecond) {
    fmt.Print(chunk) // each chunk is new output since last poll
}
```

```typescript
// JS/TS — async generator
for await (const chunk of client.streamOutput(taskId)) {
  process.stdout.write(chunk);
}
```

```dart
// Flutter/Dart — Stream
await for (final chunk in client.streamOutput(taskId)) {
  stdout.write(chunk);
}
```

## Examples

See `sdk/examples/` for runnable examples:

| Example | Language | What it demonstrates |
|---------|----------|---------------------|
| `go/client_basic/` | Go | Connect, create task, stream output |
| `go/client_speech/` | Go | Record audio, transcribe, send as task, TTS |
| `go/client_advanced/` | Go | Auth, device discovery, verbosity, callbacks |
| `python/client_basic.py` | Python | Connect, create task, stream output |
| `python/client_advanced.py` | Python | Auth, device discovery, task management |
| `python/speech_transcribe.py` | Python | Task with verbosity control |
| `js/client_basic.ts` | TypeScript | Connect, create task, stream output |
| `js/client_advanced.ts` | TypeScript | Auth, device discovery, callbacks |
| `c/client_basic.c` | C | C shared library usage |

Run with:
```bash
export YAVER_URL=http://localhost:18080
export YAVER_TOKEN=your-token

# Go
cd sdk/examples/go/client_basic && go run .

# Python
python3 sdk/examples/python/client_basic.py

# TypeScript
npx tsx sdk/examples/js/client_basic.ts

# C (build shared lib first)
cd sdk/go/clib && go build -buildmode=c-shared -o libyaver.so .
cd sdk/examples/c && gcc -o client client_basic.c -L../../go/clib -lyaver
./client
```

## Testing

```bash
./scripts/test-suite.sh --sdk
```

Runs:
- Go SDK unit tests (mock server)
- C shared library build
- Python SDK unit tests (mock server)
- JS/TS typecheck + build
- Flutter/Dart analysis
- Go SDK integration tests (live agent)
- Python SDK integration tests (live agent)

## Links

- [npm: yaver-sdk](https://www.npmjs.com/package/yaver-sdk)
- [PyPI: yaver](https://pypi.org/project/yaver/)
- [Go: github.com/kivanccakmak/yaver.io/sdk/go/yaver](https://pkg.go.dev/github.com/kivanccakmak/yaver.io/sdk/go/yaver)
- [pub.dev: yaver](https://pub.dev/packages/yaver)
- [Yaver](https://yaver.io)
- [GitHub](https://github.com/kivanccakmak/yaver.io)
