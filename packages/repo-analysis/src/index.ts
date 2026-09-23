import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { within } from '../../storage/src/index.ts';
export function git(path: string, args: string[]) { try { return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } }
export function snapshot(path: string) { return { branch: git(path, ['branch', '--show-current']) || 'No branch', commit: git(path, ['rev-parse', 'HEAD']) || 'unversioned', dirty: Boolean(git(path, ['status', '--porcelain'])), files: git(path, ['status', '--short']), commits: git(path, ['log', '-5', '--oneline']) }; }
export function detect(path: string) {
  let pkg: any = {}; try { pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')); } catch { /* non-Node repos are valid */ }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return { framework: deps.next ? 'Next.js' : deps.react ? 'React' : deps.vite ? 'Vite' : 'Node / other', packageManager: existsSync(join(path, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(path, 'yarn.lock')) ? 'yarn' : 'npm', gitRoot: git(path, ['rev-parse', '--show-toplevel']) || null };
}
export function safeSource(root: string, path: string) { const file = realpathSync(within(root, path)); within(realpathSync(root), file); return file; }
