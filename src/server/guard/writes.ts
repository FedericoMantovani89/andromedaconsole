import { tmpdir } from 'node:os';
import { isInside } from './paths';
import { commandName } from './shell';

/** Not files: the null devices and the standard streams. */
const NULL_TARGET = /^(\/dev\/(null|stdout|stderr|tty)|nul|\$null|&\d+)$/i;
/** `>`, `>>`, `2>`, `&>`, `>&`: a redirection whose target is the next word. */
const OP = /^(?:\d*|&)>>?&?$/;
/** `>file`, `2>file`, `&>file`, `>>file`, `>&file` (but not `2>&1`): the target is attached. */
const ATTACHED = /^(?:\d*|&)>>?([^&>].*)$/;
const ATTACHED_AMP = /^>&([^\d&>].*)$/;
const isFlag = (t: string): boolean => /^-/.test(t);
const PATH_PARAMS = /^-(path|filepath|literalpath|destination)$/i;
const VALUE_PARAMS = /^-(value|encoding|itemtype|stream|inputobject)$/i;
/** xcopy and robocopy switches (`/E`, `/MIR`): not paths. A POSIX path has a second slash, so `/c/Users` is not one. */
const SWITCH = /^\/[A-Za-z?][A-Za-z0-9:,.-]*$/;

/** Commands that write, move or delete every non-flag word they are given. */
const ALL = new Set([
  'tee', 'touch', 'mkdir', 'md',
  'rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'unlink',
  'mv', 'move', 'move-item', 'mi',
]);
/** Commands whose first word is the file written; the words after it are values (`Set-Content f.txt text`). */
const FIRST = new Set([
  'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc', 'new-item', 'ni', 'rename-item', 'ren', 'rni',
  'mklink', // `mklink [/D] link target`: the link is written, not the target
]);
/** Copy commands: only the last word, the destination, is written. `ln -s target link`: the link is the last word. */
const LAST = new Set(['cp', 'copy', 'copy-item', 'cpi', 'ln']);
/** `xcopy src dst`, `robocopy src dst`: the second word. */
const SECOND = new Set(['xcopy', 'robocopy']);

export const DOWNLOADERS = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'certutil', 'bitsadmin', 'start-bitstransfer']);

/** PowerShell takes any unambiguous prefix of a parameter name (`-OutF` is `-OutFile`); these are the ones that name a file, with the shortest prefix that is unambiguous. */
const PS_FILE_PARAMS: Array<[string, number]> = [['outfile', 4], ['destination', 4]];
/** `curl -o f`, `wget -O f`, `wget -P dir`, `--output f`, `--output-document f`, `--output-dir d`, `--directory-prefix d`: the next word is written. */
const OUTPUT_FLAGS = /^(-o|-O|-P|--output|--output-document|--output-dir|--directory-prefix)$/;
const OUTPUT_LONG_EQ = /^(?:--output|--output-document|--output-dir|--directory-prefix)=(.+)$/;

/**
 * The file names a downloader command saves to: `-o f`, `-sLo f`, `-ofile`, `--output=f`, `-OutFile f`, `-OutF f`, `-Destination f`,
 * `wget -P dir`, `certutil -urlcache ... f`, `bitsadmin /transfer ... f`.
 */
export function downloadOutputs(name: string, argv: string[]): string[] {
  const out: string[] = [];
  argv.forEach((t, j) => {
    const next = argv[j + 1];
    const ps = /^-([A-Za-z]+)(?:[:=](.+))?$/.exec(t);
    if (ps && PS_FILE_PARAMS.some(([full, min]) => ps[1]!.length >= min && full.startsWith(ps[1]!.toLowerCase()))) {
      const value = ps[2] ?? next;
      if (value !== undefined) out.push(value);
      return;
    }
    if (OUTPUT_FLAGS.test(t)) { if (next !== undefined) out.push(next); return; }
    const long = OUTPUT_LONG_EQ.exec(t);
    if (long) { out.push(long[1]!); return; }
    if (/^-[A-Za-z]+o$/.test(t)) { if (next !== undefined) out.push(next); return; } // `curl -sLo f`: the short flags run together
    const attached = /^-o(.+)$/.exec(t);
    if (attached) out.push(attached[1]!);
  });
  if ((name === 'certutil' && argv.some((t) => /^-urlcache$/i.test(t))) || (name === 'bitsadmin' && argv.some((t) => /^[/-]transfer$/i.test(t)))) out.push(argv[argv.length - 1]!);
  return out;
}

const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** The commands whose `-t` names the folder they write into (for others `-t` is a tag, a sort order: `ls -t`, `docker build -t`). */
const TARGET_DIR_COMMANDS = new Set(['cp', 'mv', 'ln', 'install']);

/** `cp -t DIR f`, `cp -tDIR f`, `cp --target-directory DIR f`, `cp --target-directory=DIR f`: the directory is written, not the last word. */
function targetDirectories(name: string, rest: string[]): string[] {
  const out: string[] = [];
  if (!TARGET_DIR_COMMANDS.has(name)) return out;
  rest.forEach((t, i) => {
    const next = rest[i + 1];
    if (/^(-t|--target-directory)$/.test(t) && next !== undefined) out.push(next);
    const joined = /^--target-directory=(.+)$/.exec(t) ?? /^-t(.+)$/.exec(t);
    if (joined) out.push(joined[1]!);
  });
  return out;
}

/** git options that take a value as the next word (their value is not the repository URL or the folder). */
const CLONE_VALUE_FLAGS = new Set([
  '-b', '--branch', '--depth', '-o', '--origin', '--reference', '--reference-if-able', '--template', '-c', '--config', '-j', '--jobs', '--filter',
  '--server-option', '-u', '--upload-pack', '--shallow-since', '--shallow-exclude', '--bundle-uri', '--ref-format', '--separate-git-dir',
]);
/** git options before the subcommand that take a value as the next word. */
const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path']);

/** `git [-C dir] clone [options] URL [dir]`: the folder is written, and `-C`'s dir when none is given; `--separate-git-dir` writes too. */
function cloneTargets(argv: string[]): string[] {
  const out: string[] = [];
  let i = 1;
  while (i < argv.length) {
    const t = argv[i]!;
    if (GIT_GLOBAL_VALUE_FLAGS.has(t)) { if (t === '-C' && argv[i + 1] !== undefined) out.push(argv[i + 1]!); i += 2; continue; }
    if (t.startsWith('-')) { i++; continue; }
    break;
  }
  if ((argv[i] ?? '').toLowerCase() !== 'clone') return [];
  const positional: string[] = [];
  for (let j = i + 1; j < argv.length; j++) {
    const t = argv[j]!;
    if (t === '--separate-git-dir' && argv[j + 1] !== undefined) out.push(argv[j + 1]!);
    const eq = /^--separate-git-dir=(.+)$/.exec(t);
    if (eq) out.push(eq[1]!);
    if (CLONE_VALUE_FLAGS.has(t)) { j++; continue; }
    if (!t.startsWith('-')) positional.push(t);
  }
  if (positional[1] !== undefined) out.push(positional[1]);
  return out;
}

/** `sed -i`, `sed -i.bak`, `sed -ni`, `sed --in-place[=.bak]`; `perl -i`, `perl -pi`, `perl -i.bak`, `perl -pie`: the command rewrites its files. */
const SED_IN_PLACE = /^(-[a-zA-Z]*i|--in-place(=.*)?)$|^-i.+$/;
const PERL_IN_PLACE = /^-(?![IMm])[a-zA-Z]*i/; // not `-Ilib`, `-Mstrict`: those take a value that may contain an i
/** Options whose value is the next word: sed's script (`-e`, `-f`), perl's code and modules (`-e`, `-E`, `-M`, `-m`, `-I`). */
const SED_VALUE = /^(-e|-f|--expression|--file|-l|--line-length)$/;
const PERL_VALUE = /^-[a-zA-Z]*[eE]$|^-[MmI]$/;

/**
 * The files an in-place editor rewrites (`sed -i 's/a/b/' f1 f2`, `perl -pi -e 'code' f`): every word after the script. Without `-e`/`-f`
 * the first word is the script (sed) or the program file (perl), which is read, not written.
 */
function inPlaceTargets(name: string, rest: string[]): string[] {
  const inPlace = name === 'sed' ? SED_IN_PLACE : name === 'perl' ? PERL_IN_PLACE : undefined;
  if (!inPlace || !rest.some((t) => inPlace.test(t))) return [];
  const value = name === 'sed' ? SED_VALUE : PERL_VALUE;
  const words: string[] = [];
  let scriptGiven = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (OP.test(t)) { i++; continue; }
    if (/^(?:\d*|&)?>/.test(t)) continue;
    if (value.test(t)) { scriptGiven = true; i++; continue; }
    if (/^(--expression|--file)=/.test(t) || (name === 'perl' && /^-[a-zA-Z]*[eE].+/.test(t) && !/^-i/.test(t))) { scriptGiven = true; continue; }
    if (isFlag(t)) continue;
    words.push(t);
  }
  return scriptGiven ? words : words.slice(1);
}

/** Where a command's output is redirected to (`> f`, `>>f`, `2>f`); `2>&1` is not one. */
export function redirectTargets(argv: string[]): string[] {
  const out: string[] = [];
  const rest = argv.slice(1);
  rest.forEach((t, i) => {
    const next = rest[i + 1];
    if (OP.test(t)) { if (next !== undefined && !/^\d+$/.test(next)) out.push(next); return; }
    const attached = ATTACHED.exec(t) ?? ATTACHED_AMP.exec(t);
    if (attached) out.push(attached[1]!);
  });
  return out;
}

/** Every word the command writes, moves or deletes: redirect targets, named paths (`-Path`, `-Destination`) and the words its kind of command writes. */
export function writeTargets(argv: string[]): string[] {
  const name = commandName(argv[0] ?? '');
  const rest = argv.slice(1);
  const out = redirectTargets(argv);
  if (DOWNLOADERS.has(name)) out.push(...downloadOutputs(name, argv).filter((t) => !URL_LIKE.test(t)));
  out.push(...inPlaceTargets(name, rest));
  if (name === 'git') out.push(...cloneTargets(argv));
  const dirs = targetDirectories(name, rest);
  out.push(...dirs);
  const words: string[] = [];
  const isWriter = ALL.has(name) || FIRST.has(name) || LAST.has(name) || SECOND.has(name);
  let named = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (OP.test(t)) { i++; continue; } // a redirect operator and its target (already collected)
    if (/^(?:\d*|&)?>/.test(t)) continue; // a redirection with its target attached (collected above)
    if (VALUE_PARAMS.test(t)) { i++; continue; }
    if (PATH_PARAMS.test(t)) { if (rest[i + 1] !== undefined && isWriter && (ALL.has(name) || FIRST.has(name) || /destination/i.test(t))) { out.push(rest[i + 1]!); named = true; } i++; continue; }
    if (isFlag(t)) continue;
    if (/^\/[A-Za-z?]$/.test(t) || (SECOND.has(name) && SWITCH.test(t))) continue; // `rd /s /q`, `del /q`: cmd switches, not paths
    words.push(t);
  }
  if (ALL.has(name)) out.push(...words);
  else if (!named && FIRST.has(name) && words[0] !== undefined) out.push(words[0]);
  else if (!named && dirs.length === 0 && LAST.has(name) && words.length > 0) out.push(words[words.length - 1]!);
  else if (!named && SECOND.has(name) && words[1] !== undefined) out.push(words[1]);
  return out;
}

export const isNullDevice = (target: string): boolean => NULL_TARGET.test(target.replace(/^["']|["']$/g, ''));

/** The first target outside the worktree. The null devices and the system temp folder are the two allowed places outside it. */
export function firstOutside(targets: string[], worktree: string, cwd: string): string | undefined {
  return targets.find((t) => !isNullDevice(t) && !isInside(worktree, t, cwd) && !isInside(tmpdir(), t, cwd));
}
