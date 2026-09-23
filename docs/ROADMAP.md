# Incremental roadmap

The shared project → flow → scenario → run → artifact → finding model remains the core in every phase.

| Phase | Scope | Gate |
| --- | --- | --- |
| 1 — implemented | Local project registration, SQLite, CLI, Electron/browser dashboard, JSON flow editor/import, Playwright execution/replay, timeline/screenshots/action traces, findings, task presets, basic notes | `npm run test:gate` reproduces a real failure, replays immutable inputs, reopens offline evidence, checks redaction and the corrected fixture |
| 2 — implemented | Payment Stress Lab: Back/refresh after success and duplicate confirmation with fixture HTTP adapter. API Contract Ambush: captured/imported sanitized fixtures, seven deterministic mutations, editable cases and matrices | `npm run test:phase2`: faulty demo exposes nine defects; delay control passes; all ten cases pass on corrected fixture, with immutable replay and browser/server evidence |
| 3 - implemented | PR Risk Map import graph and route adapters; token-based Design Drift; opt-in DOM/component source bridge | Observed, static and heuristic relationships are distinct; every finding has inspectable evidence |
| 4 - implemented | Full Context Resurrection, richer task resume, optional VS Code extension | Reopening restores branch, failing flow, note and exact next step; editor command opens a referenced source file |

Original Phase 1 follow-ups (status below): installer packaging and signing; background-worker isolation/cancellation; richer visual flow editor; crash recovery for interrupted runs; process output/status for task commands; retention scheduler; explicit framework detection overrides. Version 0.2 adds interactive recording alongside the JSON-flow importer; arbitrary Playwright-script import remains separate future work.

Modules declare commands and settings schemas alongside the existing catalog and return structured results plus core artifact references. They must preserve per-project target authorization and secret redaction before evidence persistence/export.

Phase 2 follow-ups: background/restart-resumable matrix scheduling, additional API methods and request matching, schema-aware mutation selection, and separately reviewed sandbox gateway adapters. The optional Stripe test probe and current boundaries are described below.

## Local release 0.2.0

Implemented: unsigned Windows installer and portable ZIP with embedded runtime/demo/browsers; worker isolation, cancellation, timeout and resumable matrix plans; Chromium/Firefox/WebKit selection; environment-backed login; interactive recording with review; all ten fixture payment cases; optional Stripe test PaymentIntent probe; Vite development JSX metadata; explicit handler/state/request scope evidence; TypeScript JSONC/baseUrl/paths resolution. See [advanced workflows and limits](ADVANCED.md) and [local release](LOCAL_RELEASE.md).

Store product reserved via MSIX/PWA; submission, Store packaging and certification are deferred by the user. No code-signing certificate is needed for Store-managed MSIX signing after certification. The local EXE remains unsigned.

## Local release 0.3.0

Implemented the remaining non-Stripe workflow features: visual flow editing and supported-subset Playwright imports; dropdown/upload/iframe/popup recording and explicit navigation controls; five API methods, JSON body matching and schema suggestions; Webpack/Next development loader and optional React owner/state inspection; task command output/status/stop; scheduled retention with reference protection; framework/package-manager overrides. See ADVANCED.md for precise supported behavior and remaining boundaries. Stripe expansion and Store submission remain deferred.
