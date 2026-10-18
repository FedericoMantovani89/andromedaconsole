import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from '../fs-atomic';
import { readJsonState, setAside, type StateReport } from '../json-file';

export interface InboxMessage { id: string; text: string }

/**
 * Messages from the console to a session (goals, answers). The mod polls, injects the text as a new turn, and acknowledges it
 * once the engine took the prompt; a message that was not acknowledged is offered again (SPEC 10.5 "conferma di ricezione").
 *
 * With a file the boxes are written through on every change (Phase 6A), so what was not delivered survives a restart; `load()`
 * reads them back. An acknowledged message is gone for good: its id is never delivered again.
 */
export class Inbox {
  private readonly boxes = new Map<string, InboxMessage[]>();
  private readonly pushListeners: ((slug: string) => void)[] = [];
  private readonly ackListeners: ((slug: string, id: string) => void)[] = [];
  private frozen = false;

  constructor(private readonly file?: string, private readonly report?: StateReport) {}

  /** Reads the saved boxes (before anything is pushed). A missing or damaged file means no messages. */
  load(): void {
    if (!this.file) return;
    const s = readJsonState(this.file, this.report);
    if (s.status !== 'ok') return; // missing or damaged (set aside): no messages
    const parsed = s.value;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) { setAside(this.file, this.report); return; } // wrong shape: set aside
    for (const [slug, list] of Object.entries(parsed)) {
      if (!Array.isArray(list)) continue;
      const box = list.filter((m): m is InboxMessage => typeof m === 'object' && m !== null && typeof (m as InboxMessage).id === 'string' && typeof (m as InboxMessage).text === 'string')
        .map((m) => ({ id: m.id, text: m.text }));
      if (box.length > 0) this.boxes.set(slug, box);
    }
  }

  /** Called after every push, with the target slug (a dormant agent wakes when work arrives for it). A throwing callback is ignored. */
  onPush(cb: (slug: string) => void): void { this.pushListeners.push(cb); }

  /** Called after a message was acknowledged (the session received it), with its slug and id. A throwing callback is ignored. */
  onAck(cb: (slug: string, id: string) => void): void { this.ackListeners.push(cb); }

  /** Shutdown: the file keeps what was undelivered. Killing the processes would otherwise empty their boxes (`clear`). */
  freeze(): void { this.frozen = true; }

  push(slug: string, text: string): string {
    const id = randomUUID();
    const box = this.boxes.get(slug) ?? [];
    box.push({ id, text });
    this.boxes.set(slug, box);
    this.save();
    for (const cb of this.pushListeners) {
      try { cb(slug); } catch { /* the push itself succeeded */ }
    }
    return id;
  }

  /** Every slug that has messages waiting. */
  slugs(): string[] { return [...this.boxes.keys()].filter((s) => (this.boxes.get(s)?.length ?? 0) > 0); }

  pending(slug: string): InboxMessage[] {
    return [...(this.boxes.get(slug) ?? [])];
  }

  /** True when the message existed in that session's box. */
  ack(slug: string, id: string): boolean {
    const box = this.boxes.get(slug);
    const i = box?.findIndex((m) => m.id === id) ?? -1;
    if (!box || i < 0) return false;
    box.splice(i, 1);
    this.save();
    for (const cb of this.ackListeners) {
      try { cb(slug, id); } catch { /* the acknowledgement itself succeeded */ }
    }
    return true;
  }

  clear(slug: string): void {
    if (this.boxes.delete(slug)) this.save();
  }

  private save(): void {
    if (!this.file || this.frozen) return;
    const out: Record<string, InboxMessage[]> = {};
    for (const [slug, box] of this.boxes) if (box.length > 0) out[slug] = box;
    try { writeJsonAtomic(this.file, out); } catch { /* a state that cannot be saved is still delivered in this run */ }
  }
}
