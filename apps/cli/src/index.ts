import { readFileSync } from 'node:fs';
import { Store } from '../../../packages/storage/src/index.ts';
import { ControlRoom } from '../../../packages/modules/src/service.ts';
import type { Flow, Run, Project } from '../../../packages/core/src/index.ts';
const store = new Store(), service = new ControlRoom(store);
const [command, ...args] = process.argv.slice(2);
try {
  let result: unknown;
  if (command === 'demo') result = await service.seedDemo();
  else if (command === 'projects') result = store.list('projects');
  else if (command === 'add') result = service.addProject({ path: args[0], name: args[1], baseUrl: args[2] || 'http://localhost:3000' });
  else if (command === 'import-project') { const config = JSON.parse(readFileSync(args[1], 'utf8')); result = service.addProject({ ...config, path: args[0] }); }
  else if (command === 'flows') result = store.list('flows', args[0]);
  else if (command === 'setup-labs') result = service.setupDemoLabs(args[0], { confirmFixtures: args.includes('--confirm-fixtures') });
  else if (command === 'fixtures') result = store.list('api_fixtures', args[0]);
  else if (command === 'scenarios') result = store.list('scenarios', args[0]);
  else if (command === 'save-scenario') result = service.reliability.saveScenario(args[0], JSON.parse(readFileSync(args[1], 'utf8')), args[2]);
  else if (command === 'save-fixture') result = service.reliability.saveFixture(args[0], JSON.parse(readFileSync(args[1], 'utf8')), args[2]);
  else if (command === 'capture') { const run = service.reliability.capture(args[0], { flowId: args[1], url: args[2], name: args[3] || 'Captured fixture' }); result = await service.active.get(run.id); if ((result as Run).status === 'failed') process.exitCode = 1; }
  else if (command === 'scenario') { const run = service.reliability.run(args[0]); result = await service.active.get(run.id); if ((result as Run).status === 'failed') process.exitCode = 1; }
  else if (command === 'matrix') { const matrix = service.reliability.matrix(args[0], { scenarioIds: args.slice(1) }); result = await service.reliability.activeMatrices.get(matrix.id); if ((result as any).status === 'failed' || (result as any).runIds.some((runId: string) => store.get<Run>('runs', runId).status === 'failed')) process.exitCode = 1; }
  else if (command === 'import') result = service.saveFlow(args[0], JSON.parse(readFileSync(args[1], 'utf8')));
  else if (command === 'run' || command === 'replay') {
    const previous = command === 'replay' ? store.get<Run>('runs', args[0]) : undefined;
    const run = service.run(previous?.flowId || args[0], previous?.id); result = await service.active.get(run.id); if ((result as Run).status === 'failed') process.exitCode = 1;
  }
  else if (command === 'runs') result = store.list('runs', args[0]);
  else if (command === 'inspect') { const run = store.get<Run>('runs', args[0]); result = { run, events: store.list<any>('events', run.projectId).filter(e => e.runId === run.id).reverse(), artifacts: store.list<any>('artifacts', run.projectId).filter(a => a.runId === run.id) }; }
  else if (command === 'task-preview') result = service.previewTask(args[0]);
  else if (command === 'task-launch') result = service.launchTask(args[0], args.includes('--approve-command'));
  else if (command === 'delete-project') result = service.deleteProject(args[0], args[1]);
  else { console.log('Developer Control Room\n\n  demo\n  projects\n  add <repo> <name> [url]\n  import-project <repo> <config.json>\n  flows [project-id]\n  import <project-id> <flow.json>\n  run <flow-id>\n  replay <run-id>\n  runs [project-id]\n  inspect <run-id>\n  setup-labs <project-id> --confirm-fixtures\n  fixtures [project-id]\n  capture <project-id> <flow-id> <url> [name]\n  save-fixture <project-id> <fixture.json> [fixture-id]\n  save-scenario <project-id> <scenario.json> [scenario-id]\n  scenarios [project-id]\n  scenario <scenario-id>\n  matrix <project-id> <scenario-id>...\n  task-preview <task-id>\n  task-launch <task-id> --approve-command\n  delete-project <project-id> "exact project name"'); }
  if (result) console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
finally { store.close(); }
