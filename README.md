# Developer Control Room

A local developer dashboard for reproducible browser failures. **Phases 1 and 2 of [the build spec](BUILD_SPEC.md) are implemented**: browser capture/replay, offline evidence, task presets, API response mutations, and fixture-based payment stress tests. Four modules are available; the remaining four are explicitly marked as roadmap items.

## Start here

Requires **Node.js 24+**, npm, and Git. Windows is the verified development platform. Linux/macOS use the same Node commands; native desktop packaging is not included yet.

```sh
npm ci
npx playwright install chromium
npm run build
npm start
```

Open **http://127.0.0.1:4310**. In another terminal:

```sh
npm run demo
```

In the dashboard, choose **Quick start → Connect demo project**, then **Run flow** on *Complete checkout*. It intentionally fails after `POST /api/confirm` returns 500. Open the run to inspect actions, requests, console output, assertions, masked screenshot, and sanitized trace. **Replay run** reproduces the same saved inputs. *Browse the storefront* provides a passing baseline.

On Windows PowerShell, use `npm.cmd` / `npx.cmd` if execution policy blocks npm's PowerShell shim.

### Development and desktop

```sh
npm run dev        # Node service :4310 + Vite :5173
npm run desktop    # builds, then opens the Electron dashboard
```

The desktop shell and browser dashboard use the same local service. Electron has Node integration disabled, context isolation enabled, and a sandboxed renderer. Its first launch may download the native runtime; `npx install-electron --no` installs it ahead of time. Dependencies are pinned exactly in `package.json` and `package-lock.json`.

The native smoke check is `npm run test:desktop` (two cold starts on ports 4320/4321). Run native Electron from a normal user terminal. Launching it inside the agent's restricted Windows tool environment reproduced an `0xC0000005` access violation; the same application runs outside that restriction with its own renderer sandbox still enabled.

## Use your own repository

Choose **Add project**, enter an existing directory and a localhost URL. Start that project's dev server yourself, or configure a command under Settings and add it to a task preset. Detection reports framework, package manager, and Git root. Any local HTTP frontend can be tested; there is no automatic React/Next.js component mapping in Phase 1.

Flows are portable JSON definitions executed through Playwright, not arbitrary JavaScript. Create/import them from Bug Time Machine, or with the CLI:

```json
{
  "name": "Sign in",
  "description": "Check a fixture account",
  "steps": [
    { "action": "goto", "url": "/login" },
    { "action": "fill", "label": "Email", "env": "DCR_TEST_EMAIL" },
    { "action": "fill", "label": "Password", "env": "DCR_TEST_PASSWORD" },
    { "action": "click", "role": "button", "name": "Sign in" },
    { "action": "assertText", "text": "Welcome back" }
  ]
}
```

Supported actions: `goto`, `click` (button/link/checkbox role + exact accessible name), `fill` (exact label + value **or** environment reference), `assertText` (exact visible text), `reload`, and `back`. Environment variables must be available to the running service or CLI. URL query data and sensitive literal inputs are rejected. Every replay stores the original flow, base URL, scenario version, browser version, Git commit/dirty state, and timestamps. Replay uses the current safety configuration and environment references; it does not restore the old repository commit or external server state.

## CLI

Run these from this repository root. CLI and dashboard share `.dcr/control-room.sqlite` unless `DCR_DATA_DIR` is set.

```sh
npm run cli -- demo
npm run cli -- projects
npm run cli -- add "C:/work/my-app" "My app" http://localhost:3000
npm run cli -- flows PROJECT_ID
npm run cli -- import PROJECT_ID path/to/flow.json
npm run cli -- run FLOW_ID
npm run cli -- replay RUN_ID
npm run cli -- inspect RUN_ID
npm run cli -- task-preview TASK_ID
npm run cli -- task-launch TASK_ID --approve-command
npm run cli -- setup-labs PROJECT_ID --confirm-fixtures
npm run cli -- fixtures PROJECT_ID
npm run cli -- capture PROJECT_ID FLOW_ID http://localhost:3000/api/products "Products"
npm run cli -- save-fixture PROJECT_ID fixture.json [FIXTURE_ID]
npm run cli -- save-scenario PROJECT_ID scenario.json [SCENARIO_ID]
npm run cli -- scenarios PROJECT_ID
npm run cli -- scenario SCENARIO_ID
npm run cli -- matrix PROJECT_ID SCENARIO_ID_1 SCENARIO_ID_2
```

Failed runs return exit code **1**, while persisting their evidence. Use `inspect` even when the target dev server is offline. Exported project configs can be registered with `import-project REPO_PATH CONFIG_PATH`. To remove a project and its evidence: `delete-project PROJECT_ID "Exact project name"`. This never deletes the repository.

## Phase 2: reliability labs

Select **Acme Storefront**, open **API Contract Ambush** or **Payment Stress Lab**, and confirm **Configure demo labs**. This configures only the included local demo: seven API cases, three payment cases, a products fixture, and their flows. Start the demo with `npm run demo`. Select cases and run a matrix, or run one case. Every case produces a normal run with expected/observed evidence, screenshot, sanitized trace, `scenario.json`, and replay command.

The faulty demo fails the six malformed/error-response cases and all three payment cases. The delayed-response case is a healthy control and passes. Restart the demo with `DEMO_FIXED=1` and run the same matrix: **all ten cases pass**.

### API Contract Ambush

Capture an exact **GET fetch/XHR** response from a chosen browser flow, or import/edit a JSON fixture. Capture is an explicit per-operation opt-in, independent of general `captureBodies`. Only successful JSON responses up to 64 KB are accepted. Sensitive values are redacted before saving; the capture links to its originating run.

Supported deterministic mutations: remove an optional field, set a field to null, empty an array, enlarge a string, return 401, return 500, and delay the fixture response (1–5000 ms). JSON Pointer paths select existing fields, such as `/items` or `/items/0/subtitle`. You choose fields that your app's contract defines as optional or nullable; there is no OpenAPI/schema inference. Cases require an exact expected visible text assertion. An unmatched interception or uncaught browser error cannot pass merely because that text is visible.

Enable the `api` module and configure **exact** `reliability.apiPaths` first. Auth/payment-related endpoints are denied. Mutation intercepts only the configured URL and GET fetch/XHR requests; other requests retain the normal project target policy. There is no wildcard route matching, POST/body matching, query-string fixture support, or randomized mutation. A fresh browser context is used for each case.

Editing a fixture does not change existing scenario snapshots. Edit/save the case to adopt the latest fixture. Editing a case increments its version; existing runs still replay their original fixture, mutation, flow, and expected outcome. Matrices freeze their case definitions and flows when started, then run cases in order. `completed` means all cases finished, not that all passed; the UI reports pass/fail counts separately.

### Payment Flow Stress Lab

The three supported cases are **Back after success**, **refresh after success**, and **duplicate confirmation**. A configured flow first confirms an isolated fixture order; the runner then performs the stress action and compares browser text, route, authoritative server state, and confirmation count. Success requires both the visible expected state and server `state: "confirmed", confirmationCount: 1`.

Before execution, project configuration must explicitly set both `testEnvironmentConfirmed` and `fixturesOnlyConfirmed`. Phase 2 supports the **fixture HTTP adapter only**: no real gateway integrations, card entry, payment credentials, or charges. Custom applications can implement the small [fixture protocol](docs/adr/002-reliability-scenarios.md). A read-only capability handshake must succeed before the runner creates or confirms any order. Adapter endpoints must stay under `/__fixtures/`, obey the project's allowed origins/ignore rules, and reject redirects. The saved adapter must still match the project's currently approved endpoint configuration on replay.

Every run gets a fresh `dcr-<run UUID>` order namespace with the same fixture amount/currency. This avoids cross-run interference; replay reproduces the scenario with a new isolated fixture order rather than reusing old server state. The associated flow uses `{orderId}` in its `goto` URL.

Example project configuration extension (start with the full settings object):

```json
{
  "modules": ["time-machine", "tasks", "api", "payments"],
  "reliability": {
    "apiPaths": ["/api/products"],
    "payment": {
      "testEnvironmentConfirmed": true,
      "fixturesOnlyConfirmed": true,
      "adapter": {
        "kind": "fixture-http",
        "createPath": "/__fixtures/orders",
        "statusPath": "/__fixtures/orders/{orderId}",
        "confirmPath": "/__fixtures/orders/{orderId}/confirm",
        "stateSelector": "[data-payment-state]",
        "expectedText": "Order confirmed"
      }
    }
  }
}
```

Only set those confirmation flags for your designated test/staging environment using fixture operations. Old projects are read with safe defaults: new modules disabled, no API allowlist, no payment confirmation.

## Configuration and privacy

Project Settings accepts validated JSON:

```json
{
  "environment": "local",
  "allowedOrigins": [],
  "modules": ["time-machine", "tasks"],
  "captureBodies": false,
  "ignoreUrls": [],
  "redactFields": [],
  "maskSelectors": ["[data-private]"],
  "commands": { "dev": "npm run dev" },
  "retentionDays": 30
}
```

- Local mode allows the chosen loopback origin. Additional loopback origins require explicit allowlisting. Remote targets require `test` or `staging` designation and exact `allowedOrigins`. Playwright blocks unmatched requests, service workers, and WebSockets. **HTTP redirects are rejected**, including redirects to otherwise allowed targets: Playwright does not re-run routing checks for redirect-chain requests. Use the final destination URL. Requests are fetched one hop and buffered before fulfillment, so streaming timing is not faithfully reproduced. There is no cloud or AI integration.
- The local HTTP service binds only to `127.0.0.1`, validates Host/Origin, rejects cross-site fetches, and requires a session token on every mutation. It is a personal local service, not a multi-user security boundary against other programs running as your OS user.
- Network evidence retains URL **without query/fragment**, method, status and duration. General JSON response bodies are captured only with `captureBodies: true` and under 64 KB. Explicit fixture capture saves only the selected response; mutation evidence includes the sanitized synthetic response it applied. Auth/cookie headers, token/password/card fields, email patterns, and custom `redactFields` are scrubbed.
- Playwright traces contain **sanitized action records only**. Network payloads, DOM snapshots, source files, trace filmstrips, and raw action logs are excluded. Resolved fill inputs are scrubbed from event/error text and trace data and masked when rendered as page text. Raw traces exist briefly in an OS temporary directory during sanitization and are removed in the runner's cleanup. A forced OS/process termination can interrupt that cleanup.
- Screenshots mask inputs, textareas, `[data-private]`, common email/card text, and `maskSelectors`. Automatic redaction is not a universal PII detector: mark private regions and add selectors before running against sensitive fixture data. Do not put credentials into commands, notes, URLs, or flow definitions; use environment references.
- Artifacts are stored under `.dcr/<project-id>/<run-id>/` with SHA-256 hashes and relative paths in SQLite. Saving settings prunes completed runs older than `retentionDays`. Removing a project requires its exact name and is blocked while its runs are active.
- **Export config** writes `.devcontrolroom.json` to the repository only on request and refuses to overwrite an existing file. No secrets store is needed in Phase 1 because the app only reads environment references.

## Tasks and continuity

Save a preset with repository-relative files, browser URLs, an optional configured command, a relevant flow, branch suggestion, and notes. **Preview launch** shows each action and the full command. A visible checkbox is required before a command runs. Source files are confined to the real repository path, including symlink resolution. Branches are **never switched automatically**; a dirty worktree displays an explicit pause message.

Launching opens saved URLs in the default browser and files through the VS Code URL handler. Task previews include source inspection, retry links, and the associated flow's latest run (or its saved definition when no run exists). Your OS must have the VS Code URL handler installed for editor opening. OS handler permissions can affect opening links. Launching the command does not establish that the dev server is ready; inspect the app URL before running a flow.

Project session notes and exact next-step text persist across restarts. Full Context Resurrection (recent-commit UI and resume integration) remains Phase 4.

## Verification

```sh
npm run build
npm test
npm run test:gate
npm run test:phase2
```

The focused tests cover migrations, persistence/deletion, redaction, trace sanitization, target/redirect restrictions, dirty-worktree/path handling, deterministic mutation semantics, JSON Pointer confinement, and payment approval. The Phase 1 gate starts a fixture server on **4411** and dashboard on **4311**, then checks:

1. A real failure has its preceding action, HTTP 500, console error, screenshot, trace and timeline.
2. Replay reproduces the failure even after changing the current flow definition.
3. Reopening SQLite and the dashboard restores evidence and notes with the fixture offline.
4. Seeded secrets are absent from JSON and unpacked trace artifacts.
5. The same saved flow passes after restarting the fixture with the correction enabled.
6. Dashboard desktop/mobile rendering, unauthorized HTTP writes, cross-site access, and confirmed deletion.

The Phase 2 gate uses **4416** and **4314**. It captures/redacts a real browser response; runs all ten cases against faulty and corrected implementations; checks immutable replay after edits, revoked payment approval, unmatched-mutation rejection, and artifact redaction; launches a matrix through the dashboard; checks desktop/mobile layout; and reopens completed scenario evidence offline.

Screenshots are written to `test-results/`. To manually run the corrected demo in PowerShell:

```powershell
$env:DEMO_FIXED='1'
npm.cmd run demo
```

Stop the faulty demo before starting the corrected one. In bash: `DEMO_FIXED=1 npm run demo`.

## Architecture and remaining work

See [ADR 001](docs/adr/001-local-modular-monolith.md), [ADR 002](docs/adr/002-reliability-scenarios.md), and [roadmap](docs/ROADMAP.md). This is a source-distributed application, not an installer release. Supported now: Chromium, JSON flows, local SQLite, local trace viewer, Electron shell, CLI, seven API mutations, and three fixture-only payment scenarios. Not implemented: interactive click recording, arbitrary Playwright script import, automatic source/component mapping, additional browsers, real payment gateway adapters, visual drift analysis, PR risk maps, full Context Resurrection, or the optional VS Code extension. Run/matrix scheduling is in-process; active work is not automatically resumed after a forced shutdown.

Technical references: [Node SQLite](https://nodejs.org/api/sqlite.html), [Playwright tracing](https://playwright.dev/docs/api/class-tracing), [local trace viewer](https://playwright.dev/docs/trace-viewer).
