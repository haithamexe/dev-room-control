# Phase 1 implementation review

Reviewed against initial commit `092a5d5`, using the supplied build spec. Scope is Phase 1; later modules remain explicitly planned. The implement/code-review workflow used independent Standards and Spec reviewers.

## Standards

Two confirmed findings in the reviewed commit:

- **P1 — Redirects bypass target restrictions** — `packages/runner/src/index.ts`. Playwright routing checks the first request only; redirected requests can reach an unapproved origin. Reproduced with two local servers. Fixed by fetching one hop only and rejecting redirects before the browser follows them. The new regression verifies zero requests reach the denied destination. Buffered requests and unsupported HTTP redirects are documented limitations.
- **P1 — Environment input secrets survive trace sanitization** — `packages/runner/src/index.ts`. Clearing `params.value` does not clear Playwright's separate log message containing the entered value. Fixed by excluding raw log/console/event trace records, scrubbing resolved inputs from persisted text, and masking matching text in screenshots. A real Chromium input regression verifies the typed fixture secret is absent from saved traces and events.

No additional high-confidence blockers were found in local API checks, source confinement, storage operations, or task command approval.

Follow-up review caught one additional privacy case: recursively exempting metadata-shaped keys could retain an input secret inside a captured JSON body's `id` or `type` field. Fixed by preserving protocol metadata only at the top-level trace-record boundary. The real-browser regression now captures nested response data and verifies these values are scrubbed too.

## Spec

- **P1 — Saved traces retain entered credentials.** Same concrete privacy defect independently reproduced by the Spec reviewer; fixed and covered by the browser regression above.
- **P2 — Workspace launch was partial.** The reviewed commit started the command but only returned file/URL links and navigated to an unfiltered flow list. Fixed: launch invokes OS URL/editor handlers; preview connects to the specific flow and its latest run. Branch changes remain manual, as documented.

No material scope creep was identified. The later-phase modules and documented action-only trace tradeoff were excluded from missing-feature findings.

Review totals: Standards 3 findings including follow-up, all addressed; Spec 2 findings, both addressed. The most severe finding on both axes was persistence of typed secrets.

## Desktop investigation

The initial native test launched Electron from the restricted agent tool environment and reproduced a Windows access violation (`0xC0000005`), reported by the user. The unchanged application launched successfully outside that tool restriction, with Electron's own sandbox and context isolation enabled. A repeatable native smoke script now checks two cold starts with separate service ports and clean shutdown. Run it from a normal user terminal, not the restricted tool sandbox.

# Phase 2 implementation review

Reviewed independently along Standards and Spec axes against `517f1a9`, with implementation at `27a81b1`. Scope: API Contract Ambush and Payment Stress Lab.

## Standards

- **P1: delayed mutations could pass before delivery.** A 5-second mutation returned success in roughly 1 second when expected text was already visible. Fixed by counting only finished browser responses, waiting for delivery and browser processing, and checking late browser errors before final persistence. A real-browser regression now observes the delivered response and fails on its fetch-handler exception.
- **P2: resolved payment paths bypassed ignore rules.** Validation used a placeholder order path. Every actual adapter request now checks the expanded URL before sending. A local-server regression proves zero requests reach a denied order path.
- **P2: newly derived snapshots retained data covered by updated redaction rules.** New scenario/run/replay snapshots and scenario exports now apply current payload redaction, preserving original historical records. The browser regression verifies run and exported evidence omit a newly sensitive field.
- **P2: interrupted work permanently blocked deletion.** Runs and matrices now retain owner PIDs. Dead owners are marked interrupted/failed, while live owners block deletion. A CLI recovery path handles legacy records after explicit stopped-runner confirmation. Regression coverage exercises dead, live, and legacy records.

## Spec

- **P1: delayed mutation false pass.** Independently reproduced; addressed by the delivery fix above.
- **P2: cards associated outcomes by scenario name.** Runs now retain the case ID and snapshot version. Cards require both to match. Rendered-component coverage verifies two same-name cases show different outcomes and an edited case does not show its prior version's result.

Four Standards findings and two Spec findings, all addressed. No material scope creep identified. Fixture-only payment adapters and explicitly selected optional/nullable fields remain documented Phase 2 limits.

# Phases 3–4 and general AI handoff review

Reviewed independently against `11f80ad`, initial implementation `5ae6fcf`. Scope is the remaining MVP phase gates plus the user's general context-copy requirement.

## Standards

- **P1: source privacy exclusions could be bypassed through a filesystem alias.** Both requested and resolved repository-relative paths now pass the same exclusions. A junction regression proves ignored source content cannot enter an AI handoff.
- **P1: private element attributes remained exportable.** Inspector collection now omits attributes and source/instrumentation labels for private elements, and removes private descendants before extracting text. Configured privacy selectors apply to structured evidence as well as screenshots.
- **P2: relative CSS values used the parent's context.** Expected values now resolve temporarily on the actual target, with its exact inline style restored. A real browser regression covers `em`, custom properties, and `currentColor` without false findings or changed inline styles.

## Spec

- **P1: configured private DOM regions leaked through report JSON and handoff.** Fixed with the private-region collection changes above; regression checks persisted evidence and AI export.
- **P2: correct relative tokens produced false drift.** Independently reproduced; fixed by resolving values in the target context.

All three Standards findings and both Spec findings were addressed and independently verified. No additional concrete Phase 4 or general handoff scope omissions were identified. Validation: 21 focused tests; Phase 1, Phase 2 and Phase 3–4 browser gates; two native Electron cold starts with renderer sandbox enabled; a real VS Code command opening the referenced file/line; and successful VSIX installation into an isolated profile. The optional extension remains uninstalled in the user's normal editor profile.

# Advanced functionality and local Windows release

Reviewed against 426610e with independent Standards and Spec agents. User requested local Windows packaging, later reserved an MSIX/PWA Store product, and explicitly deferred submission.

## Standards

- Authenticated inspections could retain known login values. Fixed report/finding/handoff scrubbing and screenshot masking; real-browser privacy regression passes.
- The packaged demo task depended on external Node/tsx. The packaged backend now embeds the demo server, stores editable sources in app data, retains its port, and omits that development-only command.
- Random desktop ports broke the editor default. A per-user endpoint file now supports automatic editor discovery, preserving explicit port overrides.
- Recorder metadata could retain typed values or private descendants, including a previously entered value after editing/clearing. Browser filtering and transient fingerprint history now protect all nonempty observed values; a full history stops capture safely. Private descendants and associated labels are excluded. Regression covers these cases and a normal replay.

## Spec

- Independently reproduced the authenticated-inspection and standalone-demo issues above; both fixed.
- Recorder names ignored aria-labelledby. Name resolution now uses those references and warns for unsupported controls; accessible-name replay and privacy regressions pass.
- Boundaries are documented in ADVANCED.md: explicit source/state instrumentation, bounded recording, and Stripe test probe do not claim automatic React ownership, arbitrary script import, or real checkout/webhook integration.

Both agents confirmed the final focused fixes. All 29 original/added tests passed before the final recorder regression (which also passed independently), as did Phase 2 and Phase 3/4 gates. The packaged executable ran all three bundled browsers with Node removed from PATH; native screenshot/foreground validation subsequently passed; see LOCAL_RELEASE.md. The final matrix checkpoint regression also passed after the cancellation race fix.

# Remaining non-Stripe workflows (0.3.0)

Reviewed against f014e66 by independent Standards and Spec agents. User explicitly excluded Stripe expansion and kept Store submission deferred.

## Standards

- ANSI terminal escapes could reconstruct a known secret after redaction. Normalize escapes first; split-output/ANSI regression passes.
- Iframe inputs were outside screenshot masks. Masks now cover every attached frame; pixel-level regression verifies private input masking.
- Desktop quit bypassed command cleanup. IPC shutdown stops owned command trees and recording browsers, cancels matrices before their runs, rejects new mutations, and preserves remaining matrix plans. Native release smoke checks the command and matrix lifecycle.
- Imported locators changed Playwright matching semantics. Imports now preserve exact/substring matching, with conversion diagnostics for unsupported options.
- Final evidence could show a background tab. The screenshot follows the current flow tab; pixel-level regression verifies it.

## Spec

- Independently reproduced iframe privacy and wrong-tab evidence; both fixed and tested.
- Newly derived request matchers were missing current redaction. A shared fixture sanitizer now handles response, request and schema payloads while preserving routing metadata.
- Known flow inputs were scrubbed on only one side of request matching. Both sides now use the same normalization.
- Revisiting a field reused the original environment reference. Separate editing episodes now get distinct references; consecutive keystrokes still coalesce.

The Spec reviewer independently reran four focused regressions and confirmed the fixes. Remaining intentional limits are documented in ADVANCED.md: supported-subset script conversion, explicit recording navigation controls, development loader integrations, and best-effort React internals.

Final validation: 39 tests passed, Phase 2 and Phase 3/4 gates passed, and the packaged app passed Chromium/Firefox/WebKit, visual create/edit/import, settings, command output, general context export, sandbox, owned-command shutdown and matrix preservation checks. Both reviewers confirmed their fixes.
