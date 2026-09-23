const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
let service;
app.whenReady().then(async () => {
  const root = path.resolve(__dirname, '../..');
  service = spawn(process.execPath, ['--import', 'tsx', 'apps/service/src/server.ts'], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'ignore' });
  for (let attempt = 0; attempt < 50; attempt++) { try { const r = await fetch('http://127.0.0.1:4310/api/session'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  const win = new BrowserWindow({ width: 1460, height: 950, minWidth: 960, minHeight: 650, backgroundColor: '#101312', title: 'Developer Control Room', autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^(https?:|vscode:)/.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== 'http://127.0.0.1:4310') { event.preventDefault(); if (/^(https?:|vscode:)/.test(url)) void shell.openExternal(url); } });
  await win.loadURL('http://127.0.0.1:4310');
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => service?.kill());
