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
