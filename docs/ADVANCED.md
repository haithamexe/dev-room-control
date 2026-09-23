# Advanced local workflow

## Recording and browser engines

Select a project, open Flows, and choose **Start recording**. Record labeled inputs, accessible buttons/links, checkboxes/radios, single-select dropdowns, single-file uploads, nested iframe controls and click-opened tabs. Use the dashboard recording controls for Back, Forward, reload, URL navigation, new tabs and tab switching. Native address-bar changes and browser toolbar navigation remain outside recording; use the explicit controls or edit steps afterward. Private/unlabeled controls and sensitive locator metadata are skipped with warnings. Very short input values can conservatively suppress labels containing those values.

Stop and review in the visual editor. Add, remove and reorder steps; edit saved flows without changing historical run snapshots; switch to JSON when needed. Typed/selected values and upload paths become environment references. Uploads must resolve inside the project and be at most 20 MB. A recorded dropdown can use a structural selector to avoid storing option text inside its accessible label. Review selectors if the page layout changes. Add an assertText outcome before running.

Flows support goto, click, fill, select, check, upload, assertText, back, forward, reload, newTab, switchTab, closeTab and popup. The first tab is named main; recorded additional tabs are tab2, tab3, etc. Each action can target a named tab and nested iframe selectors. New tab/popup actions make that tab current. CloseTab keeps another tab open. One recording runs at a time, with a 20-minute limit; dashboard reload reconnects while the service remains running.

Import JSON definitions or a single Playwright test file (.ts/.js/.mjs). The importer parses literal goto/navigation, getByRole clicks, getByLabel inputs/checks/selects/uploads, frameLocator scopes and expect(getByText()).toBeVisible(). Environment expressions use process.env.NAME. Hooks, loops, helpers, dynamic locators, multiple tests and unsupported options produce line-numbered warnings. Review and acknowledge those gaps before saving. Imported JavaScript is never executed. This is a supported-subset converter, not arbitrary Playwright execution.

Choose Chromium, Firefox or WebKit in settings. All are bundled in the local release; browser selection is preserved in replay.

For automatic login, set `auth.storageStateEnv` to an environment variable containing Playwright storage-state JSON. Only cookies/origins matching project hosts are accepted. Alternatively, set `auth.loginFlow` to a regular flow whose fill steps all use environment references. Login runs before evidence capture. Known authentication values are scrubbed from structured evidence and masked in screenshots; configured privacy selectors still apply. Restart the app after changing its inherited environment variables.

## Isolated execution and recovery

Each run executes in a separate process. Set `execution.timeoutMs` (default 120000); cancel active runs from their investigation page. Cancelled runs retain available evidence without generating a defect finding. Matrices snapshot their case/flow plans, persist progress after each case, and offer **Resume remaining cases** after interruption or cancellation. A partially executed case starts again in a fresh browser; completed cases are not repeated. Resumption is explicit, never automatic. An individual run replays from its saved definition rather than attempting to restore a live browser session.

## Additional payment cases and Stripe

Payment Lab supports ten cases: Back, Forward, refresh after success, refresh before confirmation, repeated confirmation, reopening success, two tabs, session expiry, delayed callback, and failed callback. The latter two use the fixture protocol's `/__fixtures/orders/{orderId}/events` endpoint. **Add advanced demo cases** populates the seven additional cases. Each run checks the visible outcome and server-reported state/confirmation count.

The optional Stripe integration is a **test PaymentIntent probe alongside the fixture checkout**. It is not a real checkout UI, webhook receiver, 3-D Secure implementation or proof of the target application's Stripe integration. No external Stripe request is made by default. To enable it, set a test secret key in `STRIPE_TEST_SECRET_KEY` before launching the app and configure:

```json
{
  "reliability": {
    "payment": {
      "testEnvironmentConfirmed": true,
      "fixturesOnlyConfirmed": true,
      "gateway": {
        "provider": "stripe-test",
        "enabled": true,
        "secretEnv": "STRIPE_TEST_SECRET_KEY"
      }
    }
  }
}
```

Merge this into the existing configuration rather than replacing unrelated settings. The adapter accepts only `sk_test_` keys, contacts the fixed Stripe API origin, uses the synthetic `pm_card_visa` method, and rejects live-mode responses. It creates a $32 USD test PaymentIntent and reads its authoritative status after the fixture stress action. Only ID, status, amount and currency enter evidence. A real Stripe account call has not been verified because credentials were not supplied; transport behavior, safe evidence and live-key rejection are tested locally.

## Development source and interaction bridge

Build the optional helper with `npm run package:bridge`, or use the `bridge` folder included under the installed application's `resources/app` directory. Install that local folder into the application you are inspecting:

```text
npm install --save-dev C:/absolute/path/to/bridge
```

In that project's Vite configuration:

```ts
import { dcrSourceBridge } from '@local/developer-control-room-bridge/vite';
// Add dcrSourceBridge() before the React plugin in plugins: [...].
```

The development-only JSX transform annotates intrinsic elements with their original source line and enclosing declaration. Explicit metadata is preserved. This is source-location instrumentation, not proof of React runtime state ownership. Production builds receive no automatic source annotations. Enable the project's source metadata bridge in Control Room to collect them. Webpack and Next.js can use the loader described below; other projects can use manual `sourceProps` metadata.

For an observed relationship between a handler, state and its requests, explicitly instrument the handler:

```ts
import { traceInteraction } from '@local/developer-control-room-bridge/runtime';
await traceInteraction(
  { file: 'src/Checkout.tsx', line: 20, component: 'Checkout', handler: 'confirm' },
  async scope => { await scope.request('/api/test-confirm', { method: 'POST' }); },
  { enabled: import.meta.env.DEV, state: () => ({ phase: currentPhase }) }
);
```

Await every `scope.request` belonging to the handler. Only those calls are associated; parallel unrelated requests are not inferred to be causal. The state getter is application-supplied and must read the current state (for React, use an appropriate ref/store rather than a stale render closure). Control Room captures completed scopes in run timelines. The element inspector's optional **Click ... once** action waits up to five seconds for a completed scope and displays its provenance. Separately, enable React inspection in settings for bounded observations of component owners, props, state hooks/class state and handler prop names from the committed React tree. Reports can include before/after snapshots. This uses undocumented internals: unsupported trees report an explicit gap, hook slots have no inferred variable names, and handler names do not prove request causality. Private DOM values and configured sensitive fields are excluded. Do not include private state in this getter; redaction is a second protection, not a reason to emit credentials.

Risk maps now use TypeScript's resolver for relative imports, `baseUrl`, `paths`, JSONC and local `extends` configuration. Source privacy rules still exclude external/private files. Missing configuration, dynamic wiring, external package aliases and scan limits remain explicit gaps.

## Webpack and Next.js development loader

The local bridge package exports a CommonJS webpack-loader. In webpack, add a development-only pre-loader before JSX compilation:

```js
const bridgeLoader = require.resolve('@local/developer-control-room-bridge/webpack-loader');
// In a development webpack config:
module.exports = {
  mode: 'development',
  module: { rules: [{ test: /\.[jt]sx$/, enforce: 'pre', exclude: /node_modules/, use: [{ loader: bridgeLoader }] }] }
};
```

In Next.js using webpack, add that rule inside webpack(config, { dev }) only when dev is true, then return config. Start development with next dev --webpack when needed. Production mode bypasses annotation even if the rule is accidentally retained. Turbopack integrations must install a development-only loader rule and pass { development: true, root: absoluteProjectRoot }; never retain that option in production configuration. The loader itself is verified locally; a complete Next.js/Turbopack application build is not part of this repository's test suite.

## API methods, matching and schema suggestions

Configure exact reliability.apiPaths and approved reliability.apiMethods (default: GET). POST, PUT, PATCH and DELETE capture executes the real flow against the approved test target and can change its test data. Capture retains a sanitized JSON response and a sanitized exact JSON request matcher when there is a body. JSON request/response capture is limited to 64 KB. Non-JSON request bodies need a manually imported fixture.

Imported fixtures support optional exact/subset JSON body matching. Object key order is ignored; arrays retain order. Blank body matching accepts any body for that method. Redacted fields compare as redacted values, so they cannot distinguish different credentials. During API mutation, a request to the fixture URL with the wrong method/body is blocked rather than forwarded. Matched requests receive the fixture response without reaching the target endpoint. Other URLs follow the ordinary flow target rules.

Add an optional response JSON Schema to a fixture, then choose a suggestion in the scenario editor. Supported schema fields include properties, required, type (including null), nullable, items, minItems and maxLength. Suggestions use existing fixture fields and escaped JSON pointers; external references/composition are not resolved. Review the mutation and provide the expected visible outcome before saving. Suggestions do not imply schema validation or automatic knowledge of the correct UI.

## Workspace commands, detection and retention

Tasks show command status, exit code and bounded, redacted stdout/stderr. Commands still require review before launch. Output appears after complete lines, is limited to 64 KB, and oversized lines are omitted. Stop command terminates its owned process tree on Windows. History survives restart; interrupted commands are marked failed once their service owner is gone. Command evidence is included in relevant general AI context exports.

Settings provide framework/package-manager overrides; clearing them reruns automatic detection. Scheduled cleanup is opt-in and runs at startup and hourly while the service is open, using retentionDays. Settings saves also apply retention. Active runs and runs referenced by a matrix, fixture capture, replay or saved session are retained. Reports are retained until project deletion. The last scheduled cleanup result appears in settings.

## Deferred scope

Stripe expansion is excluded at the user's request. Microsoft Store MSIX packaging, listing and submission remain deferred. Unsupported script code, native browser toolbar gestures, multi-file/multi-select recording, closed-shadow controls and React internals outside the supported runtime remain explicit limits rather than silently inferred behavior.
