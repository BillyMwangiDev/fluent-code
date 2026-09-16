// --- Source control ------------------------------------------------------------
// GitHub status via `gh` (already authenticated by the user's own `gh auth login` — spec §7.5's
// "orchestrate, don't rebuild" applied to source control too). T3 Code's own PR system is a
// ~100KB multi-provider, event-sourced implementation; this covers what was actually asked for:
// merge status for what you're working on, issues assigned to you, and your open PRs.
import {api} from '../api';
import {navigate, refresh} from '../router';
import {prefs} from '../prefs';
import {h, markEl, button, askConfirm, showActionError, showNotice, actionErrorText, relativeTime, formatTokens, formatUsd, formatPercent, bytes, duration, providerLabel, providerColor, modelLinkDefaults, accountLabel, verificationPill, laneReady, quotaLabel, directoryField, pickDirectory, workspaceFolderName, segmented, isLive} from '../ui';
import {metricCard, sparklineChart, lineChart} from '../charts';

import type {AssignedIssue, OpenPullRequest, PullRequestStatus, RepoStatus, SessionSummary} from '../api';

function prPill(pr: PullRequestStatus): HTMLElement {
  if (pr.state === 'MERGED') return h('span', {class: 'pill status-running'}, ['merged']);
  if (pr.state === 'CLOSED') return h('span', {class: 'pill status-failed'}, ['closed']);
  if (pr.isDraft) return h('span', {class: 'pill'}, ['draft']);
  if (pr.checksStatus === 'failing') return h('span', {class: 'pill status-failed'}, ['checks failing']);
  if (pr.checksStatus === 'passing') return h('span', {class: 'pill status-running'}, ['checks passing']);
  if (pr.checksStatus === 'pending') return h('span', {class: 'pill status-default'}, ['checks pending']);
  return h('span', {class: 'pill'}, ['open']);
}

function repoStatusRow(directory: string, status: RepoStatus): HTMLElement {
  const name = directory.split('/').filter(Boolean).pop() ?? directory;
  if (!status.connected) {
    return h('div', {class: 'option-row'}, [
      h('span', {class: 'label'}, [name]),
      h('span', {class: 'meta'}, [status.error ?? 'not connected to GitHub'])
    ]);
  }
  const link = h('a', {href: status.pullRequest?.url ?? `https://github.com/${status.owner}/${status.repo}`, target: '_blank', rel: 'noreferrer'}, [
    status.pullRequest ? `#${status.pullRequest.number} ${status.pullRequest.title}` : `${status.owner}/${status.repo}`
  ]);
  const row = h('div', {class: 'option-row'}, [
    h('div', {}, [
      h('div', {class: 'label'}, [`${name} · ${status.branch || 'detached HEAD'}${status.dirty ? ' · uncommitted changes' : ''}`]),
      h('div', {class: 'meta'}, [link])
    ]),
    status.pullRequest ? prPill(status.pullRequest) : h('span', {class: 'pill'}, ['no PR yet'])
  ]);
  return row;
}

function issueRow(issue: AssignedIssue): HTMLElement {
  const link = h('a', {href: issue.url, target: '_blank', rel: 'noreferrer'}, [issue.title]);
  return h('div', {class: 'option-row'}, [h('div', {}, [h('div', {class: 'label'}, [link]), h('div', {class: 'meta'}, [`${issue.repo} #${issue.number}`])])]);
}

function pullRequestRow(pr: OpenPullRequest): HTMLElement {
  const link = h('a', {href: pr.url, target: '_blank', rel: 'noreferrer'}, [pr.title]);
  return h('div', {class: 'option-row'}, [
    h('div', {}, [h('div', {class: 'label'}, [link]), h('div', {class: 'meta'}, [`${pr.repo} #${pr.number}`])]),
    pr.isDraft ? h('span', {class: 'pill'}, ['draft']) : h('span', {class: 'pill status-running'}, ['open'])
  ]);
}

export async function renderSourceControl(main: HTMLElement) {
  main.append(
    h('h1', {class: 'section-title'}, [markEl(), 'source control']),
    h('p', {class: 'section-sub'}, ["GitHub status via gh — merge state for what you're working on, issues assigned to you, and your open pull requests across every repo"])
  );
  const container = h('div', {});
  main.append(container);
  container.append(h('div', {class: 'empty-state'}, ['checking GitHub…']));

  const sessions = await api.listSessions().catch(() => [] as SessionSummary[]);
  const directories = [...new Set(sessions.filter(session => session.status === 'running' || session.status === 'starting').map(session => session.directory))];
  const [statuses, issuesResult, pullRequestsResult] = await Promise.all([
    Promise.all(directories.map(async directory => ({directory, status: await api.repoStatus(directory).catch((error: unknown): RepoStatus => ({connected: false, error: error instanceof Error ? error.message : String(error)}))}))),
    api.assignedIssues(),
    api.myOpenPullRequests()
  ]);

  container.innerHTML = '';

  container.append(
    h('div', {class: 'card'}, [
      h('h3', {}, ["what you're working on"]),
      h('p', {class: 'section-sub'}, ['Git/PR status for each running session\'s working directory.']),
      ...(statuses.length ? statuses.map(({directory, status}) => repoStatusRow(directory, status)) : [h('p', {class: 'section-sub'}, ['No active sessions.'])])
    ])
  );

  container.append(
    h('div', {class: 'card'}, [
      h('h3', {}, ['assigned to you']),
      ...(Array.isArray(issuesResult)
        ? issuesResult.length
          ? issuesResult.map(issue => issueRow(issue))
          : [h('p', {class: 'section-sub'}, ['No open issues assigned to you.'])]
        : [h('p', {class: 'section-sub'}, [issuesResult.error])])
    ])
  );

  container.append(
    h('div', {class: 'card'}, [
      h('h3', {}, ['your open pull requests']),
      ...(Array.isArray(pullRequestsResult)
        ? pullRequestsResult.length
          ? pullRequestsResult.map(pr => pullRequestRow(pr))
          : [h('p', {class: 'section-sub'}, ['No open pull requests.'])]
        : [h('p', {class: 'section-sub'}, [pullRequestsResult.error])])
    ])
  );
}
