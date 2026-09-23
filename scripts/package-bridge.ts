import { build } from 'esbuild';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
const directory = 'build-artifacts/bridge'; mkdirSync(directory, { recursive: true });
await build({ entryPoints: ['packages/instrumentation/src/vite.ts'], outfile: `${directory}/vite.mjs`, bundle: true, platform: 'node', format: 'esm', banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" } });
await build({ entryPoints: ['packages/instrumentation/src/runtime.ts'], outfile: `${directory}/runtime.mjs`, bundle: true, platform: 'browser', format: 'esm' });
writeFileSync(`${directory}/package.json`, JSON.stringify({ name: '@local/developer-control-room-bridge', version: '0.2.0', type: 'module', exports: { './vite': './vite.mjs', './runtime': './runtime.mjs' }, private: true }, null, 2));
copyFileSync('docs/ADVANCED.md', `${directory}/README.md`);
console.log('Install the local bridge folder in a development project with npm install --save-dev <absolute-folder-path>. Nothing is published.');
