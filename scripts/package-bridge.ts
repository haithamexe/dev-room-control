import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
const directory = 'build-artifacts/bridge'; mkdirSync(directory, { recursive: true });
await build({ entryPoints: ['packages/instrumentation/src/vite.ts'], outfile: `${directory}/vite.mjs`, bundle: true, platform: 'node', format: 'esm', banner: { js: "import {createRequire} from 'node:module'; import {fileURLToPath} from 'node:url'; import {dirname} from 'node:path'; const require=createRequire(import.meta.url); const __filename=fileURLToPath(import.meta.url); const __dirname=dirname(__filename);" } });
await build({ entryPoints: ['packages/instrumentation/src/webpack-loader.ts'], outfile: `${directory}/webpack-loader.cjs`, bundle: true, platform: 'node', format: 'cjs', footer: { js: 'module.exports = module.exports.default;' } });
await build({ entryPoints: ['packages/instrumentation/src/runtime.ts'], outfile: `${directory}/runtime.mjs`, bundle: true, platform: 'browser', format: 'esm' });
writeFileSync(`${directory}/package.json`, JSON.stringify({ name: '@local/developer-control-room-bridge', version: metadata.version, author: metadata.author, repository: metadata.repository, type: 'module', exports: { './vite': './vite.mjs', './webpack-loader': './webpack-loader.cjs', './runtime': './runtime.mjs' }, private: true }, null, 2));
copyFileSync('docs/ADVANCED.md', `${directory}/README.md`);
copyFileSync('node_modules/typescript-parser/LICENSE.txt', `${directory}/TYPESCRIPT-LICENSE.txt`);
// Exercise the distributed module, not just the TypeScript source.
const helper = await import(new URL('../build-artifacts/bridge/vite.mjs', import.meta.url).href);
if (helper.dcrSourceBridge().apply !== 'serve') throw new Error('Packaged source bridge failed its load check');
const loader = createRequire(import.meta.url)('../build-artifacts/bridge/webpack-loader.cjs');
if (typeof loader !== 'function' || !loader.call({ mode: 'development', rootContext: process.cwd(), resourcePath: process.cwd() + '/Example.tsx' }, 'export const Example=()=> <button>Example</button>').includes('data-dcr-source')) throw new Error('Packaged webpack loader failed its transform check');
console.log('Install the local bridge folder in a development project with npm install --save-dev <absolute-folder-path>. Nothing is published.');
