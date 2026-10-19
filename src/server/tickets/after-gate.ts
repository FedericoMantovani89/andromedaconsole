import { git } from '../git/git';
import { repoPathOf } from '../git/repos';
import { agentBranchFor } from '../git/worktree';
import type { Ticket, TicketStore } from './store';

/** Why a ticket started after another one (`spawn_agent after`) may not be reviewed or merged yet. */
export interface AfterRefusal { code: 'after_not_merged'; params: { after: string; status: string }; detail: string }

/** Where the ticket a dependent one waits for is: its status (`missing` when no ticket has that name) and whether its work is merged. */
export interface AfterState { name: string; status: string; merged: boolean }

type GateDeps = { tickets: TicketStore; root: string; project: string };

/**
 * The state of the ticket a dependent ticket was started after (SPEC 15.4). `merged`/`released` count as merged (a released ticket
 * was merged first). When no ticket has that name the repository decides: the other agent's branch already in the project branch,
 * or the console's own merge commit of it there (a squash merge keeps no ancestry). Undefined for a ticket with no `after`.
 */
export async function afterState(d: GateDeps, ticket: Ticket): Promise<AfterState | undefined> {
  const name = ticket.after;
  if (name === undefined) return undefined;
  const other = d.tickets.get(name);
  if (other) return { name, status: other.status, merged: other.status === 'merged' || other.status === 'released' };
  // Every git call goes to the ticket's own repository, never the project folder (a folder of sub-repos has no git of its own).
  const repo = repoPathOf(d.root, ticket.repo);
  const project = `refs/heads/project/${d.project}`;
  const tip = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${agentBranchFor(d.project, name)}`]);
  if (tip.code === 0 && (await git(repo, ['merge-base', '--is-ancestor', tip.stdout.trim(), project])).code === 0) return { name, status: 'missing', merged: true };
  const commit = await git(repo, ['log', '-1', '--format=%H', '-E', `--grep=^Ticket: ${name}$`, `--grep=^Agent: ${name}$`, '--all-match', project]);
  return { name, status: 'missing', merged: commit.code === 0 && /^[0-9a-f]{40}$/.test(commit.stdout.trim()) };
}

/** The gate of a dependent ticket: undefined means it may be reviewed and merged; otherwise the refusal, with what to do about it. */
export async function afterGate(d: GateDeps, ticket: Ticket): Promise<AfterRefusal | undefined> {
  const s = await afterState(d, ticket);
  if (!s || s.merged) return undefined;
  const detail = s.status === 'missing'
    ? `this ticket was started after "${s.name}", whose ticket is gone and whose work is not on project/${d.project}: merge its branch, or ask the user`
    : `this ticket was started after "${s.name}", whose ticket is ${s.status}: it can be reviewed and merged once "${s.name}" is merged`;
  return { code: 'after_not_merged', params: { after: s.name, status: s.status }, detail };
}

/**
 * Where a dependent ticket's own work begins, for its report, its review diff and its squash merge: the commit it started from
 * (`baseSha`), as long as the branch has not taken the project branch in since (a conflict round merges it into the author's branch;
 * then the usual merge base is the newer one). Undefined means the usual `project/<project>...head`.
 */
export async function ownWorkBase(repo: string, project: string, ticket: Ticket, head: string): Promise<string | undefined> {
  const base = ticket.baseSha;
  if (base === undefined) return undefined;
  if ((await git(repo, ['merge-base', '--is-ancestor', base, head])).code !== 0) return undefined; // not this branch's history any more
  const mb = await git(repo, ['merge-base', `refs/heads/project/${project}`, head]);
  if (mb.code !== 0) return base;
  return (await git(repo, ['merge-base', '--is-ancestor', mb.stdout.trim(), base])).code === 0 ? base : undefined;
}
