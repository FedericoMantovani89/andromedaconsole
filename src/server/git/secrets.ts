/** Files that must never be committed by the console (SPEC 9.3). Matched on the base name, or on the whole path when the pattern has a slash. */
export const DEFAULT_SECRET_PATTERNS: string[] = [
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials', 'credentials.json', 'credentials.yml', 'credentials.yaml', 'credentials.xml', 'credentials.toml',
];

/** A file with one of these suffixes is a model for the real one (`.env.example`; `esempio` is the Italian word): no secret in it. */
export const TEMPLATE_SUFFIX = /\.(example|esempio|sample|template|dist)$/i;
const SPECIALS = /[.+^${}()|[\]\\]/g;

const toRegExp = (pattern: string): RegExp =>
  new RegExp(`^${pattern.replace(SPECIALS, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`, 'i');

/** A glob word (`*`, `?`, `[..]`) as a regular expression over one path component. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else { re += `[${glob.slice(i + 1, end).replace(/\\/g, '\\\\')}]`; i = end; }
    } else re += c.replace(SPECIALS, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Names a secret pattern can stand for: each `*` as nothing and as one letter, each `?` as one letter (`.env.*` -> `.env.`, `.env.x`). */
function sampleNames(pattern: string): string[] {
  const base = pattern.slice(pattern.lastIndexOf('/') + 1);
  return [base.replace(/\*/g, '').replace(/\?/g, 'x'), base.replace(/\*/g, 'x').replace(/\?/g, 'x')];
}

/**
 * Whether a word with wildcards (`.env*`, `.e*`) could expand to a secret's name. A word with fewer than two literal characters
 * (`*`, `.*`, `*.*`), or that opens with a wildcard (`*.json`), says too little to tell and is not refused: `grep -r foo *` is an everyday
 * command. (`*.pem` and the like are still caught: they match their own pattern.)
 */
export function globMayMatchSecret(word: string, patterns: string[]): boolean {
  const normalized = word.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (!/[*?[]/.test(base)) return false;
  if (base.replace(/[*?[\]]/g, '').length < 2) return false;
  // A word that opens with a wildcard (`*.json`, `*.j*`) would match a secret only through its extension, and so every ordinary file of that type.
  if (/^[*?]/.test(base)) return false;
  const re = globToRegExp(base);
  return patterns.some((p) => sampleNames(p).some((n) => n !== '' && !TEMPLATE_SUFFIX.test(n) && re.test(n)));
}

/** Returns the files (as given) that match any pattern. */
export function findSecrets(files: string[], patterns: string[]): string[] {
  const compiled = patterns.map((p) => ({ withDir: p.includes('/'), re: toRegExp(p) }));
  return files.filter((file) => {
    const normalized = file.replace(/\\/g, '/');
    const base = normalized.slice(normalized.lastIndexOf('/') + 1);
    if (TEMPLATE_SUFFIX.test(base)) return false; // `.env.example` and friends are meant to be committed
    return compiled.some((c) => c.re.test(c.withDir ? normalized : base));
  });
}
