import * as tsNs from 'typescript';

// typescript is CommonJS: under native ESM (vitest) the API sits on `default`.
const ts = ((tsNs as unknown as { default?: typeof tsNs }).default ?? tsNs) as typeof tsNs;

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort().join(',');
const baseKey = (k: string) => k.replace(/\.(one|other)$/, '');

/** Returns every problem found across the language bundles; empty means the bundles are consistent. */
export function checkBundles(
  bundles: Record<string, Record<string, string>>, usedKeys: Set<string>, dynamicPrefixes: string[],
): string[] {
  const problems: string[] = [];
  const ref = bundles.en;
  if (!ref) return ['en: reference bundle is missing'];
  for (const u of usedKeys) {
    const defined = u in ref || (`${u}.one` in ref && `${u}.other` in ref);
    if (!defined) problems.push(`en: key "${u}" is used in code but not defined`);
  }
  for (const [lang, b] of Object.entries(bundles)) {
    if (lang !== 'en') {
      for (const k of Object.keys(ref)) if (!(k in b)) problems.push(`${lang}: missing key "${k}"`);
      for (const k of Object.keys(b)) if (!(k in ref)) problems.push(`${lang}: extra key "${k}"`);
      for (const k of Object.keys(b)) {
        if (k in ref && placeholders(b[k]!) !== placeholders(ref[k]!)) problems.push(`${lang}: "${k}" placeholders differ from en`);
      }
    }
    for (const k of Object.keys(b)) {
      // A ".other" without ".one" is legal (languages without a singular form); the reverse is not.
      if (k.endsWith('.one') && !(`${baseKey(k)}.other` in b)) problems.push(`${lang}: "${k}" has no "${baseKey(k)}.other"`);
      const used = usedKeys.has(k) || usedKeys.has(baseKey(k)) || dynamicPrefixes.some((p) => k.startsWith(p));
      if (!used) problems.push(`${lang}: unused key "${k}"`);
    }
  }
  return problems;
}

/** Every user-facing server error code must have an `error.<code>` text in the reference bundle. */
export function checkErrorCodes(en: Record<string, string>, codes: readonly string[]): string[] {
  return codes.filter((c) => !(`error.${c}` in en)).map((c) => `en: no key "error.${c}" for error code "${c}"`);
}

const VISIBLE_PROPS = new Set(['textContent', 'innerText', 'innerHTML', 'title', 'placeholder', 'alt', 'ariaLabel', 'label']);
const VISIBLE_ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label']);

/** Literal strings assigned to user-visible DOM properties/attributes (they must come from t()). */
export function findUiLiterals(sourceText: string, fileName: string): { line: number; text: string }[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true);
  const found: { line: number; text: string }[] = [];
  const isText = (n: tsNs.Node): n is tsNs.StringLiteral | tsNs.NoSubstitutionTemplateLiteral =>
    ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
  const report = (n: tsNs.Node, text: string) =>
    found.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text });
  const visit = (n: tsNs.Node) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(n.left) && VISIBLE_PROPS.has(n.left.name.text)
        && isText(n.right) && n.right.text.trim() !== '') {
      report(n.right, n.right.text);
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'setAttribute') {
      const [name, value] = n.arguments;
      if (name && value && isText(name) && VISIBLE_ATTRS.has(name.text) && isText(value) && value.text.trim() !== '') report(value, value.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** Lines (1-based) that call `.focus(` outside comments. */
export function findStrayFocus(sourceText: string): number[] {
  const sf = ts.createSourceFile('x.ts', sourceText, ts.ScriptTarget.ES2022, true);
  const lines: number[] = [];
  const visit = (n: tsNs.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'focus') {
      lines.push(sf.getLineAndCharacterOfPosition(n.getStart()).line + 1);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

/**
 * Buttons created as `el('button', ...)` or `document.createElement('button')` that never go through `setIconButton(name, ...)` in the same
 * file: a button shows an icon and its words are the tooltip. `name` is the variable the button is kept in ('' when it is not kept).
 */
export function findTextOnlyButtons(sourceText: string): { line: number; name: string }[] {
  const sf = ts.createSourceFile('x.ts', sourceText, ts.ScriptTarget.ES2022, true);
  const iconed = new Set<string>();
  const created: { line: number; name: string }[] = [];
  const nameOf = (n: tsNs.Expression): string => (ts.isIdentifier(n) ? n.text : ts.isPropertyAccessExpression(n) ? n.name.text : '');
  const isButtonCall = (n: tsNs.Node): n is tsNs.CallExpression => {
    if (!ts.isCallExpression(n)) return false;
    const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ts.isIdentifier(n.expression) ? n.expression.text : '';
    const first = n.arguments[0];
    return (callee === 'el' || callee === 'createElement') && first !== undefined && ts.isStringLiteralLike(first) && first.text === 'button';
  };
  const visit = (n: tsNs.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'setIconButton' && n.arguments[0]) iconed.add(nameOf(n.arguments[0]));
    if (isButtonCall(n)) {
      const p = n.parent;
      const name = ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) ? p.name.text : ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken ? nameOf(p.left) : '';
      created.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, name });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return created.filter((c) => c.name === '' || !iconed.has(c.name));
}
