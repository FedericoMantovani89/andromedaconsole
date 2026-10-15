// Two test conventions a reviewer should not have to remember (PITFALLS: "Windows and the terminals", "The mod, the guard and the agents"):
//  1. A test file that starts a server or a PtyManager says how its agents run: `usePipePty()` (plain pipes: the file never reads the
//     screen or its size) or an entry in REAL_TERMINAL below (it needs the real ConPTY). A new file has to pick one, so the ConPTY is only
//     used where a test needs it; on the GitHub runner it is the suspect of the native worker crashes.
//  2. Every guard rule id in src/server/guard/rules.ts appears in a guard test (test/guard-*.test.ts).
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');

// Files that start a server or a PtyManager and keep the real terminal. Take a file off this list when it moves to usePipePty().
const REAL_TERMINAL = new Set([
  'config-patch', 'dictation-server', 'git-clone', 'list-agents', 'main-resume-transcript', 'models-http', 'pick-folder', 'pipe-pty',
  'plugins-catalog', 'prereq-install-http', 'profiles-api', 'project-git-template-http', 'projects-http', 'pty-killtree', 'pty-manager',
  'questions-http', 'quota-http', 'reading-http', 'recovery-http', 'review-http', 'runtime-assembly', 'runtime-order', 'server',
  'spawn-git', 'spawn-multi-repo', 'spawn', 'template-detect', 'template-save', 'test-command-detect', 'test-commands', 'update-http',
  'v1', 'welcome-host',
]);

const problems: string[] = [];

for (const f of readdirSync(resolve(root, 'test')).filter(n => n.endsWith('.test.ts'))) {
  const name = f.slice(0, -'.test.ts'.length);
  const src = read(`test/${f}`);
  const starts = /\b(bootServer|startServer)\(|new PtyManager\(/.test(src);
  const pipe = src.includes('usePipePty') || src.includes('pipePty: true');
  if (starts && !pipe && !REAL_TERMINAL.has(name)) {
    problems.push(`test/${f} starts a server or a PtyManager without usePipePty(): call it (the file never reads the screen) or add '${name}' to REAL_TERMINAL in scripts/check-test-conventions.ts`);
  }
  if (pipe && REAL_TERMINAL.has(name)) problems.push(`test/${f} uses usePipePty(): take '${name}' off REAL_TERMINAL in scripts/check-test-conventions.ts`);
}

const ids = [...new Set([...read('src/server/guard/rules.ts').matchAll(/'((?:git|path|secret|rm|net|agent)\.[a-z][a-z.-]*)'/g)].map(m => m[1]!))];
const table = readdirSync(resolve(root, 'test')).filter(n => /^guard-.*\.test\.ts$/.test(n)).map(n => read(`test/${n}`)).join('\n');
for (const id of ids) {
  if (!table.includes(`'${id}'`)) problems.push(`guard rule '${id}' has no case in test/guard-*.test.ts: add a command it must refuse (and the everyday command next to it that must stay allowed)`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`check-test-conventions: ok (${ids.length} guard rules)`);
