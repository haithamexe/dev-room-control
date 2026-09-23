const assert = require('node:assert/strict');
const vscode = require('vscode');
exports.run = async () => {
  await vscode.workspace.getConfiguration('developerControlRoom').update('port', Number(process.env.DCR_EDITOR_PORT), vscode.ConfigurationTarget.Global);
  const extension = vscode.extensions.getExtension('local-control-room.developer-control-room-editor'); assert.ok(extension); await extension.activate();
  const opened = await vscode.commands.executeCommand('dcr.openEvidenceSource', { projectId: process.env.DCR_EDITOR_PROJECT, reportId: process.env.DCR_EDITOR_REPORT, file: 'view.ts' });
  assert.ok(opened.endsWith('view.ts')); assert.equal(vscode.window.activeTextEditor.document.uri.fsPath.toLowerCase(), opened.toLowerCase()); assert.equal(vscode.window.activeTextEditor.selection.active.line, 1);
  console.log('PASS: real VS Code command opens the saved report source at the referenced line.');
};
