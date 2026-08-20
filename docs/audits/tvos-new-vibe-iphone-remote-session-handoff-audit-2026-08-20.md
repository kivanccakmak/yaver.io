# tvOS New Vibe → iPhone Remote → Task Chat audit (2026-08-20)

## Requested outcome

The couch flow must be one continuous conversation:

1. On Apple TV: open **Chat** and select **New vibe**.
2. New vibe shows only the native tvOS keyboard (mirrored on iPhone); there is
   no Yaver-owned composer widget underneath it.
3. On the iPhone Apple TV Remote: tap the microphone, speak, confirm the
   transcription, then tap the blue **Done** key.
4. Exactly one task/session is created from that sentence.
5. The TV automatically opens that new task's chat, showing:
   - the submitted user message;
   - an honest running state (for example, “The runner is working…”);
   - the runner's streamed assistant output; and
   - a usable reply field for the next turn.

The iPhone Remote is only the Apple system keyboard/dictation transport. It
does not become the Yaver task UI and should not leave the user on an unrelated
blank remote sheet after Done.

## Evidence reviewed

- `IMG_6380.HEIC`: the physical TV is on **New vibe** with the focused prompt.
  Its selected context is `No project · OpenCode / DeepSeek V4 Flash · No MCP`.
- `ScreenRecording_08-20-2026 10-26-31_1.MP4`: the iPhone is the Apple TV
  Remote. It opens the keyboard and exposes the microphone/blue Done control,
  but the recording does not prove that Done creates or opens a Yaver task.
- `IMG_6383.HEIC`: after dictating “Hello”, disabling the prompt during
  `POST /tasks` closed the system keyboard and exposed the unwanted New vibe /
  “Starting session…” widget. The user explicitly rejected that intermediate
  surface; the keyboard must remain until Task Detail replaces it.
- The agent's actual route is `POST /tasks`, wired in
  `desktop/agent/httpserver.go`; it accepts an empty `workDir` and resolves the
  agent work directory/project rather than treating `No project` as an error.

## Implementation status

The 2026-08-20 audit reproduced the incomplete handoff and fixed it in the
current worktree. Earlier uncommitted tvOS work was preserved.

| Area | Existing implementation | Assessment |
|---|---|---|
| Task dispatch | `AgentClient.createTask` posts the prompt to `/tasks`, accepts both `taskId` and `id`, and locally enriches the minimal create response with the title. | Correct defensive shape: a successful task must not be reported as a decode failure. |
| Navigation | `TasksView` atomically replaces the keyboard host with `TaskDetailView` for the returned `TaskSummary`. | No app-owned screen is visible between the native keyboard and the newly-created conversation. |
| Conversation | `TaskDetailView` renders the task title as an initial **You** turn, names `queued`/`running`, streams groomed `/tasks/{id}/output` bytes into an assistant bubble, resumes with a byte cursor, and retains raw stdout behind Live console. | Matches the required user-visible task lifecycle. |
| No-project dispatch | `TaskComposerView` sends an empty per-task `workDir` when no project is selected. The agent's `TaskManager` falls back to its configured work directory and can auto-detect a project. | Not the cause of the observed handoff gap. |
| Build | `xcodebuild -project tvos/YaverTV.xcodeproj -scheme YaverTV -sdk appletvos -configuration Debug build CODE_SIGNING_ALLOWED=NO -derivedDataPath /tmp/yaver-tvos-audit-derived` succeeded. | Compiles; does not prove physical Siri Remote behavior. |

## Findings reproduced and fixed

### 1. Submission is tied to partial transcription, not only the user's Done action

`TaskComposerView` currently calls `create()` whenever `prompt` changes to two
or more characters. Siri dictation can commit incremental text. That can create
a task from the first partial phrase, before the user taps the blue Done key,
and the remaining speech never belongs to the task that was created.

**Required behavior:** keep the transcript visible while it is being composed;
submit once from the explicit Done/return/end-editing event, with an idempotency
guard so that multiple UIKit callbacks still produce one POST.

**Resolution:** removed prompt-change submission. `YaverDictationField` now
copies the UIKit field's final committed value before return/end-editing calls
the guarded `create()`. The HTTP-backed UI test proves zero creates before Done
and exactly one afterwards.

### 2. The current SwiftUI field dropped the established UI-test identity

The current `TextField` in `TaskComposerView` does not set
`accessibilityIdentifier("chat.prompt")`. `TVChatNavigationTests` uses that
identifier to verify the New vibe entry path and active text responder. The
test will no longer locate the field even though the app compiles.

**Required behavior:** restore that identifier and keep a test which proves the
field is the live text-input target.

**Resolution:** `chat.prompt` is restored on the actual bridged `UITextField`.
The simulator test proves that the tvOS keyboard opens automatically and typed
text reaches the active responder.

### 3. Dictation delivery has conflicting implementations and no physical closed loop

`YaverDictationField` exists to request a UIKit first responder after the view
is attached and forwards return/end-editing callbacks. The current composer
replaces it with a native SwiftUI `TextField`, citing a physical-TV observation
that the bridge lost text on the blue tick. Both approaches are present in the
worktree, but there is no passing physical-device arc proving which one carries
the iPhone Remote transcript *and* invokes the task handoff.

**Required behavior:** choose the implementation that passes the real device
loop. Do not infer success merely because the keyboard appears; the operation
is the single POST followed by the correct task detail screen.

**Resolution:** the UIKit bridge remains the single tvOS dictation path. The
native SwiftUI field was rejected by the first closed-loop run because it had
focus but never opened an editing session. The bridge commits final text at all
available Done delegate boundaries.

The first physical install then exposed a second, Continuity-only boundary that
the simulator cannot synthesize: the iPhone Remote's first blue button ended
microphone mode and committed the recognized phrase as one multi-character
replacement, but did not send Return, end editing, or close the keyboard. The
composer now treats that committed batch as the New vibe send action after a
short coalescing window. This behavior is enabled only for the initial composer;
the already-good follow-up reply path is unchanged.

### 4. Two Boolean destinations cancelled the new task's first SSE

The initial handoff popped the composer and pushed task detail with independent
`showComposer` / `showCreatedTask` state. SwiftUI mounted task detail more than
once during that transition; the disappearing instance cancelled the stream,
leaving a correct user bubble and Running state with no assistant bytes.

**Resolution:** `TasksView` now owns one `ChatDestination` item. Replacing
`.composer` with `.task(returnedTaskID)` is a single navigation-state update,
so the exact task detail and its SSE mount once.

### 5. Groomed SSE output was consumed and discarded

`AgentClient` decoded `output` events, but `TaskDetailView`'s callback did not
render their text. A runner could be working correctly while the conversation
never showed its answer.

**Resolution:** groomed text is a bounded live assistant turn. `since` resumes
from the server offset (or a UTF-8 byte fallback for older agents); `resume.full`
replaces retained content instead of duplicating it.

### 6. Task detail reopened the keyboard after a successful handoff

Every `YaverDictationField` coordinator initialized its last request to `-1`.
Consequently, the reply field's default request value `0` looked like a new
explicit request and immediately became first responder as task detail mounted.
That contradicted the required `IMG_6382.HEIC` destination: the conversation was
correct, but the system keyboard covered it again.

**Resolution:** request `0` now means no automatic editing request. New vibe
explicitly increments its request to `1` after attachment; Task Detail keeps
`0`, renders the Reply bar, and does not open the keyboard. The HTTP-backed UI
arc now asserts that the keyboard is absent at the destination.

### 7. Simulator focus assertions missed a physical focus blink

The first physical install confirmed that Right no longer escaped the Vibing
overlay and that Back exited correctly. It also exposed a false green: each
Right still played a focus click and briefly highlighted the DeepSeek chip
before SwiftUI reasserted the overlay. A final `hasFocus` assertion cannot see
that transient ownership loss.

**Resolution:** the overlay hit target is now a tvOS `UIButton` subclass that
consumes directional and Menu presses at UIKit's press boundary, before the
default focus engine navigates. Select still passes through as the primary
action. A focus-loss counter is exposed to the UI arc, which requires zero
transient losses after the repeated-arrow sequence. The next physical run
showed that Right could still produce the system focus sound even without
escaping; the focused UIKit environment now also vetoes every directional
`shouldUpdateFocus` request after delivering the arrow as remote input.

### 8. New vibe exposed an app-owned loading widget

`IMG_6383.HEIC` showed the dictated prompt, ellipsis, and “Starting session…”
after the system keyboard disappeared. The immediate cause was
`.disabled(creating)`: it resigned the real text responder while the task POST
was pending. More fundamentally, the user does not want a New vibe form at all.

**Resolution:** the composer widget, context summary, settings ellipsis, and
loading row were removed from `TaskComposerView`. It is now a visually empty
UIKit responder host. The native tvOS/iPhone keyboard remains first responder
while `POST /tasks` is pending; dismantling the host during the atomic task
navigation closes it. A failed POST presents only a retry/cancel alert.

## Verification evidence

- `TVChatNavigationTests.testDoneCreatesExactlyOneTaskAndOpensItsLiveConversation`
  passed on tvOS Simulator 26.5. Its real loopback HTTP/SSE fixture proves the
  bearer-authenticated create count, returned task ID, user bubble, running
  state, streamed assistant turn, reply field, and absence of a reopened
  keyboard. The fixture delays the create response and proves the native
  keyboard remains present while the POST is pending.
- `TVChatNavigationTests.testNewVibeIsOnlyTheSystemKeyboard` proves the native
  keyboard opens while `chat.task-settings`, “Start a session”, and “Starting
  session…” do not exist.
- `YaverDictationFieldTests` proves that a Continuity-style multi-character
  commit submits without Return and that the default request cannot open the
  Task Detail reply keyboard. `TVOverlayInputStateTests` passes all four reducer
  cases; the standalone overlay executable passes all nine checks.
- The first run failed because a SwiftUI field was focused but not editing; the
  restored UIKit responder made the keyboard assertion pass. A later run failed
  because the fixture used ambiguous close-delimited streaming; the fixture now
  speaks HTTP/1.1 chunked SSE and the full arc passes.
- After explicit user authorization, the first signed Debug build was installed
  and launched on the paired Apple TV. That physical run produced the two
  Continuity/focus findings above instead of being recorded as a false pass.
- The corrected second build succeeded, installed from the operation-specific
  `Debug-appletvos/Yaver.app`, and launched as `io.yaver.mobile` on the paired
  Apple TV at 11:20 local time (PID 1080). No TestFlight upload or App Store
  submission occurred. Its physical replay exposed the rejected widget in
  `IMG_6383` and a remaining Right-arrow focus sound; both are addressed in the
  next local build rather than recorded as a pass.
- An App Store archive for candidate build 293 validated successfully, but its
  upload was interrupted before acceptance when the new physical findings
  arrived. Do not treat validation as a TestFlight deployment.

## Non-goals

- Do not upload a known-broken candidate. Direct paired-TV and official
  TestFlight deployment are authorized for this session, but the hardware
  keyboard/arrow replay must judge the final candidate first.
- Do not treat a running tmux/terminal session as the chat handoff target; the
  task ID returned by `POST /tasks` is the authority for this flow.
- Do not replace the task detail with a raw terminal. The raw console remains
  progressive disclosure; the user-facing default is the task conversation.
