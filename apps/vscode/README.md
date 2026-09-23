# Developer Control Room for VS Code

Optional local editor integration. Start the Control Room service with `npm start` first.

- **Control Room: Open Evidence Source** selects a source reference from a saved report and opens the approved file at its recorded line. Instrumented drift findings share their parent report's references.
- **Control Room: Copy Context for AI** copies project, run, or report context with redacted source excerpts. Nothing is sent to a provider.
- **Control Room: Open Dashboard** opens the local dashboard.

The service port is `developerControlRoom.port` (default 4310). Only HTTP on 127.0.0.1 is used, and redirects are rejected. Opening source requires a trusted workspace and rechecks project path/privacy rules through the service.

From the repository root, run `npm run package:editor`, then in VS Code choose **Extensions: Install from VSIX** and select `build-artifacts/developer-control-room-editor-0.1.0.vsix`. Reload if prompted. Alternatively use an isolated development host:

```powershell
code --extensionDevelopmentPath="$PWD/apps/vscode" .
```

`npm run test:editor` exercises the source-opening command inside the installed VS Code executable, using an isolated temporary profile. Set `DCR_CODE_EXE` if VS Code is installed somewhere other than the default per-user Windows location.

Built using the official [command API](https://code.visualstudio.com/api/extension-guides/command) and [extension host testing workflow](https://code.visualstudio.com/api/working-with-extensions/testing-extension).
