import { build } from 'esbuild';
import { build as packageApp, Platform, Arch } from 'electron-builder';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Keep local builds responsive; maximum LZMA compression is unnecessary here.
process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ||= '1';
const stage = resolve('build-artifacts/windows-app'), output = resolve('build-artifacts/release');
mkdirSync(stage, { recursive: true }); mkdirSync(output, { recursive: true });
await build({ entryPoints: { backend: 'apps/service/src/packaged.ts', worker: 'packages/runner/src/worker.ts' }, outdir: stage, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['playwright', 'typescript-parser'], banner: { js: "import { createRequire as _dcrRequire } from 'node:module'; const require = _dcrRequire(import.meta.url);" } });
cpSync('apps/desktop/main.cjs', join(stage, 'main.cjs'));
cpSync('dist', join(stage, 'dist'), { recursive: true });
cpSync('build-artifacts/bridge', join(stage, 'bridge'), { recursive: true });
cpSync('docs', join(stage, 'docs'), { recursive: true });
cpSync('examples/demo-app', join(stage, 'examples/demo-app'), { recursive: true, filter: source => !source.includes('node_modules') && !source.includes('.devcontrolroom') });
for (const name of ['playwright', 'playwright-core', 'typescript-parser']) cpSync(resolve('node_modules', name), join(stage, 'node_modules', name), { recursive: true });
writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'developer-control-room', productName: 'Developer Control Room', version: '0.2.0', description: 'Local developer testing and context workspace', author: 'Developer Control Room', main: 'main.cjs', type: 'module' }, null, 2));
const browserRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || join(process.env.LOCALAPPDATA!, 'ms-playwright');
const definitions = JSON.parse(readFileSync(join(require.resolve('playwright-core/package.json'), '..', 'browsers.json'), 'utf8')).browsers;
const names = ['chromium', 'chromium-headless-shell', 'firefox', 'webkit', 'ffmpeg', 'winldd'];
const resources = definitions.filter((browser: any) => names.includes(browser.name)).map((browser: any) => {
  const folder = `${browser.name.replaceAll('-', '_')}-${browser.revisionOverrides?.win64 || browser.revision}`;
  const from = join(browserRoot, folder); if (!existsSync(from)) throw new Error(`Install bundled browsers first: npx playwright install (missing ${folder})`);
  return { from, to: `browsers/${folder}` };
});
await packageApp({ targets: Platform.WINDOWS.createTarget(['nsis', 'zip'], Arch.x64), config: { appId: 'local.developer-control-room', productName: 'Developer Control Room', directories: { app: stage, output }, electronVersion: '44.4.5', electronDist: resolve('node_modules/electron/dist'), asar: false, npmRebuild: false, files: ['**/*'], extraResources: resources, win: { signAndEditExecutable: false, artifactName: 'Developer-Control-Room-${version}-${arch}.${ext}' }, nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, deleteAppDataOnUninstall: false, artifactName: 'Developer-Control-Room-Setup-${version}-${arch}.${ext}' }, publish: null } });
const artifacts = readdirSync(output).filter(name => /\.(exe|zip)$/.test(name));
writeFileSync(join(output, 'SHA256SUMS.txt'), artifacts.map(name => `${createHash('sha256').update(readFileSync(join(output, name))).digest('hex')}  ${name}`).join('\n') + '\n');
console.log('Local Windows release:', output);
