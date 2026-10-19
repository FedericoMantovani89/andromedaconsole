import { git } from '../git/git';
import { repoPathOf } from '../git/repos';
import { agentBranchFor } from '../git/worktree';
import type { Ticket, TicketStore } from './store';

/** Why a ticket started after another one (`spawn_agent after`) may not be reviewed or merged yet. */
export interface AfterRefusal { code: 'after_not_merged'; params: { after: string; status: string } }

/**
 * The gate of a dependent ticket (SPEC 15.4): the ticket of the agent it was started after must be merged first (`released` was merged
 * before it was released). When that ticket is gone the repository decides: the other agent's branch already in the project branch,
 * or the console's own merge commit of it there (a squash merge keeps no ancestry). Undefined means the ticket may go on.
 */
export async function afterGate(d: { tickets: TicketStore; root: string; project: string }, ticket: Ticket): Promise<AfterRefusal | undefined> {
  const after = ticket.after;
  if (after === undefined) return undefined;
  const other = d.tickets.get(after);
  if (other?.status === 'merged' || other?.status === 'released') return undefined;
  if (other) return { code: 'after_not_merged', params: { after, status: other.status } };
  // Every git call goes to the ticket's own repository, never the project folder (a folder of sub-repos has no git of its own).
  const repo = repoPathOf(d.root, ticket.repo);
  const project = `project/${d.project}`;
  const branch = agentBranchFor(d.project, after);
  const tip = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (tip.code === 0 && (await git(repo, ['merge-base', '--is-ancestor', tip.stdout.trim(), `refs/heads/${project}`])).code === 0) return undefined;
  const commit = await git(repo, ['log', '-1', '--format=%H', '-E', `--grep=^Ticket: ${after}$`, `--grep=^Agent: ${after}$`, '--all-match', `refs/heads/${project}`]);
  if (commit.code === 0 && /^[0-9a-f]{40}$/.test(commit.stdout.trim())) return undefined;
  return { code: 'after_not_merged', params: { after, status: 'missing' } };
}
