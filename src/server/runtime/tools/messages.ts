import { describeKey } from '../../questions/describe';
import { badRequest } from '../../tool-errors';
import type { Context } from '../../http';
import type { ProjectContainer } from '../services';

/** The console tools that carry words: a question to the user and a message to another agent. */
export function messageTools(k: ProjectContainer): Pick<Context['tools'], 'ask_user' | 'send_message'> {
  const permissions = k.get('permissions');
  const questions = k.get('questions');
  const requests = k.get('requests');
  return {
    ask_user: async (slug, body) => {
      const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
      if (typeof b.question !== 'string' || b.question.trim() === '') return badRequest('question is required');
      const options = Array.isArray(b.options) ? b.options.filter((o): o is string => typeof o === 'string').slice(0, 8).map((o) => o.slice(0, 200)) : undefined;
      const permission = b.kind === 'permission';
      const tool = typeof b.tool === 'string' ? b.tool : '';
      // The whole input as the mod saw it ("always" is exact). No key (the input was too long to keep): never remembered.
      const key = typeof b.key === 'string' ? b.key : '';
      // What the user is shown is built here from that key, so it is the call that gets remembered, not a text the client chose.
      const detail = (key !== '' ? describeKey(key) : undefined) ?? (typeof b.detail === 'string' ? b.detail : '');
      // SPEC 32.3: an "always" answer given earlier for this exact call is answered at once, never shown (the guard still runs separately).
      const known = permission ? permissions.recall(slug, tool, key) : undefined;
      if (known) return questions.answerNow({ from: slug }, known);
      let askedId = '';
      const asked = questions.ask({
        from: slug, text: b.question, options: options && options.length > 0 ? options : undefined, multiSelect: b.multiSelect === true,
        kind: permission ? 'permission' : 'question',
        tool: tool || undefined, detail: detail || undefined, canRemember: key.trim() !== '',
      }, permission ? (answer) => {
        permissions.untrack(askedId);
        const verdict = answer === 'allow_always' ? 'allow' : answer === 'deny_always' ? 'deny' : undefined;
        if (!verdict) return;
        permissions.remember(slug, tool, key, verdict);
        // Identical requests of the same agent already waiting (parallel tool calls) get the same answer.
        for (const sibling of permissions.siblings(slug, tool, key, askedId)) { permissions.untrack(sibling); questions.answer(sibling, verdict); }
      } : undefined);
      askedId = asked.id;
      if (permission) permissions.track(asked.id, slug, tool, key);
      return asked;
    },
    send_message: async (slug, body) => requests.send(slug, body),
  };
}
