# ADR 001: Local TypeScript modular monolith

Status: accepted, 2026-09-23.

## Context

The supplied brief explicitly asks for Phase 1 before incrementally implementing the other modules. It prioritizes reproducible evidence, offline inspection, non-destructive defaults, and a shared CLI/service model. The repository is new and must run without a cloud account or AI provider.

## Decision

Use npm workspaces, TypeScript, React/Vite, a loopback Node HTTP service, Node's built-in SQLite API, and Playwright Chromium. Electron is a thin sandboxed shell over the same dashboard. Node 24+ avoids a native SQLite addon/toolchain requirement. Exact resolved package versions are committed in the lockfile.

Boundaries:

| Package | Owns |
| --- | --- |
| `packages/core` | Zod contracts, module catalog, shared data types, redaction/target policies |
| `packages/storage` | SQLite migration, indexed project/run references, artifact hashes, retention and deletion |
| `packages/repo-analysis` | Read-only Git metadata, package/framework detection, safe source-path resolution |
| `packages/runner` | Isolated browser contexts, flow execution, events, screenshots, trace sanitization |
| `packages/modules` | Shared command service and task/flow/project operations; `run.completed` event |
| `apps/service` | Loopback HTTP API, host/origin/token checks, artifact delivery and production UI |
| `apps/cli` | Headless commands calling the same module service |
| `apps/desktop` | React dashboard and minimal Electron host |
| `examples/demo-app` | Intentionally faulty/correctable checkout fixture |

SQLite version 1 creates the core tables with indexed project/run columns and validated JSON records. This permits module evolution without premature relational schemas; later migrations can promote query-heavy fields into typed columns. IDs are UUIDs. Artifact paths are local relative paths; records include media type, SHA-256, and redaction status.

Flow definitions are a restricted JSON DSL, executed using Playwright role/label locators. This is the simplest safe importable format for Phase 1 and preserves deterministic input snapshots. Executing arbitrary uploaded scripts would enlarge the trust boundary considerably. Replay cannot restore an external API's state or old checkout code, so the UI and docs do not claim full historical environment reconstruction.

The runner shares the Node process but owns its browser contexts and allows at most two concurrent runs per service instance. A separate worker process can be introduced behind `executeRun` when cancellation/parallel scale becomes necessary. No network worker protocol or queue service is needed for a solo developer's first slice.

Trace privacy takes priority over full DOM snapshot fidelity: sanitize action records and remove all trace network/resources. Preserve a separately masked final screenshot and normalized event timeline. The built-in viewer still explains action timing/errors, while our dashboard supplies normalized network facts. Body capture is opt-in. Environment references keep secrets out of saved flow definitions.

Task commands are project-configured and previewed before execution. File reads resolve symlinks and stay within the registered repository. Branch suggestions are advisory; no branch switching or stash manipulation is implemented.

## Consequences

- Works locally without cloud accounts, native database compilation, or an AI provider.
- A completed run is inspectable without the target application running.
- The CLI and UI use one implementation of project, flow, run and task operations.
- No DOM snapshots in stored traces; no automatic component ownership claims in Phase 1.
- Configuration supports known redaction rules, not arbitrary personal-data detection in pixels.
- Source distribution is runnable; signing, installers, updater, per-module plugin APIs, and the optional VS Code extension remain future work.
