import type { ProjectContainer } from './services';

/**
 * Connects the services to each other: the listeners, in the order they were registered when the project was built. Runs once, right after
 * the `ctx` exists. `registry` has four listeners and their order is the order they run in.
 */
export function wire(c: ProjectContainer): void {
  const { shared } = c.get('env');
  const projectName = c.get('projectName');
  const ptys = c.get('ptys');
  const tokens = c.get('tokens');
  const inbox = c.get('inbox');
  const registry = c.get('registry');
  const questions = c.get('questions');
  const permissions = c.get('permissions');
  const reading = c.get('reading');
  const tickets = c.get('tickets');
  const review = c.get('review');
  const restrictions = c.get('restrictions');
  const recovery = c.get('recovery');
  const loop = c.get('loop');
  const resumedAwaitingStart = c.get('resumedAwaitingStart');
  const ticketStatusOf = c.get('ticketStatusOf');
  const waker = c.get('waker');
  const persister = c.get('persister');
  const requests = c.get('requests');
  const broadcast = c.get('broadcast');
  const notify = c.get('notify');
  const ctx = c.get('ctx');

  inbox.onPush((slug) => waker.onWork(slug));
  inbox.onAck((slug, id) => requests.onDelivered(slug, id));

  // The HTTP and WebSocket servers are console-wide (see `startServer`); a reading entry goes to the sockets of this project only.
  reading.on((slug, entry) => shared.pushToProject(projectName, { type: 'reading', slug, entry }));

  registry.on(() => broadcast());
  // A slot freed in this project may start another project's queue (the global limit); the projects are released in the order they were opened.
  registry.on(() => { for (const r of shared.runtimes) if (r.ctx !== ctx) r.parts.scheduler.release(); });
  registry.on((slug) => notify.onRegistryChange(registry.get(slug)));
  questions.onAdd((q) => notify.onItem(q));
  void notify.checkAvailability();
  registry.on((slug) => persister.onChange(slug));
  // A session waits for the user exactly while it has an open question.
  questions.onChange(() => {
    for (const a of registry.list()) {
      // The wait is over: the minutes spent waiting for the user are not a silence.
      if (a.role !== 'main' && a.state === 'waiting_user' && !questions.hasPending(a.slug)) loop.detector.onModEvent(a.slug);
      registry.setWaitingUser(a.slug, questions.hasPending(a.slug));
    }
    broadcast();
  });
  // What the console holds for a session goes with it, whether it ended or was discarded (a failed start, an archived agent deleted).
  const forgetHeld = (id: string): void => {
    questions.dropFrom(id);
    inbox.clear(id);
    restrictions.clear(id);
    loop.forget(id);
    permissions.forget(id);
  };
  ptys.onDiscard((id) => forgetHeld(id));
  ptys.onExit((id) => {
    // A reviewer that ends without a verdict (it crashed, or was closed) must not leave its ticket in review for ever.
    if (registry.get(id)?.role === 'reviewer' && !registry.get(id)?.finishing && review.abandonReview(id)) broadcast();
    // Nor a recovery that ends without its report, also one the console ended: the ticket waits again in the status it was stopped
    // in (after an accepted report this is a no-op: the report already forgot the session).
    if (registry.get(id)?.role === 'recovery' && recovery.abandon(id)) broadcast();
    // An auditor that ends without its report: only the main is told (a report already removed it, so this is then a no-op).
    if (registry.get(id)?.role === 'auditor' && !registry.get(id)?.finishing && review.abandonAudit(id)) broadcast();
    // A resumed agent whose process ended before its session reported in never ran: its ticket waits again, and the main is told.
    if (resumedAwaitingStart.delete(id) && registry.get(id)?.role === 'agent' && ticketStatusOf(id) === 'in_progress') {
      try { tickets.move(id, 'suspended_limit'); } catch { /* told below anyway */ }
      inbox.push(projectName, `The resumed agent "${id}" ended before its session started; its ticket is suspended for the limit again. Try resume_agent once more, or tell the user.`);
    }
    registry.onProcessExit(id);
    tokens.revoke(id);
    forgetHeld(id);
    broadcast();
  });
}
