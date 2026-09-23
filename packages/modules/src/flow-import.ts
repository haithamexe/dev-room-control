import ts from 'typescript-parser';
import { flowSchema } from '../../core/src/index.ts';

/** Parse a deliberately bounded declarative subset. Imported JavaScript is never evaluated. */
export function importPlaywright(source: string) {
  if (source.length > 200000) throw new Error('Scripts must be at most 200 KB');
  const file = ts.createSourceFile('import.spec.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics: string[] = [], steps: any[] = [];
  let name = 'Imported Playwright flow', tests = 0;
  const literal = (node?: ts.Node): any => {
    if (!node) return undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(p => {
      if (!ts.isPropertyAssignment(p)) throw new Error('Use literal options');
      return [p.name.getText(file).replace(/^['"]|['"]$/g, ''), literal(p.initializer)];
    }));
    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.getText(file) === 'process.env') return { env: node.name.text };
    throw new Error('Dynamic expressions require manual steps');
  };
  const locator = (node: ts.Expression): any => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) throw new Error('Use getByLabel, getByRole or getByText locators');
    const method = node.expression.name.text, parent = node.expression.expression;
    if (node.arguments.length > 2) throw new Error('Unsupported locator options');
    const options = node.arguments[1] ? literal(node.arguments[1]) : {};
    if (!options || typeof options !== 'object' || Object.keys(options).some(key => !['exact', ...(method === 'getByRole' ? ['name'] : [])].includes(key))) throw new Error('Unsupported locator options');
    const frames: string[] = [];
    let root = parent;
    while (ts.isCallExpression(root) && ts.isPropertyAccessExpression(root.expression) && root.expression.name.text === 'frameLocator') { frames.unshift(literal(root.arguments[0])); root = root.expression.expression; }
    if (root.getText(file) !== 'page') throw new Error('Use the page fixture');
    const scope = { exact: options.exact ?? false, ...(frames.length ? { frames } : {}) };
    if (method === 'getByLabel') return { ...scope, label: literal(node.arguments[0]) };
    if (method === 'getByRole') return { ...scope, role: literal(node.arguments[0]), name: literal(node.arguments[1])?.name };
    if (method === 'getByText') return { ...scope, text: literal(node.arguments[0]) };
    throw new Error('Unsupported locator');
  };
  const statement = (node: ts.Statement) => {
    try {
      if (!ts.isExpressionStatement(node)) throw new Error('Control flow, declarations and helpers require manual review');
      const expr = ts.isAwaitExpression(node.expression) ? node.expression.expression : node.expression;
      if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) throw new Error('Unsupported statement');
      const method = expr.expression.name.text, receiver = expr.expression.expression;
      let step: any;
      if (receiver.getText(file) === 'page') {
        const action = ({ goto: 'goto', reload: 'reload', goBack: 'back', goForward: 'forward' } as Record<string, string>)[method];
        if (!action || expr.arguments.length > (action === 'goto' ? 1 : 0)) throw new Error('Unsupported page action or options');
        step = { action, ...(action === 'goto' ? { url: literal(expr.arguments[0]) } : {}) };
      } else if (ts.isCallExpression(receiver) && receiver.expression.getText(file) === 'expect' && method === 'toBeVisible') {
        const target = locator(receiver.arguments[0]); if (!target.text || expr.arguments.length) throw new Error('Visible assertions require getByText without options');
        step = { action: 'assertText', ...target };
      } else {
        const target = locator(receiver);
        if (method === 'click' && target.name && !expr.arguments.length) step = { action: 'click', ...target };
        else if (['fill', 'selectOption', 'setInputFiles'].includes(method) && target.label && expr.arguments.length === 1) {
          const value = literal(expr.arguments[0]);
          if (method === 'setInputFiles' && !value?.env) throw new Error('Uploads need a process.env reference');
          step = { action: method === 'fill' ? 'fill' : method === 'selectOption' ? 'select' : 'upload', ...target, ...(typeof value === 'string' ? { value } : value) };
        } else if (['check', 'uncheck', 'setChecked'].includes(method) && target.label && expr.arguments.length === (method === 'setChecked' ? 1 : 0)) step = { action: 'check', ...target, checked: method === 'setChecked' ? literal(expr.arguments[0]) : method === 'check' };
        else throw new Error('Unsupported locator action or options');
      }
      steps.push(flowSchema.shape.steps.element.parse(step));
    } catch (error) { diagnostics.push(`Line ${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${error instanceof Error ? error.message : 'Unsupported syntax'}`); }
  };
  for (const node of file.statements) {
    if (ts.isImportDeclaration(node)) continue;
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(file) === 'test') {
      tests++;
      if (tests > 1) { diagnostics.push('Only one test can be imported at a time'); continue; }
      try { name = literal(node.expression.arguments[0]); } catch {}
      const callback = node.expression.arguments[1];
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && ts.isBlock(callback.body)) callback.body.statements.forEach(statement);
      else diagnostics.push('Expected a test callback with a block body');
    } else diagnostics.push(`Line ${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: Setup, hooks and other top-level code require manual review`);
  }
  if ((file as any).parseDiagnostics.length) diagnostics.push('Script contains syntax errors');
  if (!tests) diagnostics.push('No test(...) block found');
  return { flow: { name: typeof name === 'string' ? name : 'Imported flow', description: 'Imported from Playwright. Review the conversion before saving.', steps }, diagnostics };
}
