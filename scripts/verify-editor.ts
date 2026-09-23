import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Store, id, now } from '../packages/storage/src/index.ts';
import { startServer } from '../apps/service/src/server.ts';
const root = mkdtempSync(join(tmpdir(), 'dcr-editor-')), store = new Store(join(root, 'data')), dashboard = startServer(4319, store);
let child: ReturnType<typeof spawn> | undefined;
try {
  await once(dashboard.server, 'listening'); writeFileSync(join(root, 'view.ts'), '// Source linked by evidence\nexport const fixture = true;\n');
  const project = dashboard.service.addProject({ name: 'Editor fixture', path: root, baseUrl: 'http://localhost:4400' });
  const report = store.put('reports', { id: id(), projectId: project.id, kind: 'element', name: 'Editor source', createdAt: now(), git: {}, input: {}, data: {}, sources: [{ file: 'view.ts', line: 2, component: 'Fixture', provenance: 'instrumented', reason: 'Fixture metadata' }], artifactIds: [] });
  const executable = process.env.DCR_CODE_EXE || join(process.env.LOCALAPPDATA || '', 'Programs/Microsoft VS Code/Code.exe');
  const args = ['--user-data-dir', join(root, 'vscode-user'), '--extensions-dir', join(root, 'vscode-extensions'), '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--no-sandbox', `--extensionDevelopmentPath=${resolve('apps/vscode')}`, `--extensionTestsPath=${resolve('apps/vscode/test/host.cjs')}`, root];
  const env: NodeJS.ProcessEnv = { ...process.env, DCR_EDITOR_PORT: '4319', DCR_EDITOR_PROJECT: project.id, DCR_EDITOR_REPORT: report.id }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(executable, args, { env, windowsHide: true, stdio: 'pipe' });
  let output = ''; child.stdout?.on('data', bytes => { output += bytes; }); child.stderr?.on('data', bytes => { output += bytes; });
  let timeout: ReturnType<typeof setTimeout>; const code = await Promise.race([once(child, 'exit').then(([code]) => code), new Promise((_, reject) => { timeout = setTimeout(() => { child?.kill(); reject(new Error('Editor verification exceeded 60 seconds')); }, 60000); })]).finally(() => clearTimeout(timeout!));
  assert.equal(code, 0, output.slice(-5000)); assert.match(output, /PASS: real VS Code command/); console.log('PASS: real VS Code extension host opened the correct evidence source and line.');
} finally { child?.kill(); await new Promise<void>(resolve => dashboard.server.close(() => resolve())); store.close(); try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { console.log(`Editor diagnostic profile retained until process handles close: ${root}`); } }
