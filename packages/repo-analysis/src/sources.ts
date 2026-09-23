import { readFileSync, statSync } from 'node:fs';
import type { Project } from '../../core/src/index.ts';
import { safeSource } from './index.ts';
import { redactText } from '../../core/src/redact.ts';

export function permittedPath(project: Project, path: string) {
  const normalized = path.replaceAll('\\', '/');
  if (/(^|\/)(\.env(?:\..*)?|\.git|node_modules|\.dcr)(\/|$)|\.(pem|key|p12|pfx)$/i.test(normalized) || project.config.ignorePaths.some(p => normalized.includes(p.replaceAll('\\', '/')))) throw new Error('Source path is excluded by project privacy rules');
  return safeSource(project.path, normalized);
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
