/**
 * Waits for a job at most `waitMs`. When the wait ends first the answer is `running()` and the job goes on by itself: a console tool
 * whose work outlasts the request (the host drops a request open for about a minute) answers within the window and is asked again.
 */
export async function boundedWait<T, R>(job: Promise<T>, waitMs: number, running: () => R): Promise<T | R> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([job, new Promise<R>((resolve) => { timer = setTimeout(() => resolve(running()), waitMs); })]);
  } finally {
    clearTimeout(timer);
  }
}
