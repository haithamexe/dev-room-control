import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { _electron as electron } from 'playwright';
for (let attempt = 0; attempt < 2; attempt++) {
  const app = await electron.launch({ args: ['apps/desktop/main.cjs'], env: { ...process.env, DCR_PORT: String(4320 + attempt) } });
  try {
    const window = await app.firstWindow();
    await window.getByRole('heading', { name: 'Your development, in focus.' }).waitFor();
    const preferences = await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents as unknown as { getLastWebPreferences(): { nodeIntegration: boolean; contextIsolation: boolean; sandbox: boolean } };
      const preferences = contents.getLastWebPreferences();
      return { nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox };
    });
    assert.deepEqual(preferences, { nodeIntegration: false, contextIsolation: true, sandbox: true });
    mkdirSync('test-results', { recursive: true });
    await window.screenshot({ path: 'test-results/electron.png' });
    console.log(`PASS: desktop cold start ${attempt + 1}, dashboard render, sandboxed renderer.`);
  } finally { await app.close(); }
}
