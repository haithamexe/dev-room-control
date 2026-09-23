import ts from 'typescript-parser';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { Project } from '../../core/src/index.ts';
import { permittedPath } from './sources.ts';

/** TypeScript resolves JSONC/extends/baseUrl/paths without loading repository code. */
export function importResolver(project: Project, files: string[], gaps: string[]) {
  const normalize = (file: string) => ts.sys.useCaseSensitiveFileNames ? resolve(file) : resolve(file).toLowerCase();
  const known = new Set(files.map(file => normalize(resolve(project.path, file))));
  const safeRead = (path: string) => {
    try { const file = permittedPath(project, relative(project.path, path)); if (statSync(file).size > 256000) return; return readFileSync(file, 'utf8'); } catch { return; }
  };
  let options: ts.CompilerOptions = { allowJs: true, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };
  const config = ['tsconfig.json', 'jsconfig.json'].map(file => resolve(project.path, file)).find(existsSync);
  if (config) {
    const json = ts.readConfigFile(config, safeRead);
    if (json.error) gaps.push('Project compiler configuration could not be read under the source privacy rules');
    else {
      const parsed = ts.parseJsonConfigFileContent(json.config, { useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames, readDirectory: () => [], fileExists: path => safeRead(path) !== undefined, readFile: safeRead }, project.path, undefined, config);
      options = { ...options, ...parsed.options };
      if (parsed.errors.some(error => error.code !== 18003)) gaps.push('Compiler configuration has unsupported or inaccessible settings; import resolution may be incomplete');
    }
  }
  return (file: string, spec: string) => {
    const result = ts.resolveModuleName(spec, resolve(project.path, file), options, { fileExists: path => known.has(normalize(path)), readFile: safeRead }).resolvedModule;
    if (result && known.has(normalize(result.resolvedFileName))) return relative(project.path, result.resolvedFileName).replaceAll('\\', '/');
    if (spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('~/') || Object.keys(options.paths || {}).some(alias => spec.startsWith(alias.split('*')[0]))) gaps.push(`${file}: unresolved project import ${spec}`);
  };
}
