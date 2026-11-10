// Fails the build when language bundles are inconsistent or keys are unused (SPEC 5.9).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseProperties } from '../src/server/properties';
import { checkBundles, checkErrorCodes } from '../src/shared/i18n-checks';
import { USER_ERROR_CODES } from '../src/shared/protocol';
import { walk } from './walk.ts';

const root = resolve(import.meta.dirname, '..');
const i18nDir = join(root, 'src', 'i18n');

const bundles: Record<string, Record<string, string>> = {};
for (const f of readdirSync(i18nDir)) {
  const m = /^messages_(\w+)\.properties$/.exec(f);
  if (m) bundles[m[1]!] = parseProperties(readFileSync(join(i18nDir, f), 'utf8'));
}

// Keys appear as t('a.b'), bindText(el, 'a.b'), k('a.b') (marker for keys kept in data), or as a dynamic
// family: t('state.' + x) / t(`state.${x}`) -> every key starting with "state." counts as used.
const used = new Set<string>();
const dynamicPrefixes: string[] = [];
const files = [...walk(join(root, 'src', 'ui')), ...walk(join(root, 'src', 'server')), ...walk(join(root, 'src', 'shared')), ...walk(join(root, 'src', 'electron'))]
  .filter((f) => !f.endsWith('i18n-checks.ts'));
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/\b(?:t|k)\(\s*['"]([\w.]+)['"]\s*[,)]/g)) used.add(m[1]!);
  for (const m of text.matchAll(/\b(?:bindText|setPlaceholder|checkbox)\(\s*[^,]+,\s*['"]([\w.]+)['"]/g)) used.add(m[1]!);
  for (const m of text.matchAll(/\bsetIconButton\(\s*[^,]+,\s*['"]\w+['"],\s*['"]([\w.]+)['"]/g)) used.add(m[1]!); // an icon button's words are its tooltip key
  for (const m of text.matchAll(/\bt\(\s*['"]([\w.]+\.)['"]\s*\+/g)) dynamicPrefixes.push(m[1]!);
  for (const m of text.matchAll(/\bt\(\s*`([\w.]+\.)\$\{/g)) dynamicPrefixes.push(m[1]!);
  for (const m of text.matchAll(/\b(?:bindText|checkbox)\(\s*[^,]+,\s*`([\w.]+\.)\$\{/g)) dynamicPrefixes.push(m[1]!);
}

// Until the last UI file (wizard.ts) exists nothing can use the keys: parity checks still run, "unused" does not.
const uiExists = existsSync(join(root, 'src', 'ui', 'wizard.ts'));
const usedForCheck = uiExists ? used : new Set(Object.keys(bundles.en ?? {}));

const problems = [...checkBundles(bundles, usedForCheck, dynamicPrefixes), ...checkErrorCodes(bundles.en ?? {}, USER_ERROR_CODES)];
if (problems.length > 0) {
  for (const p of problems) console.error(`i18n: ${p}`);
  process.exit(1);
}
console.log(`i18n: ${Object.keys(bundles).join(', ')} consistent (${Object.keys(bundles.en ?? {}).length} keys)`);
