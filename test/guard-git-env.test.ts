import { describe, expect, it } from 'vitest';
import { GIT_BUILTINS } from '../src/server/guard/gitrefs';
import { verdict, type Row } from './guard-table';

const BASH_ENV = 'GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=nul git p origin HEAD:main';
const PS_ENV = '$env:GIT_CONFIG_COUNT=2; $env:GIT_CONFIG_KEY_0="alias.p"; $env:GIT_CONFIG_VALUE_0="push"; $env:GIT_CONFIG_KEY_1="core.hooksPath"; $env:GIT_CONFIG_VALUE_1="nul"; git p origin HEAD:main';

describe('git environment that changes config, hooks or programs', () => {
  const bash: Row[] = [
    [BASH_ENV, 'git.config-write'],
    ['GIT_DIR=../other/.git git status', 'git.config-write'],
    ['env GIT_SSH_COMMAND=evil git fetch', 'git.config-write'],
    ['export GIT_CONFIG_COUNT=1; git status', 'git.config-write'],
    ['unset GIT_CONFIG_COUNT; git push origin HEAD', 'git.config-write'],
    ['env -u GIT_CONFIG_COUNT git push origin HEAD', 'git.config-write'],
    ['env --unset=GIT_CONFIG_KEY_0 git status', 'git.config-write'],
    ['env -i git status', 'git.config-write'],
    ['env GIT_CONFIG_COUNT=0 git status', 'git.config-write'],
    ['env PAGER=cat git log', 'ALLOW'],
    ['git p origin HEAD:main', 'git.alias'],
    ['git wipe-everything', 'git.alias'],
    // Harmless variables and external commands stay allowed (Review Focus 4).
    ['GIT_TERMINAL_PROMPT=0 git fetch', 'ALLOW'],
    ['GIT_PAGER=cat git log', 'ALLOW'],
    ['git lfs pull', 'ALLOW'],
    ['git grep TODO', 'ALLOW'],
    ['git merge-tree HEAD HEAD', 'ALLOW'],
    ['git', 'ALLOW'],
  ];
  it.each(bash)('bash: %s -> %s', (c, e) => expect(verdict(c)).toBe(e));

  const ps: Row[] = [
    [PS_ENV, 'git.config-write'],
    ['Set-Item env:GIT_CONFIG_COUNT 1', 'git.config-write'],
    ['Remove-Item env:GIT_CONFIG_COUNT', 'git.config-write'],
    ['$env:GIT_PAGER="cat"; git log', 'ALLOW'],
  ];
  it.each(ps)('powershell: %s -> %s', (c, e) => expect(verdict(c, { tool: 'PowerShell' })).toBe(e));

  const programs: Row[] = [
    ['node -e "require(\'child_process\').execSync(\'git push origin HEAD:main\')"', 'git.commit-push'],
    ['python3 -c "import subprocess; subprocess.run([\'git\',\'commit\',\'-m\',\'x\'])"', 'git.commit-push'],
    ['node -e "require(\'child_process\').spawnSync(\'git\', [\'push\'])"', 'git.commit-push'],
    ["python - <<'EOF'\nimport subprocess\nsubprocess.run(['git', 'push', 'origin', 'HEAD:main'])\nEOF", 'git.commit-push'],
    ['perl -e \'system("git commit --allow-empty -m x")\'', 'git.commit-push'],
    // A program that does not run git, or only reads from it, stays allowed.
    ['node -e "console.log(1)"', 'ALLOW'],
    ['python -c "print(\'push the button\')"', 'ALLOW'],
    ['node scripts/build.js', 'ALLOW'],
    ['git log --oneline | node -e "process.stdin.pipe(process.stdout)"', 'ALLOW'],
  ];
  it.each(programs)('a program on the command line: %s -> %s', (c, e) => expect(verdict(c)).toBe(e));
  it('the rule is for agents: the main may commit, so a program of the main that does is not refused (SPEC 9.5, known limits)', () => {
    expect(verdict('git commit -m x', { role: 'main' })).toBe('ALLOW');
    expect(verdict(programs[0]![0], { role: 'main' })).toBe('ALLOW');
  });

  it('the main is denied with the hooks rule (it is a main rule)', () => {
    expect(verdict(BASH_ENV, { role: 'main' })).toBe('git.hooks-tamper');
    expect(verdict('GIT_PAGER=cat git log', { role: 'main' })).toBe('ALLOW');
  });

  it('GIT_BUILTINS holds every subcommand the rules name', () => {
    for (const sub of ['push', 'send-pack', 'http-push', 'commit', 'tag', 'branch', 'update-ref', 'symbolic-ref', 'worktree', 'switch', 'checkout', 'merge', 'rebase', 'pull', 'cherry-pick', 'am', 'reset', 'remote', 'config', 'status', 'diff', 'log', 'show', 'add', 'stash', 'fetch', 'rev-parse', 'lfs']) {
      expect(GIT_BUILTINS.has(sub), sub).toBe(true);
    }
  });
});
