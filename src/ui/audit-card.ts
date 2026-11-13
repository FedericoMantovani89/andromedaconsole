import type { ApiError, SessionInfo } from '../shared/protocol';
import { api } from './api';
import { el, showDialog } from './dom';
import { bindText, k, t } from './i18n-client';
import { closeOverlay } from './settings';
import { closeDot } from './close-dot';
import { errorText } from './new-agent';
import { setIconButton } from './icons';

/** The parts of an audit report (`audit-<sha>.json`) the card shows. */
interface Metric { id: string; value: number | 'n/a'; limit: number; over: boolean; where?: string }
interface Layer { id: string; ran: boolean; ok?: boolean; reason?: string }
interface Note { source: string; severity: string; where: string; problem: string; fix: string }
interface Audit { verdict: string; level: string; profile: string; metrics: Metric[]; layerTwo: Layer[]; notes: Note[]; notRun: string[]; modelRan: boolean }

const FOLLOW_MS = 5000;

type TicketAudit = NonNullable<NonNullable<SessionInfo['ticket']>['audit']>;

/**
 * The verdict chip of a delivered ticket (SPEC 15.7): `ready`, `needs changes` or `split first`, hidden until an audit exists. A click opens
 * the report. The chip is built once per element: only its words change.
 */
export function applyAudit(chip: HTMLElement, slug: string, audit: TicketAudit | undefined): void {
  if (!chip.dataset.auditWired) {
    chip.dataset.auditWired = '1';
    chip.setAttribute('role', 'button');
    chip.addEventListener('mousedown', (ev) => ev.preventDefault()); // opening a dialog never takes the keyboard from the terminal
    chip.addEventListener('click', (ev) => { ev.stopPropagation(); openAuditDialog(slug); });
  }
  if (!audit) {
    chip.hidden = true;
    chip.className = 'panel-audit';
    delete chip.dataset.i18n;
    chip.textContent = '';
    return;
  }
  chip.hidden = false;
  chip.className = `panel-audit ${audit.verdict}`;
  bindText(chip, `audit.verdict.${audit.verdict}`);
  chip.title = t(audit.modelRan ? k('audit.chip.full') : k('audit.chip.measures'), { level: t(`audit.level.${audit.level}`) });
}

const line = (text: string, className?: string): HTMLElement => {
  const d = el('div', className);
  d.textContent = text;
  return d;
};

function metricLine(m: Metric): HTMLElement {
  const value = m.value === 'n/a' ? t('common.notAvailable') : String(m.value);
  const limit = m.limit === 0 ? t('audit.limit.off') : String(m.limit);
  const where = m.where ? ` (${m.where})` : '';
  return line(`${t(`audit.metric.${m.id}`)}: ${value} / ${limit}${m.over ? ` — ${t('audit.over')}` : ''}${where}`, m.over ? 'audit-over' : undefined);
}

function layerLine(l: Layer): HTMLElement {
  const name = t(`audit.layer.${l.id}`);
  if (!l.ran) return line(`${name}: ${t('audit.notRun')}${l.reason ? ` (${t(`audit.reason.${l.reason}`)})` : ''}`);
  return line(`${name}: ${t(l.ok ? 'audit.layer.ok' : 'audit.layer.failed')}`);
}

/** The audit of one ticket: the measures, the project's commands, the notes as `path:line — problem -> fix`, and the button for the model part. */
export function openAuditDialog(slug: string): void {
  const title = el('h3');
  bindText(title, 'audit.dialog.title', { slug });
  const body = el('div', 'audit-body');
  const empty = el('div');
  bindText(empty, 'common.notAvailable'); // until the answer arrives, and when there is no audit: "n/a", never an empty box
  body.append(empty);
  const message = el('div', 'form-error');
  const run = el('button');
  run.type = 'button';
  run.name = 'runAudit';
  setIconButton(run, 'play', k('audit.run'));
  const actions = el('div', 'form-actions');
  actions.append(run);
  const dialog = showDialog([closeDot(closeOverlay), title, body, message, actions], 'audit-dialog');

  const show = (): Promise<Audit | null> =>
    api<{ audit: Audit | null }>(`/api/tickets/${encodeURIComponent(slug)}/audit`).then((r) => {
      const a = r.status === 200 ? r.body?.audit ?? null : null;
      if (!a) return null;
      const parts: HTMLElement[] = [];
      const head = el('div', `audit-verdict ${a.verdict}`);
      bindText(head, `audit.verdict.${a.verdict}`);
      parts.push(head);
      const h = (key: string): HTMLElement => { const x = el('h4'); bindText(x, key); return x; };
      parts.push(h('audit.metrics'), ...a.metrics.map(metricLine));
      parts.push(h('audit.layers'), ...(a.layerTwo.length > 0 ? a.layerTwo.map(layerLine) : [line(t('audit.notRun'))]));
      parts.push(h('audit.notes'));
      if (!a.modelRan) parts.push(line(t('audit.model.notRun')));
      if (a.notes.length === 0) parts.push(line(t('audit.notes.none')));
      for (const n of a.notes) parts.push(line(`[${n.severity}] ${n.where} — ${n.problem} -> ${n.fix}`, 'audit-note')); // the model's words: data, never markup
      body.replaceChildren(...parts);
      return a;
    }).catch(() => null);
  void show();

  // After the model part was started the report arrives minutes later: look again every few seconds until it is there or the dialog is closed.
  let watch: ReturnType<typeof setInterval> | undefined;
  const follow = (): void => {
    if (watch !== undefined) clearInterval(watch);
    watch = setInterval(() => {
      if (!dialog.isConnected) { clearInterval(watch); return; }
      void show().then((a) => { if (a?.modelRan) clearInterval(watch); });
    }, FOLLOW_MS);
  };

  run.addEventListener('click', () => {
    run.disabled = true;
    message.textContent = '';
    void api<ApiError>(`/api/tickets/${encodeURIComponent(slug)}/audit`, { method: 'POST' }).then((r) => {
      run.disabled = false;
      if (r.status === 200) { bindText(message, 'audit.run.started'); message.className = 'settings-note'; follow(); } else { delete message.dataset.i18n; message.className = 'form-error'; message.textContent = errorText(r.body as ApiError); }
    }).catch(() => { run.disabled = false; });
  });
}
