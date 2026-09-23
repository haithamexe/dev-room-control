# ADR 002: Reliability scenarios reuse the run and evidence model

Status: accepted, 2026-09-23.

## Decision

Extend the existing modular monolith with API and payment scenario definitions, rather than introducing a separate test database or runner. SQLite migration 2 adds `api_fixtures` and `matrices`; the existing `scenarios`, `runs`, events, artifacts, and findings remain shared. Configurations from Phase 1 are parsed with new safe defaults on read.

`ReliabilityCommands` validates project ownership and policies, creates versioned scenario definitions, and freezes execution plans for matrices. Each execution snapshots its flow and scenario into a normal run. API snapshots embed the sanitized response body, URL/method/status, mutation inputs and expected text. Payment snapshots embed the selected case and approved fixture adapter. Replay rechecks current permissions before using these saved inputs.

Browser routing recognizes exact GET fetch/XHR URLs. Capture persists one selected successful JSON response after redaction. Mutation fulfills with a deterministic synthetic JSON/status/delay response. A match counts only after the browser finishes receiving the response; outcome evaluation waits for that delivery and browser event processing. Uncaught errors observed before teardown also fail the scenario. JSON Pointer traversal only touches existing own properties; prototype-related segments are rejected.

Payment scenarios share Playwright actions and artifacts but query the fixture server directly for authoritative state. Browser text and route are observations, never payment truth. The amount/currency are constant fixture inputs; each run uses a fresh order ID to isolate state. No payment credentials or real gateway SDKs are introduced.

## Fixture HTTP adapter protocol

All responses must be successful JSON with `X-DCR-Fixture: 1`. Paths must start with `/__fixtures/`, must satisfy current project target and ignore policies, and cannot redirect.

| Operation | Default path | Request / response |
| --- | --- | --- |
| Capability handshake | `GET /__fixtures/orders` | Return `{ "protocol": "dcr-fixture-v1" }`; checked before any write |
| Create isolated order | `POST /__fixtures/orders` | Receive `{ "id": "dcr-<UUID>", "amount": 3200, "currency": "USD" }`; return the same `id` |
| Read authoritative status | `GET /__fixtures/orders/{orderId}` | Return `{ "id": "...", "state": "pending" or "confirmed", "confirmationCount": 0 or 1 }` |
| Repeat confirmation | `POST /__fixtures/orders/{orderId}/confirm` | Receive `{ "eventId": "confirmation-<orderId>" }`; process idempotently |

The normal browser flow must send the same fixture event ID when confirming. A duplicate case sends that event again. The lab first checks the baseline confirmation count is 1, performs the selected case, and then requires the final server state to remain confirmed with count 1. It also requires configured `expectedText` to be visible and records the text of `stateSelector` plus current route.

The adapter is intended for deliberately designated local/test/staging fixtures. The handshake is an explicit protocol agreement, not proof that arbitrary third-party code cannot have side effects. No production payment adapter is bundled or claimed.

## Tradeoffs

- Captures are GET JSON only, up to 64 KB; no wildcard/query/body matching or schema inference.
- Mutations are deterministic and limited; optional/nullable field selection is supplied by the developer.
- HTTP redirects and streaming responses retain Phase 1 compatibility limits.
- Matrices run sequential cases with the service's existing two-run cap. They survive as completed records, but scheduling is not restart-resumable.
- The UI marks imported fixtures separately from real browser captures. Both become immutable run inputs, but imported data is not presented as observed server evidence.
- Custom redaction fields apply to payloads; they do not rewrite executable scenario metadata such as URL, kind, or adapter paths.
- New scenarios, runs, replays, and exported scenario payloads apply current redaction rules. Historical source records remain immutable.
- Runs retain case ID and definition version, so duplicate names and edited cases cannot inherit another case's result.
- Running records retain process ownership. Dead owners are recovered as failed at startup or deletion; legacy records require explicit stopped-runner confirmation through the CLI. Process IDs can be reused, so an existing PID is conservatively treated as active.
