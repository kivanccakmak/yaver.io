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
composer now treats that committed batch as the send action after a short
coalescing window. The same contract is enabled on the persistent Task reply
field. When Task Detail clears an accepted phrase, the bridge reopens its
duplicate-submit latch so a second and later iPhone Remote dictation can send
without closing the keyboard or requiring a second microphone press.

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

### 9. Task replies did not carry the Continuity Done contract

`TaskDetailView` used the shared UIKit field but did not enable its
multi-character Continuity submission path. On iPhone Apple TV Remote, Done
could commit a complete follow-up without emitting Return/end-editing, leaving
the words visible but unsent.

**Resolution:** Task replies now use the same coalesced Done boundary as New
Vibe, keep the keyboard active after submission, and reset the one-shot
duplicate guard only when the accepted text is cleared. The loopback UI arc now
asserts exactly one authenticated `POST /tasks/{id}/continue` for the next turn.

### 10. A queued follow-up could disappear when the SSE channel rolled over

A live continuation can replace the task's runner process/output channel. The
old SSE may end with `queued` or `running`; treating that frame as terminal
left the TV attached to an obsolete channel.

**Resolution:** tvOS refreshes the task after `done` and reattaches with its
groomed/raw byte cursors whenever the refreshed status is still coding. One
conversation can therefore carry repeated turns without duplicate scrollback.

### 11. Runner questions were decoded as the wrong wire type and dropped

`TaskOutputEvent.question` was a string even though the agent emits a structured
`AgentQuestion` object. JSON decoding failed for the entire event, and tvOS had
neither a question card nor an answer route.

**Resolution:** Task SSE now decodes and renders text/choice questions inline,
posts answers to `/tasks/{id}/answer`, preserves half-written answers across SSE
replay, and closes the card when another device answers or the ask is cancelled.
Secret questions remain on phone/desktop: a TV is a shared-room surface, and
the agent rejects secret answers from a server-validated `tv` session scope.

### 12. A safely parked follow-up looked like a failed send

When runner authentication is unavailable, the agent can return 409 while
retaining the user's prompt for automatic replay. tvOS discarded the structured
`parked`, `reauthable`, `runner`, and reason-code fields, rolled back the visible
turn, and restored the composer—inviting the same work to run twice.

**Resolution:** the TV keeps the accepted turn, says that the message is saved,
and offers runner sign-in only for reason codes where sign-in can help. Sandbox
and transient failures never receive a dead OAuth button.

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
  commit submits without Return, a persistent field can submit another phrase
  after the host clears the first, and the default request cannot open the Task
  Detail reply keyboard. `TVOverlayInputStateTests` passes all four reducer
  cases; the standalone overlay executable passes all nine checks.
- The Tasks regression fixture now also covers one authenticated follow-up and
  an inline choice question answered through the real REST/SSE contract. On the
  current Mac, `build-for-testing` succeeds for the generic tvOS Simulator
  destination, compiling the app, unit tests, and UI tests. No concrete tvOS
  Simulator device is installed, so these new UI arcs were compiled but not
  executed in this worktree; the paired physical TV was not mutated for this
  implementation pass.
- Focused Go tests prove the scoped TV allow-list admits only create, continue,
  fork, and answer task mutations; ordinary questions resolve, while secret
  questions return the stable `auth.session.scope_denied` code and remain
  pending for a private surface.
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
- The earlier candidate-293 upload was interrupted before acceptance when the
  new physical findings arrived. After the keyboard-only and focus-veto fixes
  landed in `33bfc3efc`, the canonical `./deploy/deploy.sh tvos` path archived,
  exported, validated, and uploaded a fresh build 293 from a clean worktree.
  App Store Connect accepted that upload without errors on 2026-08-20; it is an
  official TestFlight delivery, subject to Apple's normal processing time.
- The latest build was not reinstalled directly on the paired Apple TV because
  the Mac and TV were no longer on the same network. The 11:20 direct install
  therefore remains the last local-device build; do not conflate it with the
  accepted TestFlight build.

## Non-goals

- Do not call simulator focus assertions proof of the physical Right-arrow
  sound fix. The final build includes the UIKit focus-update veto and has been
  delivered to TestFlight, but that specific hardware behavior still needs a
  physical replay after Apple finishes processing it.
- Do not treat a running tmux/terminal session as the chat handoff target; the
  task ID returned by `POST /tasks` is the authority for this flow.
- Do not replace the task detail with a raw terminal. The raw console remains
  progressive disclosure; the user-facing default is the task conversation.
