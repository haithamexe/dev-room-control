import { startServer } from './server.ts';
import { startDemo } from '../../../examples/demo-app/server.ts';
import { once } from 'node:events';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
// Keep the editable demo outside the installation so application updates preserve it.
const demoPath = join(process.env.DCR_DATA_DIR!, 'demo-app');
if (!existsSync(demoPath)) cpSync(resolve('examples/demo-app'), demoPath, { recursive: true });
process.env.DCR_DEMO_PATH = demoPath;
const portFile = join(process.env.DCR_DATA_DIR!, 'demo-port.json');
const savedPort = existsSync(portFile) ? JSON.parse(readFileSync(portFile, 'utf8')).port : 0;
const demo = startDemo(Number.isInteger(savedPort) && savedPort >= 0 && savedPort <= 65535 ? savedPort : 0);
await once(demo, 'listening');
const port = (demo.address() as { port: number }).port;
writeFileSync(portFile, JSON.stringify({ port }));
process.env.DCR_DEMO_URL = `http://127.0.0.1:${port}`;
const app = startServer();
// Initial launch allocates a free demo port; later launches keep snapshot URLs valid.
if (app.store.list<any>('projects').some(project => project.path === demoPath)) await app.service.seedDemo();
