const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { mkdirSync, openSync, closeSync, writeFileSync, unlinkSync } = require('node:fs');
const path = require('node:path');
let service;
let mainWindow;
let endpointFile;
const external = url => { if (/^(https?:|vscode:)/.test(url)) void shell.openExternal(url); };
async function availablePort() {
  if (process.env.DCR_PORT) return Number(process.env.DCR_PORT);
  return new Promise((resolve, reject) => { const probe = createServer(); probe.on('error', reject); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    const root = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '../..');
    const data = process.env.DCR_DATA_DIR || (app.isPackaged ? path.join(app.getPath('userData'), 'data') : path.join(root, '.dcr'));
    mkdirSync(data, { recursive: true });
    const logPath = path.join(data, 'service.log'), log = openSync(logPath, 'a');
    const port = await availablePort(), dashboardUrl = `http://127.0.0.1:${port}`;
    const launchId = require('node:crypto').randomUUID();
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DCR_PORT: String(port), DCR_DATA_DIR: data, DCR_LAUNCH_ID: launchId };
    if (app.isPackaged) { env.DCR_WORKER_ENTRY = path.join(root, 'worker.mjs'); env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'browsers'); }
    service = spawn(process.execPath, app.isPackaged ? [path.join(root, 'backend.mjs')] : ['--import', 'tsx', 'apps/service/src/server.ts'], { cwd: root, env, windowsHide: true, stdio: ['ignore', log, log, 'ipc'] });
    closeSync(log);
    let failed = false;
    service.on('error', () => { failed = true; });
    service.on('exit', () => { failed = true; });
    let ready = false;
    for (let attempt = 0; attempt < 100 && !failed; attempt++) {
      try { const response = await fetch(`${dashboardUrl}/api/session`, { signal: AbortSignal.timeout(1000) }); const body = await response.json(); if (response.ok && body.launchId === launchId) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (!ready) { dialog.showErrorBox('Local service could not start', `Please reopen Developer Control Room. Startup details are saved in:\n${logPath}`); app.quit(); return; }
    endpointFile = path.join(app.getPath('userData'), 'service-endpoint.json');
    writeFileSync(endpointFile, JSON.stringify({ port, pid: process.pid }));
    mainWindow = new BrowserWindow({ width: 1460, height: 950, minWidth: 960, minHeight: 650, backgroundColor: '#101312', title: 'Developer Control Room', autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    mainWindow.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== dashboardUrl) { event.preventDefault(); external(url); } });
    await mainWindow.loadURL(dashboardUrl);
    service.on('exit', () => { if (mainWindow && !mainWindow.isDestroyed()) dialog.showErrorBox('Local service stopped', `Close and reopen the app to recover interrupted work. Details:\n${logPath}`); });
  }).catch(error => { dialog.showErrorBox('Unable to open Developer Control Room', error.message); app.quit(); });
}
app.on('window-all-closed', () => app.quit());
let quitting = false, serviceStopped = false;
app.on('before-quit', event => {
  mainWindow = undefined;
  if (service && !serviceStopped && service.exitCode === null && service.connected) {
    event.preventDefault(); if (quitting) return; quitting = true;
    const finish = () => { serviceStopped = true; clearTimeout(timer); app.quit(); };
    service.once('exit', finish);
    const timer = setTimeout(() => {
      // The fallback is restricted to this application's still-owned service tree.
      if (process.platform === 'win32' && service.pid) { const killer = spawn('taskkill.exe', ['/PID', String(service.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => { service.kill(); }); }
      else service.kill();
    }, 8000);
    service.send({ type: 'dcr-shutdown' }, error => { if (error) service.kill(); });
    return;
  }
  if (endpointFile) { try { unlinkSync(endpointFile); } catch {} }
});
