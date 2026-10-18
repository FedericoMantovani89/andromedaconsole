/**
 * Calls a long console tool (step_done, merge_ticket) again while it answers "running", as the mod does: on a slow machine the job can
 * outlast the tool's bounded wait. No vitest import, so the e2e scripts can use it too.
 */
export async function untilEnd<T>(call: () => Promise<T>, statusOf: (r: T) => unknown, capMs = 180_000): Promise<T> {
  const start = performance.now();
  for (;;) {
    const r = await call();
    if (statusOf(r) !== 'running') return r;
    if (performance.now() - start > capMs) throw new Error(`still running after ${capMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
