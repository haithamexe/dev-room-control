# Code, UI, and session workflows

Enable `drift`, `why`, `risk`, and `context` independently in a project's configuration, or use **Enable module** when opening its panel. New projects enable these local modules by default. The source bridge remains off until separately enabled.

## Design Drift Detector

Choose routes and import an array of explicit token rules in the UI. For the included demo at `/design`:

```json
[
  { "name": "Primary button", "selector": "button.primary", "property": "background-color", "values": ["var(--color-primary)"], "tolerance": 0 },
  { "name": "Card spacing", "selector": ".demo-card", "property": "padding-top", "values": ["var(--space-card)"], "tolerance": 1 }
]
```

Values can also be literal CSS values (`#254c3c`, `24px`, `8px`). The scanner resolves custom properties in each selected element's context and compares normalized computed values. Numeric tolerance is in pixels; colors require exact normalized equality. Supported properties: color/background-color, padding on all four sides, margin top/bottom, gap, font-size, border-radius. Use separate selectors/rules for button variants. Invalid selectors or unresolved tokens fail the scan rather than silently passing it.

The deliberately faulty demo gives two findings across four repeated elements. Reports show expected references/values, actual values, selectors, bounds, screenshot highlights, and source links where instrumented. Accepting a value as intentional or suppressing an outlier saves its fingerprint for later scans. Reopen removes that policy. Start the demo with `DEMO_FIXED=1` to get no outliers for these rules.

CLI: `npm run cli -- drift PROJECT_ID scan.json`, where the file contains `{ "routes": ["/design"], "rules": [...] }`. Alternatively save `understanding.driftRules` in project configuration.

## Why Is This Here?

Enter a development route and visible CSS selector. The report preserves DOM attributes/text, computed style, bounds, route, screenshot, and any approved source metadata. It remains readable offline. Uninstrumented elements show **Unknown** source confidence.

For explicit development instrumentation, spread `sourceProps` from `packages/core/src/bridge.ts` into a React element, or use the equivalent attributes:

```tsx
<button data-dcr-source="src/components/Button.tsx" data-dcr-line="2"
  data-dcr-component="Button" data-dcr-route="/checkout"
  data-dcr-handler="onCheckout">Continue</button>
```

Set `understanding.bridgeEnabled: true` in the registered project as a second opt-in. Source paths are repository-relative and must pass privacy/confinement checks. Handler/state labels are application-supplied evidence, not verified ownership or API causality. Do not put credentials in metadata. Mark private DOM regions with `data-private` and configure `maskSelectors` before capture. Inspect `/design` with `#primary-button` and `#plain-button` to compare instrumented and unknown mappings.

CLI: `npm run cli -- element PROJECT_ID /design '#primary-button'`.

## PR Risk Map

Choose a Git base such as `HEAD`, `main`, or a commit. The map compares that commit with current working-tree content, including staged and untracked files. Direct changes, transitive import dependents, affected route candidates, test associations, and observed navigation runs remain separate. Import edges and reasons are inspectable.

Relative literal imports, re-exports, and `require` are supported. Next.js `app/**/page` and `pages/**` paths use file conventions; literal React Router paths are marked heuristic because nesting/runtime ownership may differ. Test imports are static; filename associations are heuristic. Dynamic expressions, unresolved aliases, parse errors, and file limits are listed as gaps. This is not a runtime coverage claim. The gate copies the demo into an isolated Git repository, changes the shared Button, and verifies both routes plus its test.

CLI: `npm run cli -- risk PROJECT_ID HEAD`.

## Context Resurrection

Save a session snapshot with the exact pinned note, next step, optional task, and edited/cleared suggested action. It captures branch, commit, dirty files, recent commits, last run, last failing flow and open findings. Reopening the project restores the stored snapshot. **Resume saved workspace** opens the shared task preview; commands still require explicit review, and dirty branches are never switched automatically.

CLI: `npm run cli -- session PROJECT_ID session.json`, with `{ "note": "...", "nextStep": "...", "proposedAction": "", "taskId": "..." }`. Omitting the file captures current notes/Git and preserves the selected task.

## General AI context

Use **Copy context for AI** anywhere you are investigating or planning. The action is not restricted to failed runs. Add an optional task description, review the preview, then copy the entire Markdown or save it. You can exclude source excerpts. The handoff includes its selected record, relevant runs/scenarios/flows, expected and observed results, timeline, Git context, notes, tasks, source provenance/excerpts and binary evidence references. For example, a healthy task can be copied to ask an AI to explain it or implement a new feature.

No remote request is made. Redaction is applied again using current project rules, including known filled environment inputs. Secret files and `ignorePaths` are excluded from source reads. Source excerpts come from the current working tree, not the historical run; this distinction is included. Up to 12 files × 16,000 characters and the latest 1,000 relevant timeline events are included; omissions are explicit. Binary screenshots/traces are referenced by local path and hash. Attach them separately if the destination AI cannot access local files. Review the preview before sharing: pattern-based redaction cannot identify every possible private value.

CLI: `npm run cli -- handoff KIND ID` (optional `--no-source`), where KIND is `project`, `run`, `finding`, `scenario`, `report`, `task`, `session`, or `flow`.

## Editor and verification

Build the optional extension with `npm run package:editor`, then install the generated VSIX through VS Code's **Extensions: Install from VSIX** command. See [editor instructions](../apps/vscode/README.md).

```text
npm run build
npm test
npm run test:gate
npm run test:phase2
npm run test:phase34
npm run test:editor
```

Phase 3–4 browser tests use ports 4418/4318. The real editor-host test uses 4319 and an isolated temporary profile. Native Electron/VS Code tests should run in a normal terminal, outside restricted tool sandboxes. Reports and snapshots persist until project deletion; completed run retention still applies separately.
