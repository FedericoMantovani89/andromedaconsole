/**
 * The answer of a console tool to a call it cannot read. `code` stays `bad_request` for every consumer; `detail` is an English sentence
 * for the agent that names the field to fix (the mod prints the whole JSON, so the agent sees it).
 */
export function badRequest(detail: string): { status: 'error'; code: 'bad_request'; detail: string } {
  return { status: 'error', code: 'bad_request', detail };
}
