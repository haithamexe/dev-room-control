import ts from 'typescript-parser';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Project, Run, RunEvent } from '../../core/src/index.ts';
import { permittedPath } from './sources.ts';
import { git } from './index.ts';

export function riskMap(project: Project, base: string, runs: Run[], events: RunEvent[]) {
  if (!/^[\w./~^@{}-]{1,120}$/.test(base) || base.startsWith('-')) throw new Error('Use a Git revision such as HEAD or main');
  const baseCommit = git(project.path, ['rev-parse', '--verify', `${base}^{commit}`]);
  if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) throw new Error('Base revision does not resolve to a commit');
  const gitRoot = git(project.path, ['rev-parse', '--show-toplevel']);
  const changedRaw = execFileSync('git', ['-C', project.path, 'diff', '--name-only', '-z', baseCommit, '--'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  const untracked = execFileSync('git', ['-C', project.path, 'ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  const files: string[] = [], gaps: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= 2000) { if (!gaps.includes('File scan limited to 2000 source files')) gaps.push('File scan limited to 2000 source files'); return; }
      if (entry.isSymbolicLink() || ['node_modules', '.git', '.dcr', 'dist', 'build', '.next', 'coverage'].includes(entry.name)) continue;
      const path = join(dir, entry.name), rel = relative(project.path, path).replaceAll('\\', '/');
      try { permittedPath(project, rel); } catch { continue; }
      if (entry.isDirectory()) walk(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name) && statSync(path).size <= 256000) files.push(rel);
    }
  }
  walk(project.path);
  const known = new Set(files);
  const imports: { from: string; to: string; provenance: 'static'; reason: string }[] = [];
  const routes: { path: string; file: string; provenance: 'static' | 'heuristic'; reason: string }[] = [];
  const resolveImport = (file: string, spec: string) => {
    if (!spec.startsWith('.')) { if (spec.startsWith('@/') || spec.startsWith('~/')) gaps.push(`${file}: unresolved path alias ${spec}`); return; }
    const stem = relative(project.path, resolve(project.path, dirname(file), spec)).replaceAll('\\', '/');
    const candidates = [stem, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'].map(ext => stem + ext), ...['/index.ts', '/index.tsx', '/index.js', '/index.jsx'].map(ext => stem + ext), stem.replace(/\.js$/, '.ts'), stem.replace(/\.js$/, '.tsx')];
    return candidates.find(c => known.has(c));
  };
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(join(project.path, file), 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    if ((source as any).parseDiagnostics?.length) gaps.push(`${file}: parser diagnostics; graph may be incomplete`);
    const visit = (node: ts.Node) => {
      let spec: string | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) spec = node.moduleSpecifier.text;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) gaps.push(`${file}: dynamic import; execution is runtime-dependent`);
        if (node.arguments[0] && ts.isStringLiteral(node.arguments[0])) spec = node.arguments[0].text;
        else gaps.push(`${file}: runtime module expression cannot be resolved statically`);
      }
      if (spec) { const target = resolveImport(file, spec); if (target) imports.push({ from: file, to: target, provenance: 'static', reason: `Literal import ${spec}` }); }
      // React Router JSX and object route declarations; nesting remains explicitly uncertain.
      if (ts.isJsxAttribute(node) && node.name.getText(source) === 'path' && node.initializer && ts.isStringLiteral(node.initializer) || ts.isPropertyAssignment(node) && node.name.getText(source).replace(/["']/g, '') === 'path' && ts.isStringLiteral(node.initializer)) {
        const path = (node as ts.JsxAttribute | ts.PropertyAssignment).initializer as ts.StringLiteral;
        routes.push({ path: path.text, file, provenance: 'heuristic', reason: 'Literal route path candidate; verify router ownership and nested prefixes' });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    let route: string | undefined;
    const app = file.match(/^(?:src\/)?app\/(.*\/)?page\.[jt]sx?$/);
    if (app) route = '/' + (app[1] || '').split('/').filter(p => p && !/^\(.*\)$/.test(p)).join('/');
    const pages = file.match(/^(?:src\/)?pages\/(.+)\.[jt]sx?$/);
    if (pages && !pages[1].startsWith('_')) route = '/' + pages[1].replace(/(^|\/)index$/, '');
    if (route !== undefined) routes.push({ path: route || '/', file, provenance: 'static', reason: 'Next.js file-system route convention; route groups removed, dynamic segments retained' });
  }
  const normalize = (raw: string, root: string) => relative(project.path, resolve(root, raw)).replaceAll('\\', '/');
  const changed = [...new Set([...changedRaw.split('\0').filter(Boolean).map(f => normalize(f, gitRoot)), ...untracked.split('\0').filter(Boolean).map(f => normalize(f, project.path))])].filter(f => !f.startsWith('../') && !project.config.ignorePaths.some(p => f.includes(p)) && !/(^|\/)\.env|\.(pem|key|p12|pfx)$/i.test(f));
  const affected = new Set(changed); let grew = true;
  while (grew) { grew = false; for (const edge of imports) if (affected.has(edge.to) && !affected.has(edge.from)) { affected.add(edge.from); grew = true; } }
  const dependents = [...affected].filter(f => !changed.includes(f)).map(file => ({ file, provenance: 'static', reason: 'Transitive importer of changed code', edges: imports.filter(i => i.from === file && affected.has(i.to)) }));
  const affectedRoutes = routes.filter(r => affected.has(r.file)).map(route => ({ ...route, observedRuns: runs.filter(run => events.some(e => e.runId === run.id && e.kind === 'navigation' && (() => { try { return new URL(String(e.data.url)).pathname === route.path; } catch { return false; } })())).map(r => r.id) }));
  const tests = files.filter(f => /(?:\.(?:test|spec)\.|(?:^|\/)__tests__\/)/.test(f)).filter(f => affected.has(f) || changed.some(c => f.includes(c.split('/').pop()!.replace(/\.[^.]+$/, '')))).map(file => ({ file, provenance: affected.has(file) ? 'static' : 'heuristic', reason: affected.has(file) ? 'Imports affected code' : 'Filename association only' }));
  return { base, baseCommit, comparison: 'Base commit to current working tree, including staged and untracked files', changed, dependents, routes: affectedRoutes, tests, imports, gaps: [...new Set([...gaps, 'Static reachability is not runtime coverage. Observed navigation does not prove component execution.', 'Deleted files and nonliteral runtime wiring may hide additional dependencies.'])], scannedFiles: files.length };
}
