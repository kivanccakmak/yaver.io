# Browser Automation Queue

This directory is the shared, append-only handoff between coding threads and
the one browser coordinator. Cases and results are Markdown so a human or any
agent can inspect and append them without a database or service.

```text
browser-automation/
├── test-cases/YYYY-MM-DD/<case-slug>.md
├── results/YYYY-MM-DD/<case-slug>--<run-slug>.md
├── test-case-template.md
├── result-template.md
├── validate.mjs
└── open-session.mjs
```

## Thread workflow

1. Run the cheapest headless probe first. A browser must not be used to learn
   an API, process, dependency, or route fact.
2. Copy `test-case-template.md` into today's `test-cases/YYYY-MM-DD/`
   directory. Use one stable, descriptive slug and one file per independently
   runnable arc. Never edit another thread's case.
3. Set `Status` to `queued`. Describe named selectors, pixel evidence, the
   terminal signal, and the negative control that proves the guard can fail.
4. Run `npm run browser-queue:validate` from `e2e/`.
5. The browser coordinator drains the oldest queued date first with one browser
   session. Preview/dev-server state is shared and must not be driven by two
   sessions at once.
6. Copy `result-template.md` into `results/YYYY-MM-DD/` for every attempt.
   Results are immutable observations: a rerun gets another file rather than
   overwriting history.

## Closed-loop contract

- Mobile means RN-web in a fresh context using the full Playwright
  `iPhone 15 Pro` descriptor. Assert the actual viewport. A resized desktop
  page and the web dashboard are not substitutes.
- `MOBILE_WEB_URL` is required. If it is missing, the mobile arc is blocked;
  the launcher never silently falls back to another surface.
- Use named selectors and test IDs. Judge the terminal result as PIXELS,
  NAMED, or SILENT; SILENT fails.
- Keep credentials, tokens, account details, customer project names, machine
  addresses, and absolute home paths out of both Markdown and artifacts.
- Screenshots/traces belong in an untracked artifact directory. Result files
  may record a repo-relative artifact label, never an authenticated URL.
- A product failure adds or strengthens a regression arc. A harness failure
  fixes the harness and keeps the assertion.

## Commands

```bash
cd e2e
npm run browser-queue:validate
MOBILE_WEB_URL=http://127.0.0.1:8081 npm run browser-queue:open
```

The launcher uses an isolated dated Chromium profile by default and takes an
owner-only lock so another coordinator cannot start concurrently. Set
`E2E_PROFILE` only when intentionally reusing a dedicated authenticated test
profile. Stop it with Ctrl-C; it releases the lock and closes Chromium.
