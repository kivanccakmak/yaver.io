# Istanbul Slush'D 2026 hackathon plan

This is a build-and-demo plan, not prebuilt hackathon application code. The
event app should start from a blank project at the venue. Yaver is the existing
open-source product and must be disclosed as such; the new application and its
event-specific workflow are built during the hackathon.

## The application: Adaptive Field Service

Build a mobile work-order workflow for people who work around real equipment.
It deliberately does not require the audience to understand wire harnesses,
factory software, or a regulated industry.

The first version has only one useful path:

1. Open a seeded work order for `Pump A-17`.
2. Enter a temperature, note, and pass/fail result.
3. Attach one photo and save the visit to Convex.
4. Ask a job-aware assistant a question and watch the answer stream in.

The assistant is deliberately small: it receives only the selected work-order
context, uses a server-controlled OpenRouter model, and persists only a final
answer if history is needed. Convex passes the upstream SSE stream through;
there is no long-poll loop and no database write per token.

Then introduce a believable customer rule change:

> For readings above 70°C, require two photos, add an Analyze photos action that
> returns a suspected cause and suggested spare part, require supervisor
> approval, mark the visit urgent in red, and add Turkish labels.

An authorized manager describes that change through Yaver from the running
application. Yaver gives the repository and request to Codex, keeps the coding
state visible, and offers the updated render when the task is complete. Enter a
75°C reading after the update to prove that the new rules are enforced, then
stream a visual diagnosis. The demo is not complete if it only changes labels,
colours, or prompt text.

Why this fits Yaver:

- The rule change is immediately understandable.
- The change crosses data, validation, workflow, and UI, so it is clearly more
  than remote configuration.
- It is hardware-adjacent without making the pitch depend on explaining a
  particular factory process.
- The app is useful before the change and visibly more capable after it.
- The same product story generalizes to field service, quality, logistics,
  healthcare operations, retail operations, and internal enterprise tools.

Use `Adaptive Field Service` as a descriptive working title. Do not spend the
event on a brand search or logo.

## Technical shape

- Expo + React Native for the application.
- Convex for work orders, visits, users, and supervisor approval state.
- OpenRouter for bounded, job-aware chat first and a vision-capable model only
  after the baseline loop works. The key stays server-side.
- Codex as the coding runner.
- Yaver as a library inside the app and as the feedback-to-code/render loop.
- One phone is the primary demo surface. Keep a browser build as the backup.

From the fresh app root, the intended integration path is:

```sh
yaver integrate --dir . --framework expo --verify web
```

With a configured local Yaver MCP server, the coding agent should prefer these
deterministic tools before writing domain UI:

```text
yaver_sdk_integrate { "directory": "/absolute/path/to/apps/mobile", "framework": "expo", "verify": "web" }
yaver_openrouter_integrate { "directory": "/absolute/path/to/monorepo", "include_mobile_client": true }
```

The OpenRouter seam uses one Convex HTTP action per generation, direct SSE, one
bounded per-user counter row, and at most one small budget mutation per accepted
request. Do not add a polling loop. Set low model/token/request limits and an
OpenRouter credit limit before the demo.

Do not add OAuth until the base loop is working. For a hackathon-only app, a
small seeded role selector is enough to demonstrate operator versus authorized
manager. If real authentication is required by the rules or judges, add it
after the adaptation loop is proven.

## Five-hour build order

### 10:30–11:00 — prove the skeleton

- Create the Expo and Convex projects from blank.
- Run the Yaver SDK and OpenRouter integration tools.
- Start the app on the real phone and make one Convex round trip.
- Stop immediately if the real device cannot load the baseline app; fix that
  path before adding UI.

### 11:00–12:00 — build one complete work order

- Asset selector with one seeded asset.
- Temperature, result, and one-photo fields.
- Save and show the new record.
- Add one bounded job-aware assistant card; no generic chat screen.
- Use a plain, readable design; no dashboard or navigation maze.

### 13:00–14:00 — prove Yaver's closed loop

- Open the Yaver feedback surface in the running app.
- Submit a harmless visible change first.
- Confirm that Codex receives the correct repository and that the phone can
  render the result safely.
- Only then reset to the baseline commit or blank-event state needed for the
  judged rule-change demonstration.

### 14:00–14:45 — implement the judged change through Yaver

- Submit the exact 70°C rule request.
- Show the task moving through queued/running/completed states.
- Render only after coding has completed.
- Verify the data shape, validation, 75°C path, and streamed diagnosis—not only
  the screen.

### 14:45–15:20 — harden the demo

- Make the required state and validation visually unmistakable.
- Seed a 65°C baseline inspection and prepare the 75°C changed-rule input.
- Record a short backup video of the successful full loop.
- Keep a known-good browser build available.

### 15:20–16:00 — rehearse and submit

- Rehearse to 2:45 so interruptions do not cause an overrun.
- Close unrelated windows and disable notifications.
- Put the exact change request in a local text file for reliable paste.
- Submit early enough to recover from an upload problem.

## Three-minute pitch and demo

### 0:00–0:20 — problem

“Operational software becomes wrong as soon as the customer's process changes.
Today even a small rule change turns into a ticket, a release, and another wait
for the people doing the work.”

### 0:20–0:45 — baseline

Open the 65°C work order, save the visit, and ask one job-aware question. Let a
short OpenRouter answer stream in; do not linger in a generic chat experience.

### 0:45–1:05 — change arrives

“The customer has changed the hot-equipment procedure. Above 70°C they now need
two photos, visual diagnosis with a suggested spare part, supervisor approval,
urgent handling, and Turkish labels.”

### 1:05–2:10 — Yaver and Codex

Open Yaver in the running app and submit the prepared request. Show that Codex
is changing the actual Expo/Convex product, not generating a mockup. Keep the
coding state visible, then render the completed update.

### 2:10–2:35 — proof

Enter 75°C. Demonstrate that the second photo and supervisor approval are now
required, the visit becomes urgent, and saving is blocked until the new rule is
satisfied. Run the new photo-analysis action and show its streamed diagnosis.

### 2:35–3:00 — platform

“We built Adaptive Field Service today. Yaver is the reusable layer: it lets
authorized users adapt delivered software through a coding agent, from the UI
where they discover the change.”

## One-line pitch

Adaptive Field Service is a work-order app that changes when the work does: an
authorized operator describes a new requirement in the running app, and Yaver
turns it into a verified Codex update on the real phone.

## Scope cuts

Cut these before cutting the end-to-end Yaver loop:

- Real barcode scanning; a tappable seeded asset is enough.
- Real supervisor notifications; approval state is enough.
- Multiple organizations or elaborate permissions.
- Maps, analytics, dashboards, offline sync, and report generation.
- Rule scraping, autonomous parts ordering, and real inventory integration.
- Live image analysis if—and only if—the baseline chat and Yaver adaptation
  loop are not already reliable; keep the two-photo/approval logic as fallback.
- Custom hardware integration.
- Logo, marketing site, and name exploration.

Do not switch to a todo list, contact-card exchange app, football-rules game, or
generic chatbot if time gets tight. Reduce the inspection app to one asset and
one rule, but preserve the before/change/after proof.

## Honest judging position

The entry is competitive only if the audience sees a real change reach the real
app. A prerecorded animation, colour-only change, or terminal-only coding run
weakens Yaver's central claim. Reliability and clarity are worth more than a
larger feature list.

Map the demo explicitly to the judging dimensions:

- **Usefulness:** changing operational workflows without a conventional release
  queue.
- **Execution:** a working Expo/Convex phone app whose validation and data model
  change.
- **Use of Codex:** Codex builds the app and performs a meaningful second change
  through Yaver.
- **Potential:** the same post-delivery adaptation layer applies far beyond the
  inspection example.

## Before the event

- Ask the organizers in writing whether pre-existing open-source SDKs and local
  MCP servers are allowed. Explain that the application begins blank and Yaver
  is the disclosed product/library being demonstrated.
- Test the exact laptop, phone, cable, hotspot, Codex login, and Yaver runner.
- Use a Node version accepted by the current Expo template; do not rely on an
  engine warning being harmless on event day.
- Validate the integration from a fresh user home without Yaver history.
- Confirm the complete phone feedback → Codex task → safe render loop.
- Prepare a local MCP configuration and a CLI-only fallback.
- Do not publish or deploy a new release without the owner's explicit approval.
