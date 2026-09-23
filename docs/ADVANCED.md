# Advanced local workflow

## Recording and browser engines

Select a project, open Flows, and choose **Start recording**. A browser window opens using the project's browser setting. Record accessible buttons/links, labeled text fields and checkboxes. Stop and review the JSON, supply the named `DCR_INPUT_1` etc. environment variables, and add an `assertText` outcome before saving. Typed values never enter the recording. Unsupported/private controls generate warnings. Manual address-bar navigation, browser toolbar actions, selects, uploads and additional tabs require manual steps; the recorder is not an arbitrary Playwright-script importer. One recording may be active at a time and its browser closes after 20 minutes. Reloading the dashboard reconnects to an existing recording while the service remains running.

The flow editor also supports `forward`, `select` by label/value, and `check` by label/boolean. Choose Chromium, Firefox or WebKit in project settings. The local Windows package includes all three engines. Browser selection is captured with each run and preserved by replay.

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

The development-only JSX transform annotates intrinsic elements with their original source line and enclosing declaration. Explicit metadata is preserved. This is source-location instrumentation, not proof of React runtime state ownership. Production builds receive no automatic source annotations. Enable the project's source metadata bridge in Control Room to collect them. Non-Vite projects can retain the manual `sourceProps` bridge.

For an observed relationship between a handler, state and its requests, explicitly instrument the handler:

```ts
import { traceInteraction } from '@local/developer-control-room-bridge/runtime';
await traceInteraction(
  { file: 'src/Checkout.tsx', line: 20, component: 'Checkout', handler: 'confirm' },
  async scope => { await scope.request('/api/test-confirm', { method: 'POST' }); },
  { enabled: import.meta.env.DEV, state: () => ({ phase: currentPhase }) }
);
```

Await every `scope.request` belonging to the handler. Only those calls are associated; parallel unrelated requests are not inferred to be causal. The state getter is application-supplied and must read the current state (for React, use an appropriate ref/store rather than a stale render closure). Control Room captures completed scopes in run timelines. The element inspector's optional **Click ... once** action waits up to five seconds for a completed scope and displays its provenance. It does not automatically inspect React internals. Do not include private state in this getter; redaction is a second protection, not a reason to emit credentials.

Risk maps now use TypeScript's resolver for relative imports, `baseUrl`, `paths`, JSONC and local `extends` configuration. Source privacy rules still exclude external/private files. Missing configuration, dynamic wiring, external package aliases and scan limits remain explicit gaps.

## Remaining extensions

These are separate future features, not implied by the current release: arbitrary Playwright-script import; complete recorder coverage of browser gestures/iframes/uploads; non-Vite compiler adapters and automatic React state ownership; schema-aware API case suggestions and non-GET fixture capture; real project-specific Stripe checkout/webhook testing; command log panels and scheduled retention. Store MSIX packaging/certification is deferred until the user is ready to submit. The product name has been reserved in Partner Center, but no submission has been made.
