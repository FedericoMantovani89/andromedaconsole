import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Context } from '../http';
import { buildClaudeLaunch, SESSION_ID_RE } from '../claude-code/launch';
import { writeSessionSettings } from '../claude-code/project-settings';
import { hasGitignore } from '../git/gitignore';
import { ignoreConsoleFolder } from '../git/console-folder';
import { helperToolsText } from '../helper-tools';
import { loadProfile, renderAgentPrompt, type Profile } from '../profiles';
import { validateSlug } from '../../shared/slug';
import { git } from '../git/git';
import { agentBranchFor, checkSpawnable, createAgentWorktree, createReviewWorktree, discardAgentWorktree, GitError, removeWorktree, worktreesDirFor } from '../git/worktree';
import { pushHookEnv } from '../git/hooks';
import { repoPathOf, resolveRepo } from '../git/repos';
import type { SpawnRequest } from './scheduler';
import { errorMessage } from '../../shared/guards';

export type SpawnOutcome =
  | { ok: true; status: 'started'; slug: string }
  | { ok: true; status: 'queued'; position: number; slug: string }
  | { ok: false; httpStatus: number; code: string; params?: Record<string, string | number> };

/** A model alias or id (opus, claude-opus-5-5[1m]): plain characters only, because it becomes a command-line argument. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;

/** The console's own tools an agent may call without a permission prompt. */
export const AGENT_TOOLS = ['list_agents', 'send_message', 'checklist_set', 'step_done', 'report_blocked'].map((t) => `mcp__console-mod__${t}`);
/** What the main may call without a permission prompt: every tool the mod registers for the main, plus `ask_user` (native question of the main). */
export const MAIN_TOOLS = ['spawn_agent', 'list_agents', 'ask_user', 'send_message', 'start_recovery', 'resume_agent', 'archive_agent', 'worktree_cleanup', 'ticket_report', 'request_review', 'send_back_ticket', 'merge_ticket', 'propose_release'].map((t) => `mcp__console-mod__${t}`);
export const REVIEWER_TOOLS = ['list_agents', 'review_verdict'].map((t) => `mcp__console-mod__${t}`);
export const RECOVERY_TOOLS = ['list_agents', 'recovery_report'].map((t) => `mcp__console-mod__${t}`);

/** The session's role: a reviewer and a recovery read a detached checkout; every other launched session is an agent. */
const roleOf = (r: SpawnRequest): 'agent' | 'reviewer' | 'recovery' => (r.review ? 'reviewer' : r.recovery ? 'recovery' : 'agent');
/** A detached, read-only checkout of one commit (a reviewer or a recovery): no branch of its own. */
const detachedOf = (r: SpawnRequest): { sha: string; prefix: string } | undefined =>
  r.review ? { sha: r.review.sha, prefix: 'review' } : r.recovery ? { sha: r.recovery.sha, prefix: 'recovery' } : undefined;

const refuse = (httpStatus: number, code: string, params?: Record<string, string | number>): SpawnOutcome =>
  ({ ok: false, httpStatus, code, params });

/** What the new agent is told first. Delivered through the inbox, so the mod injects it as the first turn. */
export const goalMessage = (goal: string, file?: string): string =>
  `Your goal for this activity (written by the main session). These are your instructions: start now.\n\n${goal}${file ? `\n\nThe same goal is saved in ${file.replace(/\\/g, '/')}: read it again if your context is compacted.` : ''}`;

/** The goal as a file next to the agent's other console files (`.andromedaconsole/`): it can be read again after a compaction. Undefined when it cannot be written. */
function writeGoalFile(cwd: string, slug: string, goal: string): string | undefined {
  try {
    const dir = ignoreConsoleFolder(cwd);
    const file = join(dir, `goal-${slug}.md`);
    writeFileSync(file, `---\nagent: ${slug}\n---\n${goal}\n`, 'utf8');
    return file;
  } catch {
    return undefined; // the goal still goes by message
  }
}

/**
 * The single way an agent comes to exist: the UI button and the main's spawn_agent tool both end here.
 * Validates, reserves the name, and lets the scheduler decide between starting now and waiting for a slot.
 */
export async function spawnAgent(ctx: Context, r: SpawnRequest): Promise<SpawnOutcome> {
  const blocked = (await ctx.ensurePrereq()).find((c) => c.required && c.status !== 'ok');
  if (blocked) return refuse(422, 'prereq.blocked', { tool: blocked.id });

  const v = validateSlug(r.slug, [ctx.projectName, ...ctx.store.listAgents().map((a) => a.slug)]);
  if (!v.ok) return refuse(422, v.code, v.params);
  const profile = typeof r.profile === 'string' ? loadProfile(r.profile, ctx.projectRoot) : undefined;
  if (!profile) return refuse(422, 'profile.invalid');
  // A project may offer only some profiles (its template); the console's own reviewer, recovery and replacement spawns are exempt.
  const offered = ctx.store.fields().profiles;
  if (offered && !r.review && !r.recovery && !r.resumeBranch && !offered.includes(r.profile)) return refuse(422, 'profile.invalid');

  const request: SpawnRequest = { ...r, slug: v.slug, model: r.model === '' ? undefined : r.model };
  if (request.model !== undefined && !MODEL_RE.test(request.model)) return refuse(422, 'model.invalid');
  // A reviewer exists only for a delivered ticket: request_review starts it, with the checkout of that commit.
  if (r.profile === 'reviewer' && !r.review) return refuse(422, 'review.useRequestReview');
  // A recovery exists only for a stopped ticket: start_recovery (or the user's answer to a stop) starts it, on the WIP commit.
  if (r.profile === 'recovery' && !r.recovery) return refuse(422, 'recovery.useRecoveryTool');
  if (ctx.git.worktrees) {
    // Which repository: the project folder when it is one, else the sub-folder named in the request. Found now, before the name is
    // reserved, so the user sees the real reason (SPEC 9.2); the worktree itself is made at start.
    const repo = resolveRepo(ctx.projectRoot, r.repo);
    if (!repo.ok) {
      return refuse(422, repo.code, repo.code === 'git.repoRequired' ? { repos: repo.repos.join(', ') }
        : repo.code === 'git.unknownRepo' ? { repo: r.repo ?? '', repos: repo.repos.join(', ') } : undefined);
    }
    request.repo = repo.rel;
    if (r.after !== undefined) {
      const bad = await checkAfter(ctx, v.slug, r.after, repo.path);
      if (bad) return bad;
    }
    await ctx.prepareRepo(repo.path);
    const problem = await checkSpawnable({ repo: repo.path, project: ctx.projectName, slug: v.slug, dir: worktreesDirFor(ctx.projectRoot, repo.path), review: Boolean(detachedOf(r)) });
    if (problem) return refuse(422, problem);
  } else if (r.after !== undefined) {
    const bad = await checkAfter(ctx, v.slug, r.after, undefined); // agents share the project folder: there is no branch to start from
    if (bad) return bad;
  }
  try {
    ctx.store.addAgent({ slug: v.slug, profile: r.profile, ...(request.model ? { model: request.model } : {}) }); // reserves the name, also while it waits in the queue
  } catch (e) {
    return refuse(500, 'agent.spawnFailed', { reason: errorMessage(e) });
  }
  ctx.registry.register({ slug: v.slug, role: roleOf(r), profile: r.profile, goal: r.goal, queued: true, readOnly: profile.readOnly });
  // The review and the report check the work against it. A replacement keeps the objective of the ticket it takes over (its goal
  // here is the handover), and a reviewer or a recovery has no ticket of its own.
  try {
    if (r.goal && roleOf(r) === 'agent' && !r.resumeBranch) ctx.tickets.setGoal(v.slug, r.goal);
    // The review, the merge and the release find the repository again from the ticket.
    if (ctx.git.worktrees && request.repo !== undefined && roleOf(r) === 'agent' && !r.resumeBranch) ctx.tickets.setRepo(v.slug, request.repo);
    // The review and the merge wait for the other ticket (SPEC 15.4); a restart finds the dependency again on the ticket.
    if (r.after !== undefined && roleOf(r) === 'agent' && !r.resumeBranch) ctx.tickets.setAfter(v.slug, r.after, r.afterReason ?? '');
    const result = ctx.scheduler.request(request);
    ctx.broadcastState();
    if (result.status === 'started' && result.ready) await result.ready;
    return result.status === 'started'
      ? { ok: true, status: 'started', slug: v.slug }
      : { ok: true, status: 'queued', position: result.position, slug: v.slug };
  } catch (e) {
    await undoSpawn(ctx, v.slug);
    ctx.broadcastState();
    if (e instanceof GitError && e.code !== 'git.failed') return refuse(422, e.code);
    return refuse(500, 'agent.spawnFailed', { reason: errorMessage(e) });
  }
}

const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase();

/**
 * `spawn_agent after`: the other agent must be a started agent (role `agent`, not a reviewer or a recovery) of the same repository,
 * with its branch in git. Checked before the name is reserved, so a refusal leaves nothing behind. `repo` is undefined with worktrees off.
 */
async function checkAfter(ctx: Context, slug: string, after: string, repo: string | undefined): Promise<SpawnOutcome | undefined> {
  if (after === slug) return refuse(422, 'after_self', { after });
  const other = ctx.registry.get(after);
  if (!other) return refuse(422, 'after_unknown', { after });
  if (other.role !== 'agent') return refuse(422, 'after_not_agent', { after });
  const g = other.git;
  if (!g || repo === undefined) return refuse(422, 'after_no_branch', { after });
  if (!samePath(g.repo ?? ctx.projectRoot, repo)) return refuse(422, 'after_other_repo', { after });
  if ((await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${g.branch}`])).code !== 0) return refuse(422, 'after_no_branch', { after });
  return undefined;
}

/**
 * Where a new agent's branch starts: the other agent's branch for `after`, else the project branch (undefined). An `after` agent whose
 * ticket was merged meanwhile (the request waited in the queue) has its work on the project branch, and its branch may be gone.
 */
function startPointOf(ctx: Context, r: SpawnRequest): string | undefined {
  if (r.after === undefined || r.resumeBranch !== undefined || detachedOf(r)) return undefined;
  // The ticket's name, when the other agent was replaced while this request waited (the rename follows it); the branch stays its own.
  const after = ctx.tickets.get(r.slug)?.after ?? r.after;
  const status = ctx.tickets.get(after)?.status;
  if (status === 'merged' || status === 'released') return undefined;
  return ctx.registry.get(after)?.git?.branch ?? agentBranchFor(ctx.projectName, r.after);
}

/**
 * Starts the process of an agent (called by the scheduler, now or when a slot frees). May throw. With worktrees on, the start is
 * asynchronous: the slot is taken at once, the worktree and its hook are made, and only then does the process start.
 */
export function launchAgent(ctx: Context, r: SpawnRequest): void | Promise<void> {
  const profile = loadProfile(r.profile, ctx.projectRoot);
  if (!profile) throw new Error(`profile ${r.profile} disappeared`);
  const { bypass } = ctx.noteLaunch(r.slug); // the settings of this moment, even if the worktree takes a while
  if (r.resume) {
    // A resumed session goes back to the worktree it was suspended in; nothing new is created. With worktrees off, agents share
    // the project folder: that is where it goes back to.
    const git = ctx.registry.get(r.slug)?.git;
    if (!git && !ctx.git.worktrees) return startProcess(ctx, r, profile, ctx.projectRoot, undefined, bypass);
    if (!git || !existsSync(git.worktree)) throw new Error('no_worktree');
    return startProcess(ctx, r, profile, git.worktree, git, bypass);
  }
  if (!ctx.git.worktrees) return startProcess(ctx, r, profile, ctx.projectRoot, undefined, bypass);
  ctx.registry.onSpawned(r.slug);
  return startInWorktree(ctx, r, profile, bypass);
}

async function startInWorktree(ctx: Context, r: SpawnRequest, profile: Profile, bypass: boolean): Promise<void> {
  let made: { path: string; branch: string; base?: string } | undefined;
  const repo = repoPathOf(ctx.projectRoot, r.repo);
  const dir = worktreesDirFor(ctx.projectRoot, repo);
  try {
    // A reviewer reads a detached checkout of the delivered commit, a recovery one of the WIP commit; their nominal branch exists
    // nowhere, so the push hook refuses everything. A replacement agent checks out the stopped agent's branch.
    const detached = detachedOf(r);
    const startPoint = startPointOf(ctx, r);
    made = detached
      ? { path: (await createReviewWorktree({ repo, slug: r.slug, sha: detached.sha, dir })).path, branch: `${detached.prefix}/${r.slug}` }
      : await createAgentWorktree({ repo, project: ctx.projectName, slug: r.slug, dir, ...(r.resumeBranch ? { branch: r.resumeBranch } : {}), ...(startPoint ? { startPoint } : {}) });
    // Where this agent's own work begins: its report, review and squash merge take only what came after it (SPEC 15.4).
    if (made.base !== undefined) ctx.tickets.setBaseSha(r.slug, made.base);
    await ctx.afterWorktreeCreated?.(r.slug);
    ctx.registry.setGit(r.slug, { worktree: made.path, branch: made.branch, repo });
    startProcess(ctx, r, profile, made.path, { worktree: made.path, branch: made.branch }, bypass);
  } catch (e) {
    ctx.registry.setGit(r.slug, undefined);
    ctx.tokens.revoke(r.slug);
    // Never delete a branch the console did not just create: a replacement's branch holds the stopped agent's work.
    if (made && (detachedOf(r) || r.resumeBranch)) await removeWorktree(repo, made.path);
    else if (made) await discardAgentWorktree({ repo, slug: r.slug, branch: made.branch, path: made.path });
    throw e;
  }
}

function startProcess(ctx: Context, r: SpawnRequest, profile: Profile, cwd: string, git: { worktree: string; branch: string } | undefined, bypass: boolean): void {
  const projectFields = ctx.store.fields();
  // A worktree session (every launch, a resumed one too) gets its push hook and its console folder's own .gitignore before it starts.
  const hookEnv = git ? pushHookEnv({ projectRoot: ctx.projectRoot, branch: git.branch, slug: r.slug }) : {};
  if (git) ignoreConsoleFolder(git.worktree);
  const launch = buildClaudeLaunch({
    command: ctx.claudeCommand, role: roleOf(r), slug: r.slug, project: ctx.projectName,
    url: `http://127.0.0.1:${ctx.getPort()}`, token: ctx.tokens.issue(r.slug), bypass, baseEnv: { ...process.env, ...hookEnv },
    pluginDir: ctx.modDir, displayName: `${r.slug} ${ctx.projectName} AndromedaConsole`,
    ...(ctx.modDir ? { settingsFile: writeSessionSettings(ctx.projectRoot) } : {}),
    allowedTools: ctx.modDir ? (r.review ? REVIEWER_TOOLS : r.recovery ? RECOVERY_TOOLS : AGENT_TOOLS) : undefined,
    appendPromptFile: renderAgentPrompt({ profile, slug: r.slug, project: ctx.projectName, outDir: ctx.promptsDir, git, review: Boolean(r.review), recovery: Boolean(r.recovery), projectRoot: ctx.projectRoot, docs: projectFields.docs, helpers: helperToolsText(ctx.getPrereq()), noGitignore: !hasGitignore(cwd) }),
    // request > profile > project (Phase 6D) > the global choice in Options (Phase 6E) > Claude Code's own default (no --model)
    model: r.model ?? profile.model ?? projectFields.model ?? ctx.models.agentModel(),
    ...(r.resume ? { resumeId: r.resume.sessionId } : {}),
  });
  if (r.resume) ctx.budget.primeTranscript(r.slug); // the resumed session appends to its old transcript: that part is already counted
  ctx.ptys.spawn({ id: r.slug, ...launch, cwd, cols: 120, rows: 30 });
  ctx.launchLog.set(r.slug, launch.args);
  ctx.registry.onSpawned(r.slug);
  // A token budget needs a worktree (its WIP commits go there); a reviewer and a recovery get none. A restarted server keeps the stored one.
  // The process already runs: a ticket file that cannot be written leaves the agent without a budget (n/a), it does not undo the start.
  if (git && roleOf(r) === 'agent') {
    try {
      ctx.budget.begin(r.slug, r.budget ?? profile.budgetTokens ?? projectFields.agentTokens ?? ctx.budgetConfig.agentTokens);
    } catch (e) {
      ctx.inbox.push(ctx.projectName, `The token budget of "${r.slug}" could not be recorded (${errorMessage(e)}); it runs without one.`);
    }
  }
  // A resumed session keeps its context: no goal again, only the word to go on (an interactive session waits for a turn).
  if (r.resume) ctx.inbox.push(r.slug, r.resume.reason && r.resume.reason !== 'limit' ? WOKEN_MESSAGE : RESUMED_MESSAGE);
  else if (r.goal) ctx.inbox.push(r.slug, goalMessage(r.goal, writeGoalFile(cwd, r.slug, r.goal)));
  ctx.launchWatch.watch(r.slug);
}

/** What a resumed agent is told first: it has its context, so only that it may go on. */
export const RESUMED_MESSAGE = 'The usage limit was reset and your session was resumed by the console. Continue your ticket from where you stopped: check the state of your checklist and go on with the next open step.';

/** What a woken agent is told first: the console was restarted, so it only has to go on. */
export const WOKEN_MESSAGE = 'The console was restarted and your session was resumed; continue your ticket from where you stopped.';

/**
 * Resumes a suspended agent with `claude --resume <sessionId>` in its EXISTING worktree (SPEC 18.4): same slug, a new session
 * token, no new worktree and no goal message. The active-agent limit still applies: the request goes through the scheduler and,
 * if there is no room, starts by itself when a slot frees.
 */
export async function launchResume(ctx: Context, slug: string, sessionId: string, reason: 'limit' | 'user' | 'work' | 'main' = 'limit'): Promise<{ ok: true } | { ok: false; code: string }> {
  if (!SESSION_ID_RE.test(sessionId)) return { ok: false, code: 'no_session' };
  const a = ctx.registry.get(slug);
  if (!a || a.role !== 'agent') return { ok: false, code: 'not_suspended' };
  if (ctx.ptys.status(slug) === 'running') return { ok: false, code: 'still_running' };
  if (a.git ? !existsSync(a.git.worktree) : ctx.git.worktrees) return { ok: false, code: 'no_worktree' };
  ctx.registry.revive(slug);
  try {
    // The model the agent was started with (kept on its record): a resumed session would otherwise fall back to the profile's.
    const model = ctx.store.listAgents().find((x) => x.slug === slug)?.model;
    const result = ctx.scheduler.request({ slug, profile: a.profile, source: 'main', resume: { sessionId, reason }, ...(model ? { model } : {}) });
    ctx.broadcastState();
    if (result.status === 'started' && result.ready) await result.ready;
    return { ok: true };
  } catch (e) {
    ctx.tokens.revoke(slug);
    ctx.registry.onProcessExit(slug);
    ctx.broadcastState();
    return { ok: false, code: e instanceof Error && e.message === 'no_worktree' ? 'no_worktree' : 'agent.spawnFailed' };
  }
}

/** A queued request whose start failed later: the agent is reported as interrupted, the queue goes on. */
export function failQueuedStart(ctx: Context, r: SpawnRequest): void {
  ctx.tokens.revoke(r.slug);
  ctx.registry.onProcessExit(r.slug);
  if (r.review) ctx.review.abandonReview(r.slug); // the ticket must not stay in review for ever
  if (r.recovery) ctx.recovery.abandon(r.slug); // nor in recovery
  if (r.resume && r.resume.reason && r.resume.reason !== 'limit') {
    // A woken agent has no limit to blame: its ticket stays as it is and the main decides.
    ctx.inbox.push(ctx.projectName, `Waking "${r.slug}" failed when its turn in the queue came; it is interrupted. Try resume_agent once more, or tell the user.`);
  } else if (r.resume) {
    // A resumed ticket that could not start waits again as suspended, so the main can try once more.
    try { if (ctx.tickets.get(r.slug)?.status === 'in_progress') ctx.tickets.move(r.slug, 'suspended_limit'); } catch { /* told below anyway */ }
    ctx.inbox.push(ctx.projectName, `Resuming "${r.slug}" failed when its turn in the queue came; its ticket is suspended again.`);
  }
  if (r.resumeBranch) {
    // A replacement that could not start: its ticket must not stay in_progress with no agent. The branch is intact; the user decides.
    let moved = false;
    try { if (ctx.tickets.get(r.slug)?.status === 'in_progress') { ctx.tickets.move(r.slug, 'needs_user'); moved = true; } } catch { /* told below anyway */ }
    ctx.inbox.push(ctx.projectName, `The new agent "${r.slug}" that was to take over branch ${r.resumeBranch} could not start when its turn in the queue came${moved ? '; its ticket now needs the user (needs_user)' : ''}. The branch and its commits are intact. Tell the user.`);
  }
  ctx.broadcastState();
}

async function undoSpawn(ctx: Context, slug: string): Promise<void> {
  await ctx.ptys.discard(slug);
  ctx.tokens.revoke(slug);
  ctx.registry.remove(slug);
  ctx.store.removeAgent(slug);
}
