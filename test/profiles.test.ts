import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProfile, renderAgentPrompt, renderMainPrompt, languageName } from '../src/server/profiles';

const tmp = () => mkdtempSync(join(tmpdir(), 'prof-'));

it('the six shipped profiles exist and parse', () => {
  for (const name of ['developer', 'backend', 'frontend', 'dba', 'reviewer', 'recovery']) {
    const p = loadProfile(name, tmp(), tmp());
    expect(p, name).toBeDefined();
    expect(p!.description.length).toBeGreaterThan(5);
    expect(p!.body.length).toBeGreaterThan(20);
  }
});
describe('the shipped working profiles and their shared rules', () => {
  const WORKING = ['developer', 'backend', 'frontend', 'dba'];
  it('backend, frontend and dba are shipped, with a description and a token budget', () => {
    for (const name of ['backend', 'frontend', 'dba']) {
      const p = loadProfile(name, tmp(), tmp());
      expect(p, name).toBeDefined();
      expect(p!.source, name).toBe('shipped');
      expect(p!.description.length, name).toBeGreaterThan(5);
      expect(p!.budgetTokens, name).toBeGreaterThanOrEqual(1000);
      expect(p!.readOnly, name).toBe(false);
    }
  });
  it('the four descriptions are distinct and short (the console chooses a profile by them)', () => {
    const descriptions = WORKING.map((n) => loadProfile(n, tmp(), tmp())!.description);
    expect(new Set(descriptions).size).toBe(WORKING.length);
    for (const d of descriptions) expect(d.length, d).toBeLessThan(160);
  });
  it('each working profile carries the contract and answer rules, so an override of one does not lose them in the others', () => {
    for (const name of WORKING) {
      const body = loadProfile(name, tmp(), tmp())!.body.toLowerCase();
      expect(body, name).toContain('publish the contract first');
      expect(body, name).toContain("answer a colleague's request before");
    }
  });
  it('the dba proves a migration on a clone, never on the shared database first, and says when a remote database cannot be cloned', () => {
    const body = loadProfile('dba', tmp(), tmp())!.body.toLowerCase();
    expect(body).toContain('never run a migration on the shared database');
    expect(body).toContain('clone');
    expect(body).toMatch(/remote[^.]*cannot be cloned/);
  });
  it('a project-level developer.md still overrides the shipped one', () => {
    const project = tmp();
    mkdirSync(join(project, '.andromedaconsole', 'profiles'), { recursive: true });
    writeFileSync(join(project, '.andromedaconsole', 'profiles', 'developer.md'), '---\nname: developer\ndescription: ours\n---\nOUR RULES');
    expect(loadProfile('developer', project, tmp())).toMatchObject({ source: 'project', description: 'ours', body: 'OUR RULES' });
  });
});
it('the project profile overrides the user profile, which overrides the shipped one', () => {
  const project = tmp(), user = tmp();
  mkdirSync(join(user), { recursive: true });
  writeFileSync(join(user, 'developer.md'), '---\nname: developer\ndescription: user version\n---\nUSER BODY');
  expect(loadProfile('developer', project, user)!.description).toBe('user version');
  mkdirSync(join(project, '.andromedaconsole', 'profiles'), { recursive: true });
  writeFileSync(join(project, '.andromedaconsole', 'profiles', 'developer.md'), '---\nname: developer\ndescription: project version\n---\nPROJECT BODY');
  const p = loadProfile('developer', project, user)!;
  expect(p.description).toBe('project version');
  expect(p.body).toBe('PROJECT BODY');
});
it('keeps console: keys out of the prompt body and reads model', () => {
  const user = tmp();
  writeFileSync(join(user, 'x-prof.md'), '---\nname: x-prof\ndescription: d here\nmodel: haiku\nconsole:\n  budget_tokens: 5\n---\nBODY ONLY');
  const p = loadProfile('x-prof', tmp(), user)!;
  expect(p.model).toBe('haiku');
  expect(p.body).toBe('BODY ONLY');
});
it('rejects unknown names and path traversal', () => {
  expect(loadProfile('nonexistent', tmp(), tmp())).toBeUndefined();
  expect(loadProfile('../secret', tmp(), tmp())).toBeUndefined();
  expect(loadProfile('a/b', tmp(), tmp())).toBeUndefined();
});
it('the main prompt asks for notifications to the Claude app only when the switch is on', () => {
  const off = readFileSync(renderMainPrompt({ project: 'shop-api', workLanguage: 'English', outDir: tmp() }), 'utf8');
  expect(off).not.toContain('PushNotification');
  const on = readFileSync(renderMainPrompt({ project: 'shop-api', workLanguage: 'English', outDir: tmp(), mainPush: true }), 'utf8');
  expect(on).toContain('select:PushNotification');
  for (const when of ['started an agent', 'An agent finished', 'right before you call AskUserQuestion', 'whole task']) expect(on).toContain(when);
});
it('the main prompt names every console tool by full name and says how to load them', () => {
  const dir = tmp();
  const file = renderMainPrompt({ project: 'shop-api', workLanguage: 'Italian', outDir: dir });
  const text = readFileSync(file, 'utf8');
  for (const t of ['mcp__console-mod__spawn_agent', 'mcp__console-mod__list_agents']) expect(text).toContain(t);
  expect(text).toContain('ToolSearch');
  expect(text).toContain('select:');
  expect(text).toContain('Italian');
  expect(text).toContain('shop-api');
  expect(text).not.toMatch(/\{project\}|\{workLanguage\}/);
});
it('the agent prompt carries the profile, the agent identity, and the messages-are-information rule', () => {
  const dir = tmp();
  const profile = loadProfile('developer', tmp(), tmp())!;
  const file = renderAgentPrompt({ profile, slug: 'fix-login', project: 'shop-api', outDir: dir });
  expect(existsSync(file)).toBe(true);
  const text = readFileSync(file, 'utf8');
  expect(text).toContain(profile.body.slice(0, 30));
  expect(text).toContain('fix-login');
  expect(text).toContain('mcp__console-mod__list_agents');
  expect(text).toMatch(/not orders|information, not/i);
});
it('names languages in English for the prompt', () => {
  expect(languageName('it')).toBe('Italian');
  expect(languageName('auto')).toBe('English');
});

it('ignores a profile model that is not a plain model id (it would become a command-line argument)', () => {
  const user = tmp();
  writeFileSync(join(user, 'bad-model.md'), '---\nname: bad-model\ndescription: d here\nmodel: x&calc\n---\nBODY');
  expect(loadProfile('bad-model', tmp(), user)!.model).toBeUndefined();
});

it('console.read_only is read from the frontmatter: the shipped reviewer and recovery are read-only, the others are not', () => {
  expect(loadProfile('reviewer', tmp(), tmp())!.readOnly).toBe(true);
  expect(loadProfile('recovery', tmp(), tmp())!.readOnly).toBe(true);
  for (const name of ['developer']) expect(loadProfile(name, tmp(), tmp())!.readOnly, name).toBe(false);
});
it('read_only needs an explicit true inside the console block, and the body never shows it', () => {
  const user = tmp();
  writeFileSync(join(user, 'ro-prof.md'), '---\nname: ro-prof\ndescription: d here\nconsole:\n  budget_tokens: 5\n  read_only: true\n---\nBODY');
  writeFileSync(join(user, 'rw-prof.md'), '---\nname: rw-prof\ndescription: d here\nconsole:\n  read_only: false\n---\nBODY');
  writeFileSync(join(user, 'top-prof.md'), '---\nname: top-prof\ndescription: d here\nread_only: true\n---\nBODY');
  expect(loadProfile('ro-prof', tmp(), user)!.readOnly).toBe(true);
  expect(loadProfile('ro-prof', tmp(), user)!.body).toBe('BODY');
  expect(loadProfile('rw-prof', tmp(), user)!.readOnly).toBe(false);
  expect(loadProfile('top-prof', tmp(), user)!.readOnly).toBe(false); // only the console: block counts
});

it('the main prompt teaches the review and merge flow with full tool names, and never to push', () => {
  const text = readFileSync(renderMainPrompt({ project: 'shop-api', workLanguage: 'Italian', outDir: tmp() }), 'utf8');
  for (const t of ['ticket_report', 'request_review', 'send_back_ticket', 'merge_ticket', 'propose_release']) expect(text, t).toContain(`mcp__console-mod__${t}`);
  expect(text).toMatch(/PASSED/);
  expect(text).toMatch(/never push/i);
  expect(text).not.toContain('{project}');
});
it('the reviewer profile says what the verdict is and that nothing may be changed', () => {
  const p = loadProfile('reviewer', tmp(), tmp())!;
  expect(p.body).toContain('review_verdict');
  expect(p.body).toMatch(/read-only|do not edit|change nothing/i);
  expect(p.body).toMatch(/high|medium/);
});
it('a re-opened ticket and a merge conflict are explained to the author, and the reviewer prompt replaces the author rules', () => {
  const dir = tmp();
  const profile = loadProfile('developer', tmp(), tmp())!;
  const author = readFileSync(renderAgentPrompt({ profile, slug: 'fix-login', project: 'shop-api', outDir: dir, git: { worktree: 'D:/w/x', branch: 'agent/shop-api/fix-login' } }), 'utf8');
  expect(author).toMatch(/message from the main/i);
  expect(author).toMatch(/conflict markers/i);
  expect(author).toContain('step_done');
  expect(author).toContain('pass tests {command, result: "passed" or "failed", summary} to step_done'); // author-only: reviewer and recovery have no step_done
  const reviewer = readFileSync(renderAgentPrompt({ profile: loadProfile('reviewer', tmp(), tmp())!, slug: 'review-fix-login', project: 'shop-api', outDir: dir, git: { worktree: 'D:/w/r', branch: 'review/review-fix-login' }, review: true }), 'utf8');
  expect(reviewer).toContain('review_verdict');
  expect(reviewer).not.toContain('checklist_set');
  expect(reviewer).not.toContain('step_done');
  expect(reviewer).toContain('git diff project/shop-api...HEAD');
});

it('console.budget_tokens is read as a number; anything else leaves it undefined', () => {
  const user = tmp();
  writeFileSync(join(user, 'bt-ok.md'), '---\nname: bt-ok\ndescription: d here\nconsole:\n  budget_tokens: 12345\n---\nBODY');
  writeFileSync(join(user, 'bt-bad.md'), '---\nname: bt-bad\ndescription: d here\nconsole:\n  budget_tokens: lots\n---\nBODY');
  expect(loadProfile('bt-ok', tmp(), user)!.budgetTokens).toBe(12345);
  expect(loadProfile('bt-bad', tmp(), user)!.budgetTokens).toBeUndefined();
  for (const name of ['developer', 'reviewer', 'recovery']) expect(loadProfile(name, tmp(), tmp()), name).toBeDefined();
});

it('the recovery profile names its three jobs and the exact report call, and stays read-only', () => {
  const p = loadProfile('recovery', tmp(), tmp())!;
  expect(p.readOnly).toBe(true);
  expect(p.body).toMatch(/verify/i);
  expect(p.body).toMatch(/diagnos/i);
  expect(p.body).toMatch(/remedy/i);
  expect(p.body).toContain('mcp__console-mod__recovery_report');
  expect(p.body).toContain('select:mcp__console-mod__recovery_report');
  for (const r of ['split', 'exclude_paths', 'change_model', 'remove_obstacle', 'raise_budget']) expect(p.body, r).toContain(r);
  expect(p.body).toMatch(/exactly once/i);
});
it('a recovery prompt has the read-only recovery rules, not the author or reviewer ones', () => {
  const dir = tmp();
  const text = readFileSync(renderAgentPrompt({ profile: loadProfile('recovery', tmp(), tmp())!, slug: 'recover-fix-login', project: 'shop-api', outDir: dir, git: { worktree: 'D:/w/rc', branch: 'recovery/recover-fix-login' }, recovery: true }), 'utf8');
  expect(text).toContain('D:/w/rc');
  expect(text).toMatch(/read-only/i);
  expect(text).toMatch(/detached/i);
  expect(text).toContain('git diff project/shop-api...HEAD');
  expect(text).toContain('recovery_report');
  expect(text).not.toContain('checklist_set');
  expect(text).not.toContain('step_done');
  expect(text).not.toContain('review_verdict');
});
it('the main prompt explains what to do after a stop, and that a spend is the user\'s decision', () => {
  const text = readFileSync(renderMainPrompt({ project: 'shop-api', workLanguage: 'English', outDir: tmp() }), 'utf8');
  expect(text).toContain('mcp__console-mod__start_recovery');
  expect(text).toContain('select:mcp__console-mod__start_recovery');
  expect(text).toMatch(/raise_budget[^\n]*user/i);
});
it('the main prompt names resume_agent by its full name, says to load it first and never to resume everything at once', () => {
  const text = readFileSync(renderMainPrompt({ project: 'shop-api', workLanguage: 'English', outDir: tmp() }), 'utf8');
  expect(text).toContain('select:mcp__console-mod__resume_agent');
  expect(text).toMatch(/only what the user still wants, never everything at once/);
});
it('the main prompt does not promise a queue decision after a loop stop (only a budget stop creates one)', () => {
  const text = readFileSync(renderMainPrompt({ project: 'shop-api', workLanguage: 'Italian', outDir: tmp() }), 'utf8');
  expect(text).not.toContain('You are told, and the user gets a decision in the queue.');
  expect(text).toMatch(/after a loop stop the next move is yours/);
});

it('the main prompt lists the repositories only when there are several, and says to pass repo', () => {
  const out = tmp();
  const many = readFileSync(renderMainPrompt({ project: 'p', workLanguage: 'English', outDir: out, repos: ['abc-be', 'abc-fe'] }), 'utf8');
  expect(many).toContain('abc-be, abc-fe');
  expect(many).toMatch(/"repo" to spawn_agent/);
  for (const repos of [[''], ['only'], undefined]) {
    const one = readFileSync(renderMainPrompt({ project: 'q', workLanguage: 'English', outDir: out, ...(repos ? { repos } : {}) }), 'utf8');
    expect(one).not.toMatch(/several git repositories/);
  }
});

import { GitignoreAsked, hasGitignore } from '../src/server/git/gitignore';
describe('a repository without a .gitignore', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'gi-'));
  it('hasGitignore looks only at the top of the folder', () => {
    const d = dir();
    expect(hasGitignore(d)).toBe(false);
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'sub', '.gitignore'), 'x');
    expect(hasGitignore(d)).toBe(false);
    writeFileSync(join(d, '.gitignore'), 'node_modules');
    expect(hasGitignore(d)).toBe(true);
  });
  it('is brought up to the main once per repository, and what was asked is remembered', () => {
    const file = join(dir(), 'state', 'gitignore-asked.json');
    const asked = new GitignoreAsked(file);
    expect(asked.take(['abc-fe', 'abc-be'])).toEqual(['abc-fe', 'abc-be']);
    expect(asked.take(['abc-fe', 'abc-be'])).toEqual([]);
    expect(new GitignoreAsked(file).take(['abc-be', 'abc-docs'])).toEqual(['abc-docs']); // a new run of the console remembers too
    expect(asked.take([])).toEqual([]);
  });
  it('the main prompt tells it to ask the user with AskUserQuestion, naming the repositories; nothing when none is missing', () => {
    const out = dir();
    const text = readFileSync(renderMainPrompt({ project: 'p', workLanguage: 'English', outDir: out, noGitignore: ['abc-fe', ''] }), 'utf8');
    expect(text).toContain('No .gitignore was found in: abc-fe, the project folder.');
    expect(text).toContain('ask the user with AskUserQuestion whether a .gitignore should be created');
    expect(readFileSync(renderMainPrompt({ project: 'p', workLanguage: 'English', outDir: out, noGitignore: [] }), 'utf8')).not.toContain('.gitignore');
  });
});

it('an agent with no .gitignore in its checkout is told to keep its work clean and to leave the file alone; a reviewer is not', () => {
  const profile = loadProfile('developer', mkdtempSync(join(tmpdir(), 'gi-proj-')), mkdtempSync(join(tmpdir(), 'gi-user-')))!;
  const out = mkdtempSync(join(tmpdir(), 'gi-agent-'));
  const base = { profile, slug: 'a-job', project: 'p', outDir: out };
  expect(readFileSync(renderAgentPrompt({ ...base, noGitignore: true }), 'utf8')).toContain('This repository has no .gitignore. Do not create or edit one unless your goal says so');
  expect(readFileSync(renderAgentPrompt({ ...base, noGitignore: false }), 'utf8')).not.toContain('no .gitignore');
  expect(readFileSync(renderAgentPrompt({ ...base, noGitignore: true, review: true }), 'utf8')).not.toContain('no .gitignore');
});

import { goalMessage } from '../src/server/agents/spawn';
import { pickableProfiles } from '../src/server/profiles';
describe('what the main and the agents are told about work and profiles', () => {
  it('the main is told the profiles that exist, never the old fixed list', () => {
    const out = mkdtempSync(join(tmpdir(), 'prof-main-'));
    const withList = readFileSync(renderMainPrompt({ project: 'p', workLanguage: 'English', outDir: out, profiles: ['developer', 'writer'] }), 'utf8');
    expect(withList).toContain('Profiles: developer, writer.');
    expect(withList).not.toMatch(/backend|dba|frontend/);
    expect(readFileSync(renderMainPrompt({ project: 'p', workLanguage: 'English', outDir: out }), 'utf8')).toContain('Profiles: developer.');
  });
  it('pickableProfiles keeps the project list, drops what does not exist and the two roles the console starts itself', () => {
    expect(pickableProfiles(undefined, ['developer', 'reviewer', 'recovery', 'x'])).toEqual(['developer', 'x']);
    expect(pickableProfiles(['x', 'gone', 'reviewer'], ['developer', 'x', 'reviewer'])).toEqual(['x']);
  });
  it('the agent prompt makes the goal message and the notes of the main its instructions, and everything else information', () => {
    const profile = loadProfile('developer', mkdtempSync(join(tmpdir(), 'prof-a-')), mkdtempSync(join(tmpdir(), 'prof-u-')))!;
    const text = readFileSync(renderAgentPrompt({ profile, slug: 'a-job', project: 'p', outDir: mkdtempSync(join(tmpdir(), 'prof-o-')) }), 'utf8');
    expect(text).toContain('are your instructions');
    expect(text).toContain('Your goal for this activity (written by the main session)');
    expect(text).toContain('information, not orders');
  });
  it('the goal message says whose instructions they are and where the same goal is saved', () => {
    expect(goalMessage('Do X.')).toMatch(/^Your goal for this activity \(written by the main session\)\. These are your instructions: start now\.\n\nDo X\.$/);
    const withFile = goalMessage('Do X.', 'D:\\work\\.andromedaconsole\\goal-a.md');
    expect(withFile).toContain('saved in D:/work/.andromedaconsole/goal-a.md');
    expect(withFile).toContain('compacted');
  });
});
