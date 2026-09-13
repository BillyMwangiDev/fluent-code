import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);

/**
 * GitHub integration via the `gh` CLI — the same orchestrate-don't-rebuild approach the rest of
 * Fluent takes with provider CLIs (spec §7.5's principle applied here too): this shells out to
 * `gh` (already authenticated by the user's own `gh auth login`) rather than managing OAuth
 * tokens or reimplementing GitHub's API client. T3 Code's own source-control system is a
 * multi-provider, event-sourced, ~100KB implementation (apps/server/src/pullRequest/*) — far
 * more than what was asked for here; this covers the three concrete things requested: merge
 * status, assigned issues, and in-progress PRs, scoped to GitHub only.
 */

export type PullRequestChecksStatus = 'pending' | 'passing' | 'failing' | 'unknown';

export type PullRequestStatus = {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  mergedAt: string | null;
  checksStatus: PullRequestChecksStatus;
};

export type RepoStatus = {
  connected: boolean;
  owner?: string;
  repo?: string;
  branch?: string;
  dirty?: boolean;
  pullRequest?: PullRequestStatus;
  error?: string;
};

export type AssignedIssue = {
  number: number;
  title: string;
  url: string;
  repo: string;
};

export type OpenPullRequest = {
  number: number;
  title: string;
  url: string;
  repo: string;
  isDraft: boolean;
};

let ghAvailableCache: {value: boolean; checkedAt: number} | undefined;

async function ghAvailable(): Promise<boolean> {
  if (ghAvailableCache && Date.now() - ghAvailableCache.checkedAt < 60_000) return ghAvailableCache.value;
  const value = await run('gh', ['auth', 'status'], {timeout: 3_000})
    .then(() => true)
    .catch(() => false);
  ghAvailableCache = {value, checkedAt: Date.now()};
  return value;
}

function checksStatusFrom(rollup: unknown): PullRequestChecksStatus {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'unknown';
  const entries = rollup as Array<{status?: string; conclusion?: string}>;
  if (entries.some(entry => entry.status && entry.status !== 'COMPLETED')) return 'pending';
  if (entries.some(entry => entry.conclusion && !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(entry.conclusion))) return 'failing';
  return 'passing';
}

function parseGitHubRemote(remoteUrl: string): {owner: string; repo: string} | undefined {
  const match = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/([^/.]+?)(\.git)?$/);
  return match ? {owner: match[1]!, repo: match[2]!} : undefined;
}

/** Status for one project directory — the "what am I working on" view for a single Fluent
 * session. Never throws: an unconnected or non-GitHub repo is a normal, advisory result. */
export async function repoStatus(directory: string): Promise<RepoStatus> {
  let remoteUrl: string;
  try {
    remoteUrl = (await run('git', ['remote', 'get-url', 'origin'], {cwd: directory, timeout: 3_000})).stdout;
  } catch {
    return {connected: false, error: 'not a git repository, or has no "origin" remote'};
  }
  const parsed = parseGitHubRemote(remoteUrl);
  if (!parsed) return {connected: false, error: 'origin is not a GitHub remote'};

  const [branchResult, statusResult] = await Promise.all([
    run('git', ['branch', '--show-current'], {cwd: directory, timeout: 3_000}).catch(() => ({stdout: ''})),
    run('git', ['status', '--porcelain'], {cwd: directory, timeout: 3_000}).catch(() => ({stdout: ''}))
  ]);
  const branch = branchResult.stdout.trim();
  const dirty = statusResult.stdout.trim().length > 0;

  let pullRequest: PullRequestStatus | undefined;
  if (await ghAvailable()) {
    try {
      const {stdout} = await run('gh', ['pr', 'view', '--json', 'number,title,url,state,isDraft,mergedAt,statusCheckRollup'], {cwd: directory, timeout: 6_000});
      const pr = JSON.parse(stdout) as {number: number; title: string; url: string; state: PullRequestStatus['state']; isDraft: boolean; mergedAt: string | null; statusCheckRollup: unknown};
      pullRequest = {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        isDraft: pr.isDraft,
        mergedAt: pr.mergedAt,
        checksStatus: checksStatusFrom(pr.statusCheckRollup)
      };
    } catch {
      // No PR open for this branch yet — a normal state, not an error.
    }
  }

  return {connected: true, owner: parsed.owner, repo: parsed.repo, branch, dirty, pullRequest};
}

/** Issues assigned to the authenticated GitHub user, across every repo they can see — GitHub's
 * own `/issues?filter=assigned` endpoint, not scoped to the current project. */
export async function assignedIssues(): Promise<AssignedIssue[] | {error: string}> {
  if (!(await ghAvailable())) return {error: 'gh CLI is not installed or not authenticated — run `gh auth login`'};
  try {
    const {stdout} = await run('gh', ['api', '/issues?filter=assigned&state=open&per_page=30'], {timeout: 8_000});
    const items = JSON.parse(stdout) as Array<{number: number; title: string; html_url: string; repository?: {full_name: string}; pull_request?: unknown}>;
    return items.filter(item => !item.pull_request).map(item => ({number: item.number, title: item.title, url: item.html_url, repo: item.repository?.full_name ?? ''}));
  } catch (error) {
    return {error: error instanceof Error ? error.message : 'failed to reach GitHub'};
  }
}

/** Open PRs authored by the authenticated user across every repo — the cross-project half of
 * "what am I working on," complementing per-session repoStatus above. */
export async function myOpenPullRequests(): Promise<OpenPullRequest[] | {error: string}> {
  if (!(await ghAvailable())) return {error: 'gh CLI is not installed or not authenticated — run `gh auth login`'};
  try {
    const {stdout} = await run('gh', ['api', '-X', 'GET', 'search/issues', '-f', 'q=is:pr is:open author:@me', '--jq', '.items'], {timeout: 8_000});
    const items = JSON.parse(stdout) as Array<{number: number; title: string; html_url: string; repository_url: string; draft?: boolean}>;
    return items.map(item => {
      const repoMatch = item.repository_url.match(/repos\/([^/]+\/[^/]+)$/);
      return {number: item.number, title: item.title, url: item.html_url, repo: repoMatch ? repoMatch[1]! : item.repository_url, isDraft: Boolean(item.draft)};
    });
  } catch (error) {
    return {error: error instanceof Error ? error.message : 'failed to reach GitHub'};
  }
}
