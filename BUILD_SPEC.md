# Developer Control Room
## Product and implementation specification for Astra

**Status:** Build brief, version 1  
**Audience:** Engineering agent implementing the product  
**Goal:** Build one local-first developer application containing eight practical productivity tools. The tools share projects, runs, evidence, and navigation. Each module can be enabled independently. The experimental “chaos mode” ideas from the earlier conversation are excluded.

## 1. Product definition

Developer Control Room helps a programmer understand a running application, reproduce failures, test fragile flows, inspect UI consistency, understand change impact, and resume work quickly. The initial target is a solo developer working on React/Next.js frontends with Node APIs, especially checkout and other stateful flows. The core must be useful without an AI provider, a cloud account, or a browser extension.

**One system, four pieces:**

1. **Desktop dashboard:** project list, flows, recordings, results, issue details, and settings.
2. **Local project service/CLI:** reads permitted repository files, Git history, routes, and configuration; runs analysis commands.
3. **Browser runner:** Playwright scenarios, traces, screenshots, and network observations.
4. **Optional VS Code extension:** editor commands and links into the dashboard. A browser extension is optional only if later use cases cannot be met through the runner.

Use a modular monolith and a local SQLite database. Start with a TypeScript monorepo, React dashboard, Node service, Playwright worker, and a thin desktop shell (Electron is acceptable). Keep core operations callable from a CLI so the UI and editor integration use the same commands. Choose and record exact dependency versions at implementation time; this document does not prescribe versions.

### Principles

- **Evidence over guesses:** Every finding links to a run, file, request, screenshot, trace, or Git change. Label inferred relationships as inferred.
- **Replayable:** Store scenario definitions and deterministic inputs so a failure can be rerun.
- **Non-destructive defaults:** Run against localhost or an explicitly designated test/staging environment. Payment tests use sandbox credentials and fixtures; never trigger real charges by default.
- **Local and private:** Store data locally; redact secrets and personal data before persistence or AI export. Network access and AI analysis require explicit per-project configuration.
- **Useful without AI:** AI may summarize evidence but must not be required for recording, analysis, scenarios, or navigation.

## 2. Shared user workflow

1. Add a local repository, choose its development URL, and configure start/test commands.
2. Detect framework, routes, package manager, and Git root; let the user correct detection.
3. Create a **flow** such as “complete checkout,” consisting of browser steps and optional assertions.
4. Run or record the flow. Collect screenshots, browser console entries, navigation, selected network metadata, and Playwright trace.
5. Open the run: see a timeline, observed failure, relevant route/component candidates, and links to source files.
6. From the run, invoke another module: replay a bug, stress a payment flow, mutate an API response, inspect UI drift, or examine affected code.
7. Preserve a compact project context snapshot so the next work session begins at the same point.

A **project** owns configuration; a **flow** defines actions and expected outcomes; a **scenario** adds controlled conditions; a **run** is one execution; an **artifact** is evidence from a run; a **finding** is a human-readable observation with evidence links. Reuse these concepts across all modules.

## 3. The eight modules

### 3.1 Bug Time Machine

**Problem:** A bug report says what happened but not the sequence that caused it.

**Behavior:** Record and replay browser flows. Show ordered actions, URL changes, console errors, failed requests, screenshots, and trace snapshots on a shared timeline. Permit a developer to mark an interesting moment and copy a reproduction command. Include a “replay this run” action using the saved flow and scenario configuration.

**MVP:** Import or execute a Playwright flow; persist its trace and normalized event timeline; display failure details and source links when known. Capture request URL pattern, method, status, duration, and a redacted body only when explicitly enabled. Provide a reproducible CLI command.

**Acceptance:** A deliberately failing route produces a run with the action before failure, failed request or console error, screenshot, trace link, and a replay command that reproduces the scenario locally.

### 3.2 Payment Flow Stress Lab

**Problem:** Browser history, retries, delayed callbacks, and duplicate events can leave checkout UI in stale or contradictory states.

**Behavior:** Run a matrix of controlled checkout scenarios: refresh before/after payment confirmation; Back and Forward after success; duplicate webhook/callback; delayed response; failed response; reopening the success URL; two tabs; and returning after session expiry. For each case display browser state, server-reported payment state, route, and assertion result. Allow a project-specific adapter for creating sandbox orders and reading their authoritative status.

**MVP:** A configurable test-flow template with **three** supported scenarios: Back after success, refresh after success, and duplicate confirmation. A fixture adapter stands in for a real gateway. Extend scenarios after the assertion model is stable.

**Safety:** Require explicit confirmation in project configuration that the target is test/staging and the payment adapter uses sandbox credentials or fixtures. Never store payment credentials or full card data in artifacts. Do not claim a payment succeeded based solely on the browser URL.

**Acceptance:** Given a demo checkout with a known stale-state bug, the lab shows which scenario fails, the action sequence, expected state, observed state, and evidence from browser and server checks.

### 3.3 Design Drift Detector

**Problem:** A UI slowly accumulates inconsistent spacing, colors, typography, and component variants.

**Behavior:** Scan selected pages and report outlier computed styles relative to an imported token file or a manually approved baseline. Group similar elements and show screenshots with highlighted locations. Let users accept a value as intentional, suppress a specific finding, or jump to a likely source file.

**MVP:** Support CSS custom properties and a JSON token mapping. Check colors, spacing, font size, border radius, and button variants on selected routes. Compare computed values with explicit tolerances; do not silently treat every distinct value as a defect.

**Acceptance:** A page with one intentionally wrong button color and one spacing value outside configured tolerance yields two inspectable findings with selectors, screenshots, observed values, expected tokens, and no duplicate findings for repeated instances.

### 3.4 “Why Is This Here?”

**Problem:** Seeing an element on screen does not immediately reveal its owner or behavior.

**Behavior:** Select a page element and show likely React component, DOM attributes, styling sources, enclosing route, related state or event handler when instrumented, and network requests correlated with the interaction. Open source locations in the editor. Show confidence and provenance for every relationship.

**MVP:** In development mode, add an opt-in instrumentation bridge that attaches stable source/component metadata where feasible. Connect a selected element to its DOM attributes, computed style, route, and component/source candidates. An optional VS Code command opens the candidate source file. Do not promise accurate state ownership or API causality without additional instrumentation.

**Acceptance:** Selecting an instrumented component identifies its source file and route; selecting an uninstrumented element still displays DOM/style facts and clearly marks any file mapping as uncertain.

### 3.5 API Contract Ambush

**Problem:** Happy-path API fixtures conceal missing fields, long text, expired sessions, and unexpected response shapes.

**Behavior:** Capture selected development responses, redact them, and create editable mutation cases. Initial cases: missing optional field, `null` in a nullable field, empty list, oversized string, 401 response, 500 response, and delayed response. Replay one mutation or a matrix while running a chosen flow. Show UI outcome and failed assertions.

**MVP:** Intercept `fetch`/XHR through Playwright routing, save a sanitized fixture, apply deterministic JSON mutations, and rerun a flow. Scope routes by allowlist to avoid modifying auth or payment endpoints accidentally.

**Acceptance:** A mutation replacing a list with `[]` visibly changes the test response, reruns the flow, and records whether the page renders its empty state or crashes.

### 3.6 Context Resurrection

**Problem:** Resuming a project takes time because the developer must reconstruct what changed and what is unfinished.

**Behavior:** Generate a session snapshot showing active branch, uncommitted files, recent commits, last runs, unresolved findings, pinned notes, and a proposed next action. Let the user edit or discard the proposed action. Support a one-click “resume” that opens a saved task workspace.

**MVP:** Git status, recent commits, user-authored notes, last run, and pinned next step. AI summaries are optional and must quote the underlying evidence; do not infer an intention from Git activity as fact.

**Acceptance:** Closing and reopening the app restores the project’s branch, last failing flow, pinned note, and exact next-step text without requiring an AI service.

### 3.7 PR Risk Map

**Problem:** A small diff can affect routes and dependencies that are hard to see in a plain file list.

**Behavior:** Compare a branch or working tree against a chosen base. Show changed files, imports/dependents, routes that reference affected components, related tests, and runs covering those routes. Separate **directly changed**, **statically dependent**, and **heuristically related** results. Export a compact review summary.

**MVP:** TypeScript/JavaScript import graph, Next.js/React Router route adapters where detected, Git diff, and test file associations by explicit imports or naming convention. Flag dynamic imports or runtime wiring as coverage gaps.

**Acceptance:** Editing a shared button component identifies direct file changes, importing components, affected known routes, and any associated tests, with a clear distinction between confirmed and inferred links.

### 3.8 Task-to-Workspace Launcher

**Problem:** Repeated tasks require reopening the same files, URL, commands, and notes.

**Behavior:** Save task presets containing a project, branch suggestion, source files, browser URLs, terminal commands, relevant flows, and notes. Launch a preset with a preview of proposed actions. Reuse a preset from Context Resurrection, a finding, or a risk-map route.

**MVP:** Presets that open files/URLs, start configured commands, and display the relevant flow and notes. Do not auto-switch branches when uncommitted changes exist; require a visible choice. Commands are stored per project and displayed before first execution.

**Acceptance:** A “fix checkout” preset opens the checkout route and named files, starts the approved development command, and shows the associated failing flow. It safely pauses branch switching when the working tree is dirty.

## 4. Architecture and data contracts

Suggested workspace layout:

```text
apps/desktop/                 dashboard and desktop shell
apps/cli/                     headless commands
apps/vscode/                  optional editor extension
packages/core/                project, flow, scenario, run, finding types
packages/storage/             SQLite schema, migrations, artifact references
packages/runner/              Playwright execution and trace normalization
packages/repo-analysis/       Git, imports, routes, source mapping
packages/modules/             independent module services
packages/ui/                  shared interface components
examples/demo-app/            intentionally faulty demo flows
```

**Core tables/records:** `projects`, `environments`, `flows`, `scenarios`, `runs`, `events`, `artifacts`, `findings`, `suppressions`, `notes`, `task_presets`, `repo_snapshots`. Use stable IDs and timestamps. Artifacts reside in a project-specific local directory; SQLite stores relative paths, media types, hashes, and redaction status. A run records Git commit/dirty status, base URL, scenario version, browser version, and start/end time. Never depend on a live server to inspect a completed run.

**Module contract:** Each module registers a name, settings schema, commands, optional UI panels, and findings. Commands return structured data plus artifact references. Modules share the core records and cannot write arbitrary fields into another module’s records. Events such as `run.completed`, `finding.created`, and `repo.changed` enable integrations without tight coupling.

**Project configuration:** Store nonsecret config in a project-local file (for example `.devcontrolroom.json`) so it can be versioned if the user chooses. Keep credentials in OS-backed secret storage or environment variables; configuration contains references only. Allow a per-project ignore list for URLs, paths, headers, and body fields. Default redaction should cover authorization/cookie headers, tokens, passwords, card details, and obvious personal identifiers.

**Boundaries:** The desktop app coordinates work; the local service owns files and Git; the runner owns browser sessions. Do not execute arbitrary model-generated shell commands. The VS Code extension talks to the same local service and remains optional. AI integrations, if added, consume redacted evidence via a user-initiated action.

## 5. UX requirements

- Home: project cards, current branch, recent runs, open findings, and resume action.
- Project: tabs for Flows, Runs, Findings, UI Drift, API Fixtures, Risk Map, and Tasks. Only show configured modules.
- Run details: a chronological timeline; screenshot/trace viewer; requests and console; assertions; linked findings; “rerun” action.
- Finding details: expected versus observed, exact evidence, reproduction command, source candidates, suppression, and status.
- Settings: test environment designation, allowlisted domains, redaction rules, retention period, module toggles, and executable commands.
- Accessible keyboard navigation and readable dark/light themes; keep dense evidence panels usable on a laptop screen.

## 6. Build sequence and completion gates

### Phase 1 — Foundation and usable vertical slice

Create the monorepo, local project store, migrations, desktop dashboard, CLI, Playwright runner, demo app, flow editor/import, run timeline, trace/artifact viewer, and redaction pipeline. Ship Bug Time Machine and the basic Task-to-Workspace Launcher. **Gate:** a user can add a repo, run a demo flow, inspect a failing trace, replay it, and reopen the same evidence after restarting.

### Phase 2 — Reliability tools

Add API Contract Ambush and Payment Flow Stress Lab with fixture adapters and the first three payment scenarios. **Gate:** deterministic mutation and payment tests fail on intentionally defective demo implementations and pass on corrected ones, with expected/observed states recorded.

### Phase 3 — Code and UI understanding

Add PR Risk Map, Design Drift Detector, and the opt-in “Why Is This Here?” bridge. **Gate:** mappings distinguish observed facts from guesses, and each finding opens the right evidence or source candidate.

### Phase 4 — Continuity and integration

Complete Context Resurrection, improve task presets, and add the optional VS Code extension. **Gate:** reopening a project restores the correct task context; an editor command opens a file referenced by a run or finding.

## 7. Testing and release criteria

Use the demo app as an integration fixture with known failures: an API empty-state crash, inconsistent button token, shared component affecting two routes, and stale checkout history behavior. Add targeted tests for data migrations, fixture redaction, scenario determinism, import graph classification, and dirty-worktree handling. Run end-to-end tests for the phase gates above. Verify that a run remains viewable with the dev server offline and that deleting a project removes its stored artifacts after a clear confirmation.

A release is ready when setup works from a clean clone, the documented demo flows complete on a supported developer machine, artifacts contain no seeded secrets, failures are reproducible, and the README explains installation, project configuration, commands, supported frameworks, and known limits.

## 8. Instructions to Astra

Implement **Phase 1 first** as a working vertical slice. Produce runnable code, a demo app, installation instructions, and a concise architecture decision record. Treat Phases 2–4 as the implementation roadmap; build them incrementally without replacing the shared core. Where this brief leaves a choice open, choose the simplest maintainable local implementation and document the decision. Do not represent optional or heuristic analysis as fully reliable. At each phase, demonstrate its gate with the demo app and report what works, what remains, and exact commands to reproduce the result.
