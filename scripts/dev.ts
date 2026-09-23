import { spawn } from 'node:child_process';
const children = [spawn(process.execPath, ['--import', 'tsx', 'apps/service/src/server.ts'], { stdio: 'inherit' }), spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' })];
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { children.forEach(child => child.kill()); process.exit(); });
for (const child of children) child.on('exit', code => { children.forEach(c => c.kill()); process.exit(code || 0); });
