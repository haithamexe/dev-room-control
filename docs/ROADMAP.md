# Incremental roadmap

The shared project → flow → scenario → run → artifact → finding model remains the core in every phase.

| Phase | Scope | Gate |
| --- | --- | --- |
| 1 — implemented | Local project registration, SQLite, CLI, Electron/browser dashboard, JSON flow editor/import, Playwright execution/replay, timeline/screenshots/action traces, findings, task presets, basic notes | `npm run test:gate` reproduces a real failure, replays immutable inputs, reopens offline evidence, checks redaction and the corrected fixture |
| 2 — implemented | Payment Stress Lab: Back/refresh after success and duplicate confirmation with fixture HTTP adapter. API Contract Ambush: captured/imported sanitized fixtures, seven deterministic mutations, editable cases and matrices | `npm run test:phase2`: faulty demo exposes nine defects; delay control passes; all ten cases pass on corrected fixture, with immutable replay and browser/server evidence |
| 3 - implemented | PR Risk Map import graph and route adapters; token-based Design Drift; opt-in DOM/component source bridge | Observed, static and heuristic relationships are distinct; every finding has inspectable evidence |
| 4 - implemented | Full Context Resurrection, richer task resume, optional VS Code extension | Reopening restores branch, failing flow, note and exact next step; editor command opens a referenced source file |

Near-term Phase 1 hardening: installer packaging and signing; background-worker isolation/cancellation; richer visual flow editor; crash recovery for interrupted runs; process output/status for task commands; retention scheduler; explicit framework detection overrides. Interactive recording and importing arbitrary Playwright scripts are not part of the current JSON-flow importer.

Modules declare commands and settings schemas alongside the existing catalog and return structured results plus core artifact references. They must preserve per-project target authorization and secret redaction before evidence persistence/export.

Phase 2 follow-ups: background/restart-resumable matrix scheduling, additional API methods and request matching, schema-aware mutation selection, and separately reviewed sandbox gateway adapters. Current payment support is fixture-only.
