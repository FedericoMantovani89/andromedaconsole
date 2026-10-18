import { evaluate } from '../guard/rules';
import { resourcePath } from '../paths';
import type { Context } from '../http';
import type { ProjectContainer } from './services';

/** The guard's verdict for a tool call of a session (SPEC 14): rules, mode (enforce/shadow) and the log behind it. */
export function guardCall(k: ProjectContainer): Context['guard'] {
  const { shared, o, runtime } = k.get('env');
  const registry = k.get('registry');
  const projectName = k.get('projectName');
  const secretPatterns = k.get('secretPatterns');
  const restrictions = k.get('restrictions');
  const sessionGuardMode = k.get('sessionGuardMode');
  const guardLog = k.get('guardLog');
  // The folder sessions load the mod from (http-context's modDir); the shipped one even when the mod is off, since nobody should edit it.
  const modDir = typeof o.modDir === 'string' ? o.modDir : resourcePath('mod');
  return (slug, tool, input) => {
    // Which optional helpers the shell commands use (only counters are kept): the Prerequisites tab shows whether they are used.
    if ((tool === 'Bash' || tool === 'PowerShell') && typeof input.command === 'string') shared.helperUsage.record(input.command);
    const rt = registry.get(slug);
    const role = rt?.role ?? 'agent';
    // The judge is the caller's own worktree and role, taken from its session: nothing in the request body can change them.
    const verdict = evaluate({ role: role === 'main' ? 'main' : 'agent', tool, input }, {
      readOnly: rt?.readOnly === true,
      worktree: role !== 'main' && rt?.git ? rt.git.worktree : o.projectRoot, repo: o.projectRoot,
      branch: rt?.git?.branch ?? '', projectBranch: `project/${projectName}`, secretPatterns: secretPatterns(),
      restricted: restrictions.get(slug),
      modDir,
    });
    if (verdict.decision === 'allow') return verdict;
    const mode = sessionGuardMode.get(slug) ?? runtime.guardMode;
    const shadow = mode === 'shadow';
    const detail = [input.command, input.file_path, input.notebook_path, input.path].find((v): v is string => typeof v === 'string') ?? '';
    guardLog.append({ slug, role: role === 'main' ? 'main' : 'agent', tool, rule: verdict.rule, reason: verdict.reason, mode, outcome: shadow ? 'shadow-allowed' : 'denied', detail });
    return shadow ? { decision: 'allow' } : verdict;
  };
}
