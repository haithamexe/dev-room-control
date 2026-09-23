import ts from 'typescript-parser';
import { relative, isAbsolute } from 'node:path';

export function instrumentJsx(code: string, file: string, root: string) {
  const name = relative(root, file).replaceAll('\\', '/');
  if (name.startsWith('../') || isAbsolute(name) || name.includes('node_modules/') || !/\.[jt]sx$/.test(name)) return code;
  const source = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if ((source as any).parseDiagnostics.length) return code;
  const edits: { offset: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (/^[a-z][\w-]*$/.test(tag) && !node.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(source).startsWith('data-dcr-'))) {
        let owner: ts.Node | undefined = node.parent, component = 'Anonymous';
        while (owner) {
          if ((ts.isFunctionDeclaration(owner) || ts.isClassDeclaration(owner)) && owner.name) { component = owner.name.text; break; }
          if ((ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) && ts.isVariableDeclaration(owner.parent) && ts.isIdentifier(owner.parent.name)) { component = owner.parent.name.text; break; }
          owner = owner.parent;
        }
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        edits.push({ offset: node.tagName.end, text: ` data-dcr-source={${JSON.stringify(name)}} data-dcr-line="${line}" data-dcr-component={${JSON.stringify(component)}} data-dcr-provenance="compiler"` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const edit of edits.sort((a, b) => b.offset - a.offset)) code = code.slice(0, edit.offset) + edit.text + code.slice(edit.offset);
  return code;
}

/** Vite development-only transform; add before the React plugin. No production metadata. */
export function dcrSourceBridge() {
  let root = process.cwd();
  return { name: 'dcr-source-bridge', apply: 'serve' as const, enforce: 'pre' as const, configResolved(config: { root: string }) { root = config.root; }, transform(code: string, id: string) { const file = id.split('?')[0]; const result = instrumentJsx(code, file, root); return result === code ? null : { code: result, map: null }; } };
}
