# Local Windows release 0.2.0

Build artifacts are in `build-artifacts/release`:

- `Developer-Control-Room-Setup-0.2.0-x64.exe`: per-user Windows installer with an install-location chooser and shortcuts.
- `Developer-Control-Room-0.2.0-x64.zip`: extract the entire ZIP, then open `Developer Control Room.exe`. Keep the resources next to the executable.
- `SHA256SUMS.txt`: checksums of the final installer and ZIP.

This local release is unsigned. Windows may show Unknown publisher. It contains the Electron runtime, local service, worker, Chromium, Firefox, WebKit and fixture demo, and does not need a separate Node.js installation. Git analysis still requires Git; opening sources in an editor requires that editor. The app's bundled demo starts automatically and intentionally contains checkout defects.

Data and startup logs are stored under `%APPDATA%/Developer Control Room/data` (Electron may use the package name `developer-control-room` on some launches). Installation files and data are separate. The portable ZIP also uses this application-data location by default; it is portable software, not a self-contained data profile. Uninstalling retains evidence. `DCR_DATA_DIR` selects a different data directory when needed.

The service binds to loopback and selects a free port. A per-user endpoint file lets the optional VS Code extension discover it unless a port was explicitly configured. The demo retains its initially allocated port so saved scenario URLs remain valid. If another process occupies that saved port, close the conflicting process and reopen; startup details appear in `service.log`.

New installations start with an empty workspace. The existing source-development `.dcr` folder is not copied or deleted. Use **Explore the included demo** or **Add a local project**. See [advanced workflows](ADVANCED.md) for recording, authentication, browsers, recovery and Stripe test settings.

## Rebuilding

```text
npm ci
npx playwright install chromium firefox webkit
npm run package:bridge
npm run package:windows
npm run test:release
```

The native release smoke test uses an isolated temporary data profile, removes Node.js from PATH, runs a bundled demo flow with each browser engine, checks evidence/context export and verifies the renderer remains sandboxed. Packaging does not publish anything or configure online updates.

## Reserved Microsoft Store product

The user reserved Developer Control Room using **MSIX or PWA app** in Partner Center. This is the right product type for a future MSIX desktop package. Microsoft signs that Store package after certification. The EXE/MSI Store path requires publisher-supplied signatures; registering a developer account does not issue a certificate for arbitrary EXEs. See [Microsoft's signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).

Store submission is deferred by the user until feature work is complete. Later work needs the product's package identity/publisher fields, an MSIX build and package validation, icons/screenshots/listing/privacy information, and explicit submission authorization. Creating the product did not publish or sign the current local installer.

## Validation

The packaged app passed standalone runs with Chromium, Firefox and WebKit while Node.js was excluded from PATH, and passed demo/context-export/sandbox checks. Foregrounding the native window resolved a screenshot timeout caused by the automation window being in the background. The final installer signature is intentionally `NotSigned`. The installer itself is built for user installation; tests launch the identical unpacked application in a temporary profile without installing shortcuts or changing the normal user profile.
