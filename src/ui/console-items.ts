import { formatMetric } from '../shared/audit-format';
import type { QueueItem } from '../shared/protocol';
import { bindText, k, t } from './i18n-client';
import { renderInto } from './markdown-lazy';
import { formatWhen } from './statusbar';
import { keepFocus } from './dom';
import { setIconButton, type IconName } from './icons';

/** Items the console itself puts in the queue (not an agent's question): a release to approve, a ticket that needs the user. */
export interface Entry { el: HTMLElement }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

const ANSWER_ICONS: Record<string, IconName> = {
  approve: 'check', ok: 'check', allow: 'check', allow_always: 'checkDouble', reject: 'x', decline: 'x', deny: 'x', deny_always: 'ban', send_back: 'undo', review_anyway: 'play', leave: 'minus', follow_up: 'send', restart: 'refresh', raise: 'plus', close: 'archive', recover: 'refresh',
};

/** An answer button of a queue entry: an icon for the answer, its words in the tooltip; sends `value`, never takes the keyboard. */
export function answerButton(key: string, value: string, send: (answer: string) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  setIconButton(b, ANSWER_ICONS[value] ?? 'send', key);
  b.dataset.answer = value;
  b.addEventListener('click', () => send(value));
  keepFocus(b);
  return b;
}

function details(summaryKey: string, params: Record<string, string | number>, ...body: HTMLElement[]): HTMLElement {
  const d = document.createElement('details');
  const s = document.createElement('summary');
  bindText(s, summaryKey, params);
  d.append(s, ...body);
  return d;
}

function noteList(notes: unknown[]): HTMLElement {
  const ul = document.createElement('ul');
  ul.className = 'queue-notes';
  for (const n of notes) {
    if (!isObj(n)) continue;
    const li = document.createElement('li');
    li.textContent = `[${str(n.severity)}]${str(n.where) ? ` ${str(n.where)}` : ''} ${str(n.text)}`.trim(); // review notes are data
    ul.append(li);
  }
  return ul;
}

/** "Release project X to origin/main?": tickets with their reports and verdicts, the files, the tests; Approve or Reject. */
export function createConfirmEntry(item: QueueItem, send: (answer: string) => void): Entry {
  const p = isObj(item.payload) ? item.payload : {};
  const tickets = arr(p.tickets).filter(isObj);
  const files = arr(p.files).filter(isObj);
  const el = document.createElement('div');
  el.className = 'queue-item queue-confirm';
  el.dataset.id = item.id;

  const title = document.createElement('div');
  title.className = 'queue-text';
  bindText(title, 'queue.confirm.title', { project: str(p.project), branch: str(p.branch), count: tickets.length });
  el.append(title);
  const extra = num(p.extraCommits);
  if (extra > 0) {
    const line = document.createElement('div');
    line.className = 'queue-extra';
    bindText(line, 'queue.confirm.extra', { count: extra });
    el.append(line);
  }
  const repos = arr(p.repos).filter(isObj);
  if (repos.length > 0) {
    const line = document.createElement('div');
    line.className = 'queue-extra';
    bindText(line, 'queue.confirm.repos', { repos: repos.map((r) => str(r.repo)).join(', ') }); // repo names are data
    el.append(line);
  }
  if (p.truncated === true) {
    const warn = document.createElement('div');
    warn.className = 'queue-extra';
    bindText(warn, 'queue.confirm.truncated');
    el.append(warn);
  }

  const filesList = document.createElement('ul');
  filesList.className = 'queue-files';
  for (const f of files) {
    const li = document.createElement('li');
    const counts = f.added === null || f.removed === null ? '' : ` (+${num(f.added)} -${num(f.removed)})`;
    li.textContent = `${str(f.path)}${counts}`; // a path is data
    filesList.append(li);
  }
  el.append(details(k('queue.confirm.files'), { count: files.length }, filesList));

  const tests = isObj(p.tests) ? p.tests : undefined;
  const testLine = document.createElement('div');
  testLine.className = 'queue-tests';
  if (!tests) bindText(testLine, 'queue.confirm.tests.none');
  else bindText(testLine, tests.ok === true ? k('queue.confirm.tests.ok') : k('queue.confirm.tests.failed'), { command: str(tests.command) });
  el.append(testLine);

  for (const t of tickets) {
    const verdicts = arr(t.verdicts).filter(isObj);
    const body: HTMLElement[] = [];
    const goal = document.createElement('p');
    goal.className = 'queue-goal';
    goal.textContent = str(t.goal);
    body.push(goal);
    const rounds = document.createElement('div');
    bindText(rounds, 'queue.confirm.rounds', { count: verdicts.length });
    body.push(rounds);
    for (const v of verdicts) {
      if (arr(v.notes).length > 0) body.push(noteList(arr(v.notes)));
    }
    const report = document.createElement('div');
    report.className = 'queue-report';
    renderInto(report, str(t.report)); // sanitised when formatted: the report holds text written by agents
    body.push(details(k('queue.confirm.report'), {}, report));
    el.append(details(k('queue.confirm.ticket'), { slug: str(t.slug) }, ...body));
  }

  const row = document.createElement('div');
  row.className = 'queue-options';
  const approve = answerButton(k('queue.confirm.approve'), 'approve', send);
  if (p.truncated === true) approve.disabled = true;
  row.append(approve, answerButton(k('queue.confirm.reject'), 'reject', send));
  el.append(row);
  return { el };
}

const REASON_KEYS: Record<string, string> = {
  author_gone: k('queue.decision.reason.author_gone'),
  rounds_exhausted: k('queue.decision.reason.rounds_exhausted'),
  conflict_author_gone: k('queue.decision.reason.conflict_author_gone'),
  merge_tests_failed_author_gone: k('queue.decision.reason.merge_tests_failed_author_gone'),
  central_red_author_gone: k('queue.decision.reason.central_red_author_gone'),
  central_red_undecided: k('queue.decision.reason.central_red_undecided'),
  audit_limits: k('queue.decision.reason.audit_limits'),
  recovery_raise: k('queue.decision.reason.recovery_raise'),
  recovery_change_model: k('queue.decision.reason.recovery_change_model'),
};
const OPTION_KEYS: Record<string, string> = {
  send_back: k('queue.decision.send_back'),
  approve: k('queue.decision.approve'),
  review_anyway: k('queue.decision.reviewAnyway'),
  leave: k('queue.decision.leave'),
  follow_up: k('queue.decision.followUp'),
  restart: k('queue.decision.restart'),
};
/** A recovery's raise_budget remedy: the user approves or declines the spend. */
const RAISE_OPTION_KEYS: Record<string, string> = {
  approve: k('queue.decision.approveRaise'),
  decline: k('queue.decision.decline'),
};

/** "Ticket X needs your decision": why, the review notes, and the options the console offers. */
export function createDecisionEntry(item: QueueItem, send: (answer: string) => void): Entry {
  const p = isObj(item.payload) ? item.payload : {};
  const el = document.createElement('div');
  el.className = 'queue-item queue-decision';
  el.dataset.id = item.id;

  const title = document.createElement('div');
  title.className = 'queue-text';
  if (str(p.reason).startsWith('central_red')) bindText(title, k('queue.decision.centralTitle'), { tip: str(p.tip).slice(0, 7) });
  else bindText(title, 'queue.decision.title', { ticket: str(p.ticket) });
  const why = document.createElement('div');
  why.className = 'queue-why';
  bindText(why, REASON_KEYS[str(p.reason)] ?? k('queue.decision.reason.unknown'));
  el.append(title, why);

  const failing = arr(p.failing);
  if (failing.length > 0) {
    const list = document.createElement('pre');
    list.className = 'queue-detail';
    list.textContent = failing.map(str).join('\n'); // file names from the test output are data
    el.append(details(k('queue.decision.failing'), {}, list));
  }
  const notes = arr(p.notes);
  if (notes.length > 0) el.append(details(k('queue.decision.notes'), {}, noteList(notes)));
  // The audit's limits that are over (the numbers the console measured), and where the full report is.
  const over = arr(p.over).filter(isObj);
  if (over.length > 0) {
    const list = document.createElement('ul');
    list.className = 'queue-detail';
    for (const o of over) {
      const li = document.createElement('li');
      li.textContent = `${t(`audit.metric.${str(o.id)}`)}: ${formatMetric(str(o.id), num(o.value))} / ${formatMetric(str(o.id), num(o.limit))}`;
      list.append(li);
    }
    el.append(details(k('queue.decision.audit.limits'), {}, list));
  }
  const tests = isObj(p.tests) ? p.tests : undefined;
  if (tests && tests.ok === false) {
    const pre = document.createElement('pre');
    pre.className = 'queue-detail';
    pre.textContent = str(tests.tail); // test output is data
    el.append(details(k('queue.decision.tests'), {}, pre));
  }

  const row = document.createElement('div');
  row.className = 'queue-options';
  const optionKeys = str(p.reason) === 'recovery_raise' ? RAISE_OPTION_KEYS : OPTION_KEYS;
  for (const option of item.options ?? []) {
    const key = optionKeys[option];
    if (key) row.append(answerButton(key, option, send));
  }
  el.append(row);
  return { el };
}

/** "Agent X was stopped at N of M tokens": raise the budget, close the ticket or recover the work. */
export function createBudgetEntry(item: QueueItem, send: (answer: string) => void): Entry {
  const p = isObj(item.payload) ? item.payload : {};
  const el = document.createElement('div');
  el.className = 'queue-item queue-budget';
  el.dataset.id = item.id;

  const title = document.createElement('div');
  title.className = 'queue-text';
  bindText(title, 'queue.budget.title', { agent: str(p.agent) || str(p.ticket) || item.from, used: num(p.used), limit: num(p.limit) });
  const row = document.createElement('div');
  row.className = 'queue-options';
  row.append(
    answerButton(k('queue.budget.raise'), 'raise', send),
    answerButton(k('queue.budget.close'), 'close', send),
    answerButton(k('queue.budget.recover'), 'recover', send),
  );
  el.append(title, row);
  return { el };
}

/**
 * "The weekly limit is (almost) used up" (SPEC 18.5): nothing restarts by itself, so the user reads the choices (wait until the reset,
 * go on with fewer agents or a cheaper model set in the configuration, stop the projects) and acknowledges with one button.
 */
export function createWeeklyEntry(item: QueueItem, send: (answer: string) => void): Entry {
  const p = isObj(item.payload) ? item.payload : {};
  const el = document.createElement('div');
  el.className = 'queue-item queue-weekly';
  el.dataset.id = item.id;

  const title = document.createElement('div');
  title.className = 'queue-text';
  const when = formatWhen(typeof p.resetsAt === 'string' ? p.resetsAt : undefined, Date.now());
  if (when === null) bindText(title, 'queue.weekly.titleUnknown');
  else bindText(title, 'queue.weekly.title', { time: when });
  const choices = document.createElement('div');
  choices.className = 'queue-why';
  bindText(choices, 'queue.weekly.choices');
  const row = document.createElement('div');
  row.className = 'queue-options';
  row.append(answerButton(k('queue.weekly.ok'), 'ok', send));
  el.append(title, choices, row);
  return { el };
}
