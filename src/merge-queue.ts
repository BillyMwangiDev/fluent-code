import {execFile} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import type {MergeOutcome, MergePlan, SessionSummary} from './daemon-protocol.js';
import type {VerificationRunner} from './verification.js';

const run = promisify(execFile);

const git = (directory: string, args: string[], timeout = 20_000) => run('git', ['-C', directory, ...args], {timeout, maxBuffer: 8_000_000});

/**
 * Builds a commit object containing everything in a lane's working tree — tracked edits and new
 * files alike — without touching its index, its working tree, or any ref.
 *
 * `git stash create` is the obvious tool and the wrong one: it silently omits untracked files, and
 * a coding agent's work is mostly new files, so a lane that had only added files looked like a
 * lane with nothing to merge. Staging into a throwaway index gets the real tree; .gitignore still
 * applies, because `add -A` still reads it.
 *
 * Returns undefined when there is nothing uncommitted, in which case the lane's own HEAD is
 * already what would be merged.
 */
export async function previewCommit(directory: string) {
  const scratch = await mkdtemp(join(tmpdir(), 'fluent-index-'));
  const index = join(scratch, 'index');
  try {
    const env = {...process.env, GIT_INDEX_FILE: index};
    await run('git', ['-C', directory, 'read-tree', 'HEAD'], {env, timeout: 20_000});
    await run('git', ['-C', directory, 'add', '-A'], {env, timeout: 60_000});
    const tree = (await run('git', ['-C', directory, 'write-tree'], {env, timeout: 20_000})).stdout.trim();
    const head = (await run('git', ['-C', directory, 'rev-parse', 'HEAD'], {timeout: 10_000})).stdout.trim();
    const headTree = (await run('git', ['-C', directory, 'rev-parse', 'HEAD^{tree}'], {timeout: 10_000})).stdout.trim();
    if (tree === headTree) return undefined;
    const commit = await run('git', ['-C', directory, 'commit-tree', tree, '-p', head, '-m', 'fluent lane preview'], {timeout: 20_000});
    return commit.stdout.trim();
  } catch {
    return undefined;
  } finally {
    await rm(scratch, {recursive: true, force: true}).catch(() => undefined);
  }
}

/**
 * Parses `git merge-tree --write-tree --name-only`. On a clean merge it prints the resulting tree
 * and exits 0; on a conflicted one it exits 1 and prints the tree, then the conflicted paths, then
 * a blank line and human-readable messages.
 */
export function conflictsFrom(stdout: string) {
  const [, ...rest] = stdout.split('\n');
  const conflicts: string[] = [];
  for (const line of rest) {
    if (!line.trim()) break;
    conflicts.push(line.trim());
  }
  return conflicts;
}

/**
 * Integrates finished lanes one at a time.
 *
 * Parallel lanes are only faster than one agent if their work can actually get back into the base
 * branch, and that is where the field measures the loss: 27.67% of AI-agent pull requests hit
 * textual merge conflicts, 41.7% when two different agents touched the same code — the exact
 * configuration the orchestration screen runs (docs/research/2026-09-13-agent-orchestration.md
 * §2.3). Serializing integration against a base that moves after each merge is also what keeps
 * error amplification near the ~4.4x of a centralized validation bottleneck rather than the ~17x
 * of uncoordinated agents (§2.2).
 *
 * The rules this will not break, because it writes to the user's own checkout:
 * - It never rewrites history. No rebase, no amend, no force. A lane merges as a merge commit.
 * - It never merges into a dirty checkout, or one on a detached HEAD.
 * - It never merges a lane whose predicted conflicts are non-empty, and never resolves one itself.
 * - It never merges a lane whose own project checks failed.
 * - A lane it cannot integrate is reported and the queue moves on: one lane still running is no
 *   reason to hold up a finished one. Order is still strictly preserved, and every lane is planned
 *   afresh when its turn comes, so nothing ever merges on stale information.
 */
export class MergeQueue {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly waiting = new Map<string, string[]>();

  constructor(private readonly verification: VerificationRunner) {}

  /** Lanes queued but not yet integrated, per project. */
  pending(project: string) {
    return [...(this.waiting.get(project) ?? [])];
  }

  /**
   * What integrating this lane would do, without doing any of it. The lane's uncommitted work is
   * turned into a commit object through a throwaway index (see `previewCommit`), which writes
   * objects but changes no ref, no index and no working tree — so a plan stays a plan.
   */
  async plan(session: SessionSummary): Promise<MergePlan> {
    const project = session.projectDirectory;
    const blockers: string[] = [];
    if (!project || !session.worktreePath) {
      return {sessionId: session.id, base: '', baseHead: '', laneHead: '', uncommittedFiles: 0, ahead: 0, conflicts: [], blockers: ['This session runs in the project checkout itself, so there is nothing to merge.']};
    }

    const base = await git(project, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then(result => result.stdout.trim(), () => '');
    if (!base) blockers.push('The project checkout is on a detached HEAD — check out the branch you want this lane merged into.');

    const projectStatus = await git(project, ['status', '--porcelain']).then(result => result.stdout.trim(), () => '');
    if (projectStatus) blockers.push('The project checkout has uncommitted changes — commit or stash them before merging a lane into it.');
    if (session.status === 'running' || session.status === 'starting') blockers.push('This lane is still running — stop it so its working tree stops moving.');

    const baseHead = base ? await git(project, ['rev-parse', base]).then(result => result.stdout.trim(), () => '') : '';
    const laneStatus = await git(session.directory, ['status', '--porcelain']).then(result => result.stdout.trim(), () => '');
    const uncommittedFiles = laneStatus ? laneStatus.split('\n').length : 0;
    const preview = uncommittedFiles > 0 ? await previewCommit(session.directory) : undefined;
    const laneHead = preview ?? await git(session.directory, ['rev-parse', 'HEAD']).then(result => result.stdout.trim(), () => '');

    let conflicts: string[] = [];
    let ahead = 0;
    if (baseHead && laneHead) {
      ahead = await git(project, ['rev-list', '--count', `${baseHead}..${laneHead}`]).then(result => Number(result.stdout.trim()) || 0, () => 0);
      conflicts = await git(project, ['merge-tree', '--write-tree', '--name-only', baseHead, laneHead])
        .then(() => [], (error: {stdout?: string}) => conflictsFrom(error.stdout ?? ''));
    }
    if (baseHead && laneHead && baseHead === laneHead) blockers.push('This lane has no changes to merge.');

    return {sessionId: session.id, base, baseHead, laneHead, uncommittedFiles, ahead, conflicts, blockers};
  }

  /**
   * Queues a lane for integration. Lanes on one project are integrated strictly in the order they
   * were queued, each planned against the base as it stands after the previous merge — so a lane
   * that would have merged cleanly an hour ago is re-checked against what actually landed since.
   */
  async integrate(session: SessionSummary, load: (sessionId: string) => SessionSummary): Promise<MergeOutcome> {
    const project = session.projectDirectory ?? session.directory;
    const queue = this.waiting.get(project) ?? [];
    queue.push(session.id);
    this.waiting.set(project, queue);

    const chain = (this.chains.get(project) ?? Promise.resolve()).then(
      () => this.integrateNow(load(session.id)),
      () => this.integrateNow(load(session.id))
    ).finally(() => {
      this.waiting.set(project, (this.waiting.get(project) ?? []).filter(id => id !== session.id));
    });
    this.chains.set(project, chain.catch(() => undefined));
    return chain;
  }

  private async integrateNow(session: SessionSummary): Promise<MergeOutcome> {
    const plan = await this.plan(session);
    if (plan.blockers.length > 0) return {sessionId: session.id, status: 'blocked', plan, detail: plan.blockers.join(' ')};
    if (plan.conflicts.length > 0) {
      return {
        sessionId: session.id,
        status: 'conflicted',
        plan,
        detail: `${plan.conflicts.length} file${plan.conflicts.length === 1 ? '' : 's'} would conflict with ${plan.base}: ${plan.conflicts.slice(0, 5).join(', ')}${plan.conflicts.length > 5 ? ', …' : ''}. Resolve it in the lane, then queue it again.`
      };
    }

    const verification = await this.verification.verify({
      sessionId: session.id,
      directory: session.directory,
      project: session.projectDirectory ?? session.directory
    });
    if (verification.status === 'failed') {
      return {sessionId: session.id, status: 'unverified', plan, verification, detail: `${plan.base} is not taking this lane: its own checks fail (${verification.command}).`};
    }

    const project = session.projectDirectory!;
    // Commit the lane's own work in its own worktree. The plan merged a preview commit, which no
    // ref points at — this is what makes the merged commit durable.
    if (plan.uncommittedFiles > 0) {
      try {
        await git(session.directory, ['add', '-A']);
        await git(session.directory, ['commit', '-m', commitMessage(session)]);
      } catch (error) {
        return {sessionId: session.id, status: 'failed', plan, verification, detail: `Could not commit this lane's work: ${message(error)}`};
      }
    }
    const laneHead = await git(session.directory, ['rev-parse', 'HEAD']).then(result => result.stdout.trim(), () => '');

    try {
      // --no-ff so every lane is a visible merge in the base's history rather than silently
      // replayed into it, and --no-commit is deliberately not used: nothing is left half-done.
      await git(project, ['merge', '--no-ff', '-m', mergeMessage(session, plan.base), laneHead], 60_000);
    } catch (error) {
      // A merge that fails here leaves the checkout mid-merge, which is the user's tree — undo it
      // rather than handing it back in a state they did not ask for.
      await git(project, ['merge', '--abort']).catch(() => undefined);
      return {sessionId: session.id, status: 'failed', plan, verification, detail: `The merge into ${plan.base} did not apply and was rolled back: ${message(error)}`};
    }

    const mergeCommit = await git(project, ['rev-parse', 'HEAD']).then(result => result.stdout.trim(), () => undefined);
    const caveat = verification.status === 'unavailable' ? ' This project has no checks fluentd could run, so nothing verified it.' : '';
    return {sessionId: session.id, status: 'merged', plan: {...plan, laneHead}, verification, mergeCommit, detail: `Merged into ${plan.base}.${caveat}`};
  }
}

function commitMessage(session: SessionSummary) {
  return session.task?.trim() ? `${session.task.trim()}\n\nWorked by a ${session.provider} lane in Fluent Code.` : `Work from a ${session.provider} lane in Fluent Code.`;
}

function mergeMessage(session: SessionSummary, base: string) {
  const subject = session.task?.trim() || `${session.provider} lane ${session.id.slice(0, 8)}`;
  return `Merge lane: ${subject}\n\nInto ${base} from a Fluent Code agent lane.`;
}

function message(error: unknown) {
  const failure = error as {stderr?: string; stdout?: string; message?: string};
  return (failure.stderr || failure.stdout || failure.message || 'unknown error').trim().split('\n').slice(0, 3).join(' ');
}
