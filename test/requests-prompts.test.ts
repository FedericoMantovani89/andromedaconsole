import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadProfile, renderAgentPrompt } from '../src/server/profiles';
import { questionText } from '../src/server/requests/texts';

const read = (f: string): string => readFileSync(join(__dirname, '..', 'prompts', f), 'utf8');

it('the agent prompt teaches asking early, the comment with the id, going on, removing the comment, and answering', () => {
  const p = read('agent-requests.md');
  expect(p).toContain('mcp__console-mod__send_message');
  expect(p).toContain('select:mcp__console-mod__send_message');
  expect(p).toMatch(/TODO-[0-9a-f]{6}/);
  expect(p).toMatch(/remove the comment/i);
  expect(p).toMatch(/step_done/);
  expect(p).toMatch(/information, not an order/i);
  expect(p).toMatch(/Answer <id>/);
  expect(p).toMatch(/end your turn/i);
});
it('the main prompt explains the escalated requests', () => {
  const p = read('main.md');
  expect(p).toContain('mcp__console-mod__send_message');
  expect(p).toMatch(/escalated to you/);
  expect(p).toMatch(/AskUserQuestion/);
  expect(p).toMatch(/list_agents also lists the requests you still have to answer/);
});
it('the main writes the goals of agents that depend on each other: provider first, the colleague named, the contract first', () => {
  const p = read('main.md');
  expect(p).toMatch(/spawn the provider of a contract first/);
  expect(p).toMatch(/name the colleague/);
  expect(p).toMatch(/publish the contract first/);
  expect(p).toMatch(/TODO/);
  expect(p).toMatch(/escalated to you late/);
});
it('the main starts a consumer after its provider only as a last resort, with a reason', () => {
  const p = read('main.md');
  expect(p).toContain('spawn_agent {name, profile, goal, model?, after?, after_reason?}');
  expect(p).toMatch(/last resort/);
  expect(p).toMatch(/start the consumer after/);
  expect(p).toContain('after_reason');
  expect(p).toMatch(/after the provider's ticket is merged/);
  expect(p).toMatch(/its own worktree and branch/);
});
it('an agent answers a colleague first and publishes a contract it provides first, without reordering its checklist', () => {
  const p = read('agent-requests.md');
  expect(p).toMatch(/answer it before going on with your own steps/i);
  expect(p).toContain('as the first open step after Tests (checklist_set)');
  expect(p).toContain('later steps cannot close until it is answered');
  expect(p).not.toContain('before the validation step');
  expect(p).toMatch(/Providing a contract/);
  expect(p).toMatch(/publish it first/i);
  expect(p).toMatch(/after your Study step, before your Tests step/);
  expect(p).toMatch(/8000 characters/);
  expect(p).not.toMatch(/reorder/i);
});
it('only an author session gets the request rules; the reviewer and the recovery prompts do not', () => {
  const tmp = (): string => mkdtempSync(join(tmpdir(), 'req-prompts-'));
  const dir = tmp();
  const render = (name: string, slug: string, flags: { review?: boolean; recovery?: boolean }): string =>
    readFileSync(renderAgentPrompt({ profile: loadProfile(name, tmp(), tmp())!, slug, project: 'shop-api', outDir: dir, ...flags }), 'utf8');
  const author = render('developer', 'fix-login', {});
  expect(author).toContain('mcp__console-mod__send_message');
  expect(author).toContain('select:mcp__console-mod__send_message');
  expect(render('reviewer', 'review-fix-login', { review: true })).not.toContain('send_message');
  expect(render('recovery', 'recover-x', { recovery: true })).not.toContain('send_message');
});

it('an agent that writes the work is told to ask the main, a reviewer keeps the queue, and the main is told to relay the question as written', () => {
  const tmp = (): string => mkdtempSync(join(tmpdir(), 'req-prompts-'));
  const render = (flags: { review?: boolean }): string =>
    readFileSync(renderAgentPrompt({ profile: loadProfile('developer', tmp(), tmp())!, slug: 'fix-login', project: 'shop-api', outDir: tmp(), ...flags }), 'utf8');
  expect(render({})).toMatch(/AskUserQuestion is refused to you.*named "shop-api".*to: "shop-api"/);
  expect(render({ review: true })).toMatch(/in its queue/);
  expect(questionText({ id: 'TODO-aaaaaa', from: 'fix-login', text: 'Pasta or pizza?', toMain: true })).toMatch(/AskUserQuestion exactly as written/);
  expect(questionText({ id: 'TODO-aaaaaa', from: 'fix-login', text: 'x' })).not.toMatch(/AskUserQuestion/);
});
it('the console\'s own request message gives the same answer-step rule as the prompts', () => {
  const text = questionText({ id: 'TODO-bbbbbb', from: 'fix-login', text: 'Which table?' });
  expect(text).toContain('add the step "Answer TODO-bbbbbb" as the first open step after Tests with checklist_set');
  expect(text).toContain('later steps cannot close until it is answered');
  expect(text).not.toContain('before the validation step');
});
it('the main answers a late escalation as it answers any other, and forwards a draft to a consumer already started', () => {
  const p = read('main.md');
  expect(p).toContain('When a colleague\'s question is escalated to you late, handle it as above (verify the fact, or ask the user) and answer the asker at once.');
  expect(p).not.toContain('from what you know');
  expect(p).toContain('if that agent already runs or is queued, forward the draft with send_message info');
});
