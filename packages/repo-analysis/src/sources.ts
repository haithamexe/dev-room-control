import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import type { Project } from '../../core/src/index.ts';
import { safeSource } from './index.ts';
import { redactText } from '../../core/src/redact.ts';

export function permittedPath(project: Project, path: string) {
  const normalize = (value: string) => process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value.replaceAll('\\', '/');
  const excluded = (value: string) => /(^|\/)(\.env(?:\..*)?|\.git|node_modules|\.dcr)(\/|$)|\.(pem|key|p12|pfx)$/i.test(value) || project.config.ignorePaths.some(p => normalize(value).includes(normalize(p)));
  if (excluded(path.replaceAll('\\', '/'))) throw new Error('Source path is excluded by project privacy rules');
  const resolved = safeSource(project.path, path);
  if (excluded(relative(project.path, resolved).replaceAll('\\', '/'))) throw new Error('Resolved source path is excluded by project privacy rules');
  return resolved;
}
export function sourceText(project: Project, path: string) {
  const file = permittedPath(project, path);
  if (!statSync(file).isFile() || statSync(file).size > 256000) throw new Error('Source preview is limited to files up to 256 KB');
  let content = redactText(readFileSync(file, 'utf8'));
  const fields = ['password', 'secret', 'token', 'apiKey', 'authorization', ...project.config.redactFields];
  for (const field of fields) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    content = content.replace(new RegExp(`((?:[\\w$]*${escaped}[\\w$]*|["']${escaped}["'])\\s*[:=]\\s*)(["'\x60])[^\\r\\n]*?\\2`, 'gi'), '$1"[REDACTED]"');
  }
  return { path: file, content };
}
