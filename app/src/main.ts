import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import '@fontsource/archivo/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/700.css';
import {
  activeRemoteSocket,
  api,
  onAdmissionWarning,
  onCredentialNotice,
  onCredentialSwitched,
  onSessionVerification,
  selectRemoteSocket,
  subscribeSession,
  type CredentialChainState,
  type HardwareSample,
  type PriceOverride,
  type ProviderId,
  type MergeOutcome,
  type MergePlan,
  type QuotaWindow,
  type SessionSummary,
  type SpendModelBucket,
  type VerificationResult,
  type VerificationStatus
} from './api';

const root = document.getElementById('app')!;

type Route =
  | {name: 'splash'}
  | {name: 'onboarding'}
  | {name: 'sessions'}
  | {name: 'new-session'}
  | {name: 'active-session'; sessionId: string}
  | {name: 'credentials'}
  | {name: 'usage'}
  | {name: 'spend'}
  | {name: 'themes'}
  | {name: 'orchestration'}
  | {name: 'design'}
  | {name: 'preview'}
  | {name: 'remote'};

let route: Route = {name: 'splash'};
// Non-null only while an <active-session> view is mounted, so navigating away can clean it up.
let activeSessionCleanup: (() => void) | undefined;
let credentialProvider: ProviderId = 'claude';
type Appearance = 'system' | 'dark' | 'light';
type ThemeMode = 'dark' | 'light';
const appearanceKey = 'fluent.appearance';
const bundleKey = 'fluent.theme-bundles';
let appearance: Appearance = (localStorage.getItem(appearanceKey) as Appearance | null) ?? 'system';
let bundles: Record<ThemeMode, string> = JSON.parse(localStorage.getItem(bundleKey) ?? '{"dark":"Fluent Dark","light":"Fluent Light"}');

function resolvedMode(): ThemeMode {
  return appearance === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : appearance;
}

function applyAppearance() {
  document.documentElement.dataset.theme = resolvedMode();
  document.documentElement.dataset.bundle = bundles[resolvedMode()];
}
applyAppearance();
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (appearance === 'system') applyAppearance();
});

function terminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  return {
    background: token('--bg-inset'),
    foreground: token('--fg'),
    cursor: token('--coral'),
    selectionBackground: token('--coral-tint'),
    black: token('--bg'),
    brightBlack: token('--fg-faint'),
    white: token('--fg'),
    brightWhite: token('--surface'),
    red: token('--error'),
    brightRed: token('--error'),
    green: token('--success'),
    brightGreen: token('--success'),
    yellow: token('--coral'),
    brightYellow: token('--coral-hover'),
    blue: token('--ink-3'),
    brightBlue: token('--ink-2'),
    magenta: token('--coral'),
    brightMagenta: token('--coral-hover'),
    cyan: token('--ink-2'),
    brightCyan: token('--ink-3')
  };
}

function terminalFontSize() {
  const size = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--terminal-font-size'), 10);
  return Number.isFinite(size) ? size : 13;
}

function navigate(next: Route) {
  activeSessionCleanup?.();
  activeSessionCleanup = undefined;
  route = next;
  void render();
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = []
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') element.className = value;
    else element.setAttribute(key, value);
  }
  for (const child of children) element.append(child);
  return element;
}

/** The headline of the headroom advice — what the user needs before deciding, in one line. */
function admissionLabel(verdict: {decision: 'clear' | 'tight' | 'over'; recommendedLanes: number}) {
  if (verdict.decision === 'over') return 'no headroom for another lane';
  if (verdict.decision === 'tight') return 'room for about one more lane';
  return `room for about ${verdict.recommendedLanes} more lanes`;
}

/** One provider-reported quota window, labelled by its own duration rather than by either
 * vendor's name for it — Claude Code's 5h/7d and Codex's primary/secondary are the same windows,
 * and the observatory shows both providers in one table. */
function quotaLabel(window?: QuotaWindow) {
  if (!window || window.usedPercent === undefined) return '—';
  const minutes = window.windowMinutes;
  const name = minutes === undefined ? 'quota' : minutes % 1440 === 0 ? `${minutes / 1440}d` : `${Math.round(minutes / 60)}h`;
  return `${name} ${window.usedPercent.toFixed(0)}%`;
}

/** A lane's state against the project's own checks, kept visually distinct from its process
 * status: a lane can be running and green, or exited and red, and one pill cannot say both. */
function verificationPill(status?: VerificationStatus) {
  if (!status) return h('span', {class: 'meta'}, ['—']);
  const label = {running: 'checking', passed: 'verified', failed: 'failing', unavailable: 'no checks'}[status];
  return h('span', {class: `pill verify-${status}`}, [label]);
}

/** Lane-ready latency, shown per session rather than averaged away: this is the number the
 * orchestrator's speed claim rests on, and a lane whose caches could not be warmed says so. */
function laneReady(session: {prepareMs?: number; warmedPaths?: string[]; worktreePath?: string}) {
  if (session.prepareMs === undefined) return session.worktreePath ? '—' : 'shared checkout';
  const seconds = session.prepareMs / 1000;
  const duration = seconds < 1 ? `${session.prepareMs}ms` : `${seconds.toFixed(1)}s`;
  const warmed = session.warmedPaths ?? [];
  return warmed.length > 0 ? `${duration} · warmed ${warmed.join(', ')}` : `${duration} · cold`;
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function accountLabel(accountId: string | undefined, chains: CredentialChainState[]): string {
  if (!accountId) return '—';
  for (const chain of chains) {
    const account = chain.accounts.find(candidate => candidate.id === accountId);
    if (account) return account.label;
  }
  return accountId;
}

async function render() {
  root.innerHTML = '';
  if (route.name !== 'splash') root.append(renderTopbar());
  const main = h('main');
  root.append(main);

  try {
    switch (route.name) {
      case 'splash':
        await renderSplash(main);
        break;
      case 'onboarding':
        await renderOnboarding(main);
        break;
      case 'sessions':
        await renderSessions(main);
        break;
      case 'new-session':
        await renderNewSession(main);
        break;
      case 'active-session':
        await renderActiveSession(main, route.sessionId);
        break;
      case 'credentials':
        await renderCredentials(main);
        break;
      case 'usage':
        await renderUsage(main);
        break;
      case 'spend':
        await renderSpend(main);
        break;
      case 'themes':
        await renderThemes(main);
        break;
      case 'orchestration':
        await renderOrchestration(main);
        break;
      case 'design':
        await renderDesignWorkspace(main);
        break;
      case 'preview':
        await renderPreview(main);
        break;
      case 'remote':
        await renderRemote(main);
        break;
    }
  } catch (error) {
    main.innerHTML = '';
    main.append(h('p', {class: 'splash error'}, [error instanceof Error ? error.message : String(error)]));
  }
}

function renderTopbar(): HTMLElement {
  const nav = h('nav', {}, [
    navButton('sessions', 'sessions'),
    navButton('new session', 'new-session'),
    navButton('credentials', 'credentials'),
    navButton('usage', 'usage'),
    navButton('spend', 'spend'),
    navButton('themes', 'themes'),
    navButton('orchestrate', 'orchestration'),
    navButton('design', 'design'),
    navButton('preview', 'preview'),
    navButton('remote', 'remote')
  ]);
  return h('div', {class: 'topbar'}, [
    h('div', {class: 'brand'}, [markEl(), 'fluent code']),
    h('div', {class: 'topbar-right'}, [activeRemoteSocket() ? h('span', {class: 'target-pill'}, ['● remote target']) : h('span', {class: 'target-pill local'}, ['● local target']), nav])
  ]);
}

// --- Usage observatory -------------------------------------------------------

function bytes(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return 'unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let amount = value;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index < 2 ? 0 : 1)} ${units[index]}`;
}

function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function sparkline(samples: HardwareSample[], key: keyof Pick<HardwareSample, 'cpuPercent' | 'memoryUsedBytes'>): string;
function sparkline(samples: Array<{capturedAt: string; contextPercent?: number}>, key: 'contextPercent'): string;
function sparkline(samples: Array<Record<string, unknown>> | HardwareSample[] | Array<{capturedAt: string; contextPercent?: number}>, key: string): string {
  const values = samples.map(sample => Number((sample as Record<string, unknown>)[key])).filter(Number.isFinite);
  if (values.length < 2) return '—';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const glyphs = '▁▂▃▄▅▆▇█';
  return values.map(value => glyphs[Math.min(glyphs.length - 1, Math.round(((value - min) / Math.max(max - min, 1)) * (glyphs.length - 1)))]).join('');
}

async function renderUsage(main: HTMLElement) {
  const [hardware, sessions, software, usage, resources] = await Promise.all([api.hardwareSnapshot(), api.listSessions(), api.softwareSnapshot(), api.usageSnapshot(), api.resourceSnapshot().catch(() => undefined)]);
  const {current, history} = hardware;
  const refresh = h('button', {class: 'btn'}, ['refresh']);
  refresh.addEventListener('click', () => void render());
  main.append(
    h('div', {class: 'toolbar'}, [
      h('div', {}, [h('h1', {class: 'section-title'}, [markEl(), 'usage observatory']), h('p', {class: 'section-sub'}, ['local-only hardware and session health · provider token telemetry connects when adapters expose it'])]),
      refresh
    ])
  );
  const memoryPercent = current.memoryTotalBytes ? (current.memoryUsedBytes / current.memoryTotalBytes) * 100 : 0;
  main.append(h('div', {class: 'metrics-grid'}, [
    metricCard('cpu process share', `${current.cpuPercent.toFixed(1)}%`, sparkline(history, 'cpuPercent')),
    metricCard('memory', `${bytes(current.memoryUsedBytes)} / ${bytes(current.memoryTotalBytes)}`, sparkline(history, 'memoryUsedBytes')),
    metricCard('disk used', `${bytes(current.diskUsedBytes)} / ${bytes(current.diskTotalBytes)}`, current.diskTotalBytes ? `${((current.diskUsedBytes! / current.diskTotalBytes) * 100).toFixed(0)}% capacity` : 'not available'),
    metricCard('uptime', duration(current.uptimeSeconds), `${current.platform} · ${current.arch}`)
  ]));
  main.append(h('div', {class: 'cards-row'}, [
    h('div', {class: 'card'}, [
      h('h3', {}, ['hardware trace']),
      h('p', {class: 'trace cpu'}, [`cpu     ${sparkline(history, 'cpuPercent')}`]),
      h('p', {class: 'trace memory'}, [`memory  ${sparkline(history, 'memoryUsedBytes')}`]),
      h('p', {class: 'section-sub'}, [`load average  ${current.loadAverage.map(value => value.toFixed(2)).join(' · ')}  ·  fluentd rss ${bytes(current.processRssBytes)}`])
    ]),
    h('div', {class: 'card'}, [
      h('h3', {}, ['agent capacity advisory']),
      h('p', {}, [memoryPercent > 85 || current.cpuPercent > 85 ? 'running low on headroom — hold new agents until load falls.' : 'headroom looks healthy — additional agents remain advisory, not guaranteed.']),
      h('p', {class: 'section-sub'}, [`${sessions.filter(session => session.status === 'running').length} live sessions · no automatic throttle`])
    ])
  ]));
  if (usage.sessions.length) {
    main.append(h('div', {class: 'card'}, [
      h('h3', {}, ['provider usage · each provider\'s own telemetry']),
      ...usage.sessions.map(item => h('div', {class: 'usage-row'}, [
        h('strong', {}, [item.model ?? (item.provider === 'codex' ? 'Codex' : 'Claude Code')]),
        h('span', {class: 'trace'}, [`context ${item.contextPercent?.toFixed(0) ?? '—'}%  ${sparkline(item.history, 'contextPercent')}`]),
        h('span', {class: 'section-sub'}, [`input ${formatTokens(item.inputTokens)} · output ${formatTokens(item.outputTokens)} · cache ${item.cacheHitRatio === undefined ? '—' : `${(item.cacheHitRatio * 100).toFixed(0)}%`} · cost ${item.costUsd === undefined ? '—' : `$${item.costUsd.toFixed(2)}`}`]),
        h('span', {class: 'section-sub'}, [`${quotaLabel(item.quota?.primary)} · ${quotaLabel(item.quota?.secondary)} · ${relativeTime(item.updatedAt)}`])
      ]))
    ]));
  } else {
    main.append(h('div', {class: 'card'}, [
      h('h3', {}, ['provider usage']),
      h('p', {class: 'section-sub'}, ['Claude Code usage will appear after its first response in a Fluent-launched session. Existing custom Claude status lines are preserved and are not replaced.'])
    ]));
  }
  main.append(h('div', {class: 'card'}, [
    h('h3', {}, ['software health']),
    h('p', {class: 'section-sub'}, [`${software.hostname} · kernel ${software.kernel} · Node ${software.nodeVersion} · fluentd ${software.daemonPid}`]),
    h('p', {class: 'section-sub'}, [software.git ? `git ${software.git.replace(/\n/g, ' · ')}` : 'git state unavailable from fluentd working directory']),
    ...software.providers.map(provider => h('p', {class: 'section-sub'}, [`${provider.label}  ${provider.installed ? provider.version || 'installed' : 'not installed'}`]))
  ]));
  if (resources) {
    const top = [...resources.processes].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 5);
    main.append(h('div', {class: 'card'}, [
      h('h3', {}, ['agent process resources']),
      h('p', {class: 'section-sub'}, [`${resources.retainedProcessCount} retained of ${resources.scannedProcessCount} scanned processes · sample ${resources.sequence}`]),
      ...top.map(process => h('p', {class: 'section-sub'}, [`${process.name} (${process.pid}) · ${process.cpuPercent.toFixed(1)}% CPU · ${bytes(process.residentBytes)} RSS · read ${bytes(process.ioReadBytes)} · write ${bytes(process.ioWriteBytes)}`]))
    ]));
  }
}

function formatTokens(value: number | undefined) {
  if (value === undefined) return '—';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function metricCard(label: string, value: string, detail: string): HTMLElement {
  return h('div', {class: 'metric-card'}, [h('span', {class: 'metric-label'}, [label]), h('strong', {}, [value]), h('span', {class: 'metric-detail'}, [detail])]);
}

// --- Spend ---------------------------------------------------------------------
// Layout adapted from T3 Code's Usage page (apps/web/src/components/usage/UsagePage.tsx,
// MIT licensed) — the same visual shape (provider breakdown + daily chart, totals row, a
// model/day breakdown table, price overrides) redrawn as vanilla TS/CSS. Distinct from the
// 'usage' screen above (which is live, per-session status-line telemetry): this is cross-session
// historical cost, scanned from the providers' own transcript files, same as T3's approach.

const providerLabel: Record<ProviderId, string> = {claude: 'Claude Code', codex: 'Codex'};

function formatUsd(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {month: 'short', day: 'numeric', timeZone: 'UTC'});
}

function sumTokenTotals(a: {uncachedInputTokens: number; cachedInputTokens: number; cacheCreationTokens: number; outputTokens: number}): number {
  return a.uncachedInputTokens + a.cachedInputTokens + a.cacheCreationTokens + a.outputTokens;
}

async function renderSpend(main: HTMLElement) {
  let rangeDays = 30;
  let breakdown: 'model' | 'day' = 'model';
  const container = h('div', {});
  main.append(container);

  async function draw() {
    container.innerHTML = '';
    // Scanning transcript files (spec-worthy amount of real data — see spend-tracker.ts) is not
    // instant; without this, the screen just looks broken for a few seconds on every visit.
    container.append(h('div', {class: 'empty-state'}, ['scanning provider transcripts…']));
    let summary;
    try {
      summary = await api.spendSummary(rangeDays);
    } catch (error) {
      container.innerHTML = '';
      container.append(h('div', {class: 'empty-state'}, [error instanceof Error ? error.message : String(error)]));
      return;
    }
    container.innerHTML = '';

    const rangeButtons = h('div', {class: 'segmented'});
    for (const days of [7, 30, 90]) {
      const button = h('button', {class: `btn${days === rangeDays ? ' primary' : ''}`}, [`${days}d`]);
      button.addEventListener('click', () => {
        rangeDays = days;
        void draw();
      });
      rangeButtons.append(button);
    }
    container.append(
      h('div', {class: 'toolbar'}, [
        h('div', {}, [
          h('h1', {class: 'section-title'}, [markEl(), 'spend']),
          h('p', {class: 'section-sub'}, ["cross-session token cost, scanned from each provider's own transcripts — an API-equivalent estimate, not your subscription bill"])
        ]),
        rangeButtons
      ])
    );

    if (summary.ratesError) {
      container.append(h('div', {class: 'banner advisory'}, [h('strong', {}, ['pricing table stale — ']), h('span', {}, [summary.ratesError])]));
    }

    // Per-provider aggregation across the whole range, for the left-column breakdown rows.
    const byProvider = new Map<ProviderId, {costUsd: number; tokens: number}>();
    for (const day of summary.days) {
      for (const model of day.models) {
        const entry = byProvider.get(model.provider) ?? {costUsd: 0, tokens: 0};
        entry.costUsd += model.costUsd;
        entry.tokens += sumTokenTotals(model.totals);
        byProvider.set(model.provider, entry);
      }
    }
    const activeProviders = [...byProvider.keys()].sort();

    const left = h('div', {}, [
      h('div', {class: 'spend-total'}, [formatUsd(summary.totalCostUsd)]),
      h('p', {class: 'spend-total-sub'}, [`${summary.rangeDays} days · ${formatTokens(sumTokenTotals(summary.totals))} tokens processed`])
    ]);
    if (activeProviders.length === 0) {
      left.append(h('p', {class: 'section-sub'}, ['No usage recorded in this window yet — run a session and check back.']));
    }
    for (const provider of activeProviders) {
      const totals = byProvider.get(provider)!;
      const share = summary.totalCostUsd > 0 ? totals.costUsd / summary.totalCostUsd : 0;
      left.append(
        h('div', {class: 'provider-row'}, [
          h('div', {class: 'row-top'}, [
            h('span', {class: 'row-label'}, [h('span', {class: `provider-dot ${provider}`}), h('span', {class: 'name'}, [providerLabel[provider]])]),
            h('span', {class: 'row-value'}, [formatUsd(totals.costUsd)])
          ]),
          h('span', {class: 'row-sub'}, [`${formatPercent(share)} of cost · ${formatTokens(totals.tokens)} tokens`])
        ])
      );
    }

    // Daily stacked bar chart — same shape as T3's chart, drawn with plain divs (no charting lib).
    const maxDayCost = Math.max(1e-9, ...summary.days.map(day => day.costUsd));
    const chartColumn = h('div', {});
    chartColumn.append(h('h2', {class: 'section-title'}, ['daily cost']));
    const bars = h('div', {class: 'bar-chart'});
    for (const day of summary.days) {
      const column = h('div', {class: 'bar-col'});
      for (const provider of activeProviders) {
        const model = day.models.find(m => m.provider === provider);
        const dayCost = day.models.reduce((sum, m) => sum + m.costUsd, 0);
        if (!model || dayCost <= 0) continue;
        const segmentHeightPercent = (model.costUsd / maxDayCost) * 100;
        column.append(h('div', {class: `bar-seg ${provider}`, style: `height:${segmentHeightPercent}%`}));
      }
      column.setAttribute('title', `${day.day} · ${formatUsd(day.costUsd)}`);
      bars.append(column);
    }
    chartColumn.append(bars);
    if (summary.days.length > 0) {
      chartColumn.append(h('div', {class: 'bar-chart-axis'}, [h('span', {}, [dayLabel(summary.days[0]!.day)]), h('span', {}, [dayLabel(summary.days.at(-1)!.day)])]));
    }

    container.append(h('div', {class: 'spend-grid'}, [left, chartColumn]));

    container.append(
      h('div', {class: 'card'}, [
        h('h3', {}, ['totals']),
        h('div', {class: 'metrics-grid'}, [
          metricCard('processed tokens', formatTokens(sumTokenTotals(summary.totals)), ''),
          metricCard('cached input', formatTokens(summary.totals.cachedInputTokens), ''),
          metricCard('uncached input', formatTokens(summary.totals.uncachedInputTokens), ''),
          metricCard('output', formatTokens(summary.totals.outputTokens), ''),
          metricCard('cache savings', formatUsd(summary.totalCacheSavingsUsd), '')
        ])
      ])
    );

    // Breakdown — Model (all days combined) or Day, matching T3's toggle.
    const breakdownToggle = h('div', {class: 'segmented'});
    for (const option of ['model', 'day'] as const) {
      const button = h('button', {class: `btn${breakdown === option ? ' primary' : ''}`}, [option]);
      button.addEventListener('click', () => {
        breakdown = option;
        void draw();
      });
      breakdownToggle.append(button);
    }

    const table = h('table', {class: 'spend'});
    if (breakdown === 'model') {
      const byModel = new Map<string, SpendModelBucket>();
      for (const day of summary.days) {
        for (const model of day.models) {
          const key = `${model.provider}::${model.model}`;
          const existing = byModel.get(key);
          if (existing) {
            existing.costUsd += model.costUsd;
            existing.cacheSavingsUsd += model.cacheSavingsUsd;
            existing.totals = {
              uncachedInputTokens: existing.totals.uncachedInputTokens + model.totals.uncachedInputTokens,
              cachedInputTokens: existing.totals.cachedInputTokens + model.totals.cachedInputTokens,
              cacheCreationTokens: existing.totals.cacheCreationTokens + model.totals.cacheCreationTokens,
              outputTokens: existing.totals.outputTokens + model.totals.outputTokens,
              reasoningTokens: existing.totals.reasoningTokens + model.totals.reasoningTokens
            };
          } else {
            byModel.set(key, {...model});
          }
        }
      }
      table.append(h('thead', {}, [h('tr', {}, ['model', 'tokens', 'cost', 'source'].map(label => h('th', {}, [label])))]));
      const tbody = h('tbody');
      for (const bucket of [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd)) {
        tbody.append(
          h('tr', {}, [
            h('td', {}, [`${providerLabel[bucket.provider]} · ${bucket.model}`]),
            h('td', {class: 'num'}, [formatTokens(sumTokenTotals(bucket.totals))]),
            h('td', {class: 'num'}, [formatUsd(bucket.costUsd)]),
            h('td', {class: 'num'}, [h('span', {class: 'cost-source'}, [bucket.costSource])])
          ])
        );
      }
      table.append(tbody);
    } else {
      table.append(h('thead', {}, [h('tr', {}, ['day', 'tokens', 'cost'].map(label => h('th', {}, [label])))]));
      const tbody = h('tbody');
      for (const day of [...summary.days].reverse()) {
        tbody.append(h('tr', {}, [h('td', {}, [day.day]), h('td', {class: 'num'}, [formatTokens(sumTokenTotals(day.totals))]), h('td', {class: 'num'}, [formatUsd(day.costUsd)])]));
      }
      table.append(tbody);
    }

    container.append(
      h('div', {class: 'card'}, [h('div', {class: 'toolbar'}, [h('h3', {}, ['breakdown']), breakdownToggle]), table])
    );

    // Price overrides.
    const overridesCard = h('div', {class: 'card'}, [h('h3', {}, ['price overrides']), h('p', {class: 'section-sub'}, [summary.ratesUpdatedAt ? `LiteLLM rates updated ${relativeTime(summary.ratesUpdatedAt)}` : 'LiteLLM rates not yet fetched'])]);
    const overrideEntries = Object.entries(summary.priceOverrides);
    if (overrideEntries.length === 0) {
      overridesCard.append(h('p', {class: 'section-sub'}, ['No overrides set — unpriced or wrong-priced models fall back to the LiteLLM public rate table.']));
    }
    for (const [model, override] of overrideEntries) {
      const row = h('div', {class: 'override-row'}, [
        h('span', {}, [model, ' — ', `$${override.inputCostPerMillionTokens}/M in · $${override.outputCostPerMillionTokens}/M out`]),
        h('button', {class: 'btn'}, ['remove'])
      ]);
      row.querySelector('button')!.addEventListener('click', async () => {
        await api.clearPriceOverride(model);
        void draw();
      });
      overridesCard.append(row);
    }
    const modelInput = h('input', {type: 'text', placeholder: 'model id (e.g. claude-sonnet-5)'});
    const inputRateInput = h('input', {type: 'number', placeholder: '$/M input tokens', step: '0.01'});
    const outputRateInput = h('input', {type: 'number', placeholder: '$/M output tokens', step: '0.01'});
    const saveButton = h('button', {class: 'btn primary'}, ['save']);
    saveButton.addEventListener('click', async () => {
      const model = modelInput.value.trim();
      const inputRate = Number(inputRateInput.value);
      const outputRate = Number(outputRateInput.value);
      if (!model || !Number.isFinite(inputRate) || !Number.isFinite(outputRate)) return;
      const override: PriceOverride = {inputCostPerMillionTokens: inputRate, outputCostPerMillionTokens: outputRate};
      await api.setPriceOverride(model, override);
      void draw();
    });
    overridesCard.append(h('div', {class: 'override-form'}, [modelInput, inputRateInput, outputRateInput, saveButton]));
    container.append(overridesCard);
  }

  await draw();
}

// --- Parallel orchestration --------------------------------------------------

async function renderOrchestration(main: HTMLElement) {
  const sessions = await api.listSessions();
  const project = sessions[0]?.projectDirectory ?? sessions[0]?.directory;
  const refresh = h('button', {class: 'btn'}, ['refresh']);
  refresh.addEventListener('click', () => void render());
  const stopProject = h('button', {class: 'btn'}, ['stop project agents']);
  stopProject.addEventListener('click', async () => {
    const projectSessions = sessions.filter(session => (session.projectDirectory ?? session.directory) === project && session.status === 'running');
    if (!projectSessions.length) return;
    if (!confirm(`Stop ${projectSessions.length} running agent${projectSessions.length === 1 ? '' : 's'} in this project?`)) return;
    await Promise.all(projectSessions.map(session => api.stop(session.id)));
    void render();
  });
  const addAgent = h('button', {class: 'btn primary'}, ['+ add agent']);
  const advisory = h('div', {});
  addAgent.addEventListener('click', async () => {
    const hardware = await api.hardwareSnapshot();
    const {current} = hardware;
    const memoryPercent = current.memoryTotalBytes ? (current.memoryUsedBytes / current.memoryTotalBytes) * 100 : 0;
    const pressured = memoryPercent >= 75 || current.cpuPercent >= 75;
    if (!pressured) return navigate({name: 'new-session'});
    const safeAdditional = memoryPercent >= 90 || current.cpuPercent >= 90 ? 0 : 2;
    advisory.innerHTML = '';
    const proceed = h('button', {class: 'btn'}, ['add anyway']);
    proceed.addEventListener('click', () => navigate({name: 'new-session'}));
    const cancel = h('button', {class: 'btn'}, ['cancel']);
    cancel.addEventListener('click', () => { advisory.innerHTML = ''; });
    advisory.append(h('div', {class: 'banner advisory'}, [
      h('div', {}, [
        h('strong', {}, ['▲ running low on headroom.']),
        h('p', {}, [`${bytes(current.memoryUsedBytes)} / ${bytes(current.memoryTotalBytes)} memory · ${current.cpuPercent.toFixed(0)}% CPU load`]),
        h('p', {class: 'section-sub'}, [`${safeAdditional ? `${safeAdditional} more agents is probably safe` : 'wait for current load to fall'} — ${safeAdditional ? '5 may cause slowdown.' : 'adding another agent may cause slowdown.'}`])
      ]),
      h('div', {class: 'actions'}, [proceed, cancel])
    ]));
  });
  main.append(h('div', {class: 'toolbar'}, [
    h('div', {}, [h('h1', {class: 'section-title'}, [markEl(), 'parallel orchestration']), h('p', {class: 'section-sub'}, ['shared, inspectable coordination — claims signal intent; they never lock files'])]),
    h('div', {class: 'actions'}, [refresh, stopProject, addAgent])
  ]));
  main.append(advisory);
  if (!project) {
    main.append(h('div', {class: 'empty-state'}, ['Start a session to establish a project coordination board.']));
    return;
  }
  const state = await api.coordination(project);
  const conflicts = await api.conflicts(project);
  const skills = await api.skillStatus().catch(() => []);
  const evals = await api.evalReadiness().catch(() => undefined);
  const live = sessions.filter(session => (session.projectDirectory ?? session.directory) === project && session.status === 'running');
  const taskInput = h('input', {type: 'text', placeholder: 'add a shared task'});
  const addTask = h('button', {class: 'btn primary'}, ['add task']);
  addTask.addEventListener('click', async () => {
    if (!taskInput.value.trim()) return taskInput.focus();
    await api.createTask(project, taskInput.value.trim());
    void render();
  });
  const claimInput = h('input', {type: 'text', placeholder: 'claim a file path'});
  const claimButton = h('button', {class: 'btn'}, ['claim file']);
  const claimNotice = h('p', {class: 'section-sub'}, []);
  claimButton.addEventListener('click', async () => {
    if (!claimInput.value.trim() || !live[0]) return claimInput.focus();
    const result = await api.claimFile(project, claimInput.value.trim(), live[0].id);
    // An overlap names the *existing* claim it collides with, which is not necessarily the same
    // path — claiming `src/daemon.ts` conflicts with a lane already holding `src/`.
    claimNotice.textContent = result.granted
      ? 'claim recorded'
      : result.conflicts.map(conflict => `overlap detected — ${conflict.claimedPath} is claimed by ${conflict.sessionId.slice(0, 8)}`).join(' · ');
    claimNotice.className = result.granted ? 'section-sub' : 'error';
    void render();
  });
  const decisionInput = h('input', {type: 'text', placeholder: 'record a project decision'});
  const decisionButton = h('button', {class: 'btn'}, ['record']);
  decisionButton.addEventListener('click', async () => {
    if (!decisionInput.value.trim()) return decisionInput.focus();
    await api.addDecision(project, decisionInput.value.trim(), live[0]?.id);
    void render();
  });
  const handoffInput = h('input', {type: 'text', placeholder: 'handoff summary'});
  const handoffButton = h('button', {class: 'btn'}, ['request review']);
  handoffButton.disabled = live.length < 2;
  handoffButton.addEventListener('click', async () => {
    if (!handoffInput.value.trim() || live.length < 2) return handoffInput.focus();
    await api.createHandoff(project, live[0]!.id, live[1]!.id, handoffInput.value.trim());
    void render();
  });
  main.append(h('div', {class: 'metrics-grid'}, [
    metricCard('live agent lanes', String(live.length), live.map(session => `${session.provider} · ${session.id.slice(0, 6)}`).join('  ' ) || 'none'),
    metricCard('shared tasks', String(state.tasks.length), `${state.tasks.filter(task => task.status === 'active').length} active`),
    metricCard('file claims', String(state.claims.length), 'advisory only'),
    // An explicit zero, not an absent card: "0 open conflicts" is information, a missing row is not.
    metricCard('overlaps', String(conflicts.length), conflicts.some(conflict => conflict.hotspot) ? 'includes a collision hotspot' : conflicts.length === 0 ? 'none detected' : 'none on hotspot files'),
    metricCard('handoffs', String(state.handoffs.filter(handoff => handoff.status === 'open').length), 'waiting for review')
  ]));
  const taskRows = state.tasks.map(task => {
    const next = task.status === 'todo' ? 'start' : task.status === 'active' ? 'mark done' : 'reopen';
    const nextStatus = task.status === 'todo' ? 'active' : task.status === 'active' ? 'done' : 'todo';
    const button = h('button', {class: 'btn'}, [next]);
    button.addEventListener('click', async () => { await api.updateTask(project, task.id, nextStatus, live[0]?.id); void render(); });
    return h('div', {class: 'option-row'}, [h('span', {class: 'label'}, [task.title]), h('span', {class: 'meta'}, [task.status]), button]);
  });
  const handoffRows = state.handoffs.map(handoff => {
    const accept = h('button', {class: 'btn'}, ['accept']);
    accept.disabled = handoff.status === 'accepted';
    accept.addEventListener('click', async () => { await api.acceptHandoff(project, handoff.id); void render(); });
    return h('div', {class: 'option-row'}, [h('span', {class: 'label'}, [handoff.summary]), h('span', {class: 'meta'}, [`${handoff.fromSessionId.slice(0, 6)} → ${handoff.toSessionId.slice(0, 6)} · ${handoff.status}`]), accept]);
  });
  const claimRows = state.claims.map(claim => {
    const release = h('button', {class: 'btn'}, ['release']);
    release.addEventListener('click', async () => { await api.releaseClaim(project, claim.path, claim.sessionId); void render(); });
    return h('div', {class: 'option-row'}, [h('span', {class: 'label'}, [claim.path]), h('span', {class: 'meta'}, [`${claim.sessionId.slice(0, 8)} · ${claim.origin}`]), release]);
  });
  // Overlaps read as their own card rather than as decoration on the claims list: an overlap is a
  // thing to act on now, while both lanes are still working, not a property of one claim.
  const conflictRows = conflicts.length === 0
    ? [h('p', {class: 'section-sub'}, ['0 open conflicts — no two lanes are touching the same paths.'])]
    : conflicts.map(conflict => h('div', {class: 'option-row'}, [
        h('span', {class: 'label'}, [conflict.overlap === 'same' ? conflict.path : `${conflict.path} ↔ ${conflict.claimedPath}`]),
        h('span', {class: conflict.hotspot ? 'error' : 'meta'}, [conflict.hotspot ? `hotspot · also held by ${conflict.sessionId.slice(0, 8)}` : `also held by ${conflict.sessionId.slice(0, 8)}`])
      ]));
  main.append(h('div', {class: 'cards-row'}, [
    h('div', {class: 'card'}, [h('h3', {}, ['shared task board']), ...taskRows, h('div', {class: 'field'}, [taskInput, addTask])]),
    h('div', {class: 'card'}, [h('h3', {}, ['file overlaps']), ...conflictRows]),
    h('div', {class: 'card'}, [h('h3', {}, ['file claims']), ...claimRows, h('div', {class: 'field'}, [claimInput, claimButton, claimNotice])]),
    h('div', {class: 'card'}, [h('h3', {}, ['project memory']), ...state.decisions.map(decision => h('p', {class: 'section-sub'}, [decision.summary || 'no decisions yet'])), h('div', {class: 'field'}, [decisionInput, decisionButton])]),
    h('div', {class: 'card'}, [h('h3', {}, ['handoffs & review']), ...handoffRows, h('div', {class: 'field'}, [handoffInput, handoffButton])])
  ]));

  // Lanes talking to each other is coordination, so it is shown like every other kind: visible by
  // default, never something happening out of sight (spec §2 principle 3).
  const messageRows = state.messages.length === 0
    ? [h('p', {class: 'section-sub'}, ['No messages between lanes yet — an agent sends one with `fluent-coord send`.'])]
    : [...state.messages].reverse().slice(0, 12).map(message => h('div', {class: 'option-row'}, [
        h('span', {class: 'label'}, [message.body]),
        h('span', {class: 'meta'}, [`${message.from.slice(0, 8)} → ${message.to.slice(0, 8)} · ${message.readAt ? 'read' : 'unread'}`])
      ]));

  const missingSkill = skills.filter(skill => !skill.current);
  const installButton = h('button', {class: 'btn primary'}, [skills.some(skill => skill.installed) ? 'update collaboration skill' : 'install collaboration skill']);
  const installNotice = h('p', {class: 'section-sub'}, [
    missingSkill.length === 0
      ? 'Every provider has the current fluent-collab skill — new lanes know how to coordinate.'
      : `${missingSkill.map(skill => skill.provider).join(' and ')} ${missingSkill.length === 1 ? 'does' : 'do'} not have the current skill. Installing writes it to each provider's own skills directory; it never touches this repository.`
  ]);
  installButton.addEventListener('click', async () => {
    installButton.disabled = true;
    try {
      await api.installSkill();
      void render();
    } finally {
      installButton.disabled = false;
    }
  });

  // Tests prove `fluent-coord` works. Only an eval can show whether an agent actually *uses* it —
  // a skill is a prompt, and a prompt's effect is measured, not asserted.
  const evalRun = evals?.run;
  // A subscription is spent in quota and an API key in dollars, so the consent question has to be
  // asked in whichever one this credential actually uses — a "$2 ceiling" means nothing on a
  // subscription, where the ceiling never trips.
  const spendsDollars = evals?.mode === 'platform-credits' || evals?.mode === 'api-key';
  const runCount = evals?.plan.totalRuns ?? 0;
  const quotaNote = evals?.quotaUsedPercent === undefined
    ? ''
    : ` Your subscription's current window is at ${Math.round(evals.quotaUsedPercent)}%.`;
  const costSentence = spendsDollars
    ? `${runCount} real agent runs on ${evals?.accountLabel ?? 'this credential'}, stopping at a $2 ceiling.`
    : `${runCount} real agent runs against ${evals?.accountLabel ? `${evals.accountLabel}'s` : 'your subscription'} quota — not billed in dollars, so the cost ceiling will not stop it.${quotaNote}`;
  const evalRows = evalRun
    ? evalRun.cases.map(result => h('div', {class: 'option-row'}, [
        h('span', {class: 'label'}, [result.name]),
        h('span', {class: result.score >= evalRun.threshold ? 'meta' : 'error'}, [
          `${Math.round(result.score * 100)}% · ${result.runs} runs${result.delta === undefined ? '' : ` · Δ ${result.delta >= 0 ? '+' : ''}${Math.round(result.delta * 100)}`}`
        ])
      ]))
    : [h('p', {class: 'section-sub'}, ['No eval run yet. Evals measure whether agents actually use the coordination surface — the tests cannot tell you that.'])];

  const evalSummary = h('p', {class: 'section-sub'}, [
    evalRun
      ? `${evalRun.casesPassed}/${evalRun.casesTotal} cases passed · ${Math.round(evalRun.overallScore * 100)}% overall · $${evalRun.costUsd.toFixed(2)} · ${relativeTime(evalRun.startedAt)}${evalRun.partial ? ' · partial run' : ''}${evalRun.ablation === 'with-without' ? ' · Δ is the skill\'s contribution' : ''}`
      : 'Each case runs with and without the skill, so the score separates the skill from the model.'
  ]);
  const evalButton = h('button', {class: 'btn'}, [evals?.running ? 'eval running…' : 'run evals']);
  evalButton.disabled = evals?.running ?? true;
  const evalNotice = h('p', {class: 'section-sub'}, [
    evalRun?.reportPath ? `Report: ${evalRun.reportPath}` : `Runs locally on ${evals?.accountLabel ?? 'your active credential'} — nothing is published. ${costSentence}`
  ]);
  evalButton.addEventListener('click', async () => {
    // Real agent runs on the active credential, so it is never started without being asked for —
    // in the currency that credential is actually spent in.
    if (!confirm(`Run the eval suite? ${costSentence}`)) return;
    evalButton.disabled = true;
    evalButton.textContent = 'eval running…';
    try {
      await api.runEvals(2);
    } catch (error) {
      evalNotice.textContent = error instanceof Error ? error.message : String(error);
      evalNotice.className = 'error';
    } finally {
      void render();
    }
  });

  main.append(h('div', {class: 'cards-row'}, [
    h('div', {class: 'card'}, [h('h3', {}, ['lane messages']), ...messageRows]),
    h('div', {class: 'card'}, [h('h3', {}, ['collaboration skill']), installNotice, h('div', {class: 'field'}, [installButton])]),
    h('div', {class: 'card'}, [h('h3', {}, ['eval suite']), evalSummary, ...evalRows, evalNotice, h('div', {class: 'field'}, [evalButton])])
  ]));
}

// --- Design workspace & visual check ----------------------------------------

async function renderDesignWorkspace(main: HTMLElement) {
  const sessions = await api.listSessions();
  const project = sessions[0]?.projectDirectory ?? sessions[0]?.directory;
  const [openDesign, openDesignStatus] = await Promise.all([
    api.openDesign().catch(() => ({url: 'http://127.0.0.1:7456'})),
    api.openDesignStatus().catch(() => ({url: 'http://127.0.0.1:7456', reachable: false, status: undefined, error: 'fluentd could not check OpenDesign'}))
  ]);
  const designTools = await api.listDesignTools().catch(() => []);
  main.append(
    h('div', {class: 'toolbar'}, [
      h('div', {}, [h('h1', {class: 'section-title'}, [markEl(), 'design workspace']), h('p', {class: 'section-sub'}, ['OpenDesign is optional and local; Fluent keeps its design-to-build handoff tied to this repository.'])]),
      navButton('open preview', 'preview')
    ])
  );
  const endpoint = h('input', {type: 'url', value: openDesign.url, placeholder: 'http://127.0.0.1:7456'});
  const endpointStatus = h('p', {class: openDesignStatus.reachable ? 'success' : 'section-sub'}, [
    openDesignStatus.reachable ? `OpenDesign connected · HTTP ${openDesignStatus.status ?? 'ok'}` : `OpenDesign is not running at this URL${openDesignStatus.error ? ` · ${openDesignStatus.error}` : ''}`
  ]);
  const connect = h('button', {class: 'btn primary'}, ['connect OpenDesign']);
  connect.addEventListener('click', async () => {
    try { await api.saveOpenDesign(endpoint.value); void render(); }
    catch (error: unknown) { endpointStatus.textContent = error instanceof Error ? error.message : 'Could not save OpenDesign URL'; endpointStatus.className = 'error'; }
  });
  main.append(h('div', {class: 'card'}, [
    h('h3', {}, ['OpenDesign connector']),
    endpointStatus,
    h('div', {class: 'field'}, [endpoint, connect]),
    h('p', {class: 'section-sub'}, ['Local loopback only. OpenDesign keeps control of its agents and credentials; Fluent does not proxy design traffic.'])
  ]));
  const toolRows = designTools.map(tool => {
    const status = tool.installed ? `connected CLI${tool.version ? ` · ${tool.version}` : ''}` : 'not installed';
    const row = h('div', {class: 'option-row'}, [
      h('span', {class: tool.installed ? 'label' : 'meta'}, [`● ${tool.label}`]),
      h('span', {class: 'meta'}, [status]),
      h('span', {class: 'section-sub'}, [tool.detail])
    ]);
    if (tool.id === 'open-design' && tool.installed) {
      for (const target of ['claude', 'codex'] as const) {
        const install = h('button', {class: 'btn'}, [`install MCP for ${target}`]);
        install.addEventListener('click', async () => {
          if (!confirm(`OpenDesign will update ${target}'s MCP configuration. Continue?`)) return;
          try { const result = await api.installOpenDesignMcp(target); row.append(h('p', {class: 'success'}, [result.output])); }
          catch (error: unknown) { row.append(h('p', {class: 'error'}, [error instanceof Error ? error.message : 'MCP install failed'])); }
        });
        row.append(install);
      }
    }
    return row;
  });
  main.append(h('div', {class: 'card'}, [
    h('h3', {}, ['design CLI & MCP bridge']),
    ...toolRows,
    h('p', {class: 'section-sub'}, ['MCP setup is explicit: Fluent never alters agent configuration until you confirm an install. pen.dev’s desktop app owns its local MCP toggle; OpenDesign provides the CLI installer.'])
  ]));
  if (openDesignStatus.reachable) {
    main.append(h('div', {class: 'card'}, [
      h('div', {class: 'toolbar'}, [h('div', {}, [h('h3', {}, ['OpenDesign']), h('p', {class: 'section-sub'}, ['Edit in place, then create a repository-bound implementation handoff below.'])])]),
      h('iframe', {class: 'preview-frame', title: 'OpenDesign', src: openDesign.url})
    ]));
  }
  if (!project) {
    main.append(h('div', {class: 'empty-state'}, ['Start a session to bind design work and implementation handoffs to a repository.']));
    return;
  }
  const state = await api.coordination(project);
  const title = h('input', {type: 'text', placeholder: 'design task, e.g. credential fallback states'});
  const add = h('button', {class: 'btn primary'}, ['create design task']);
  add.addEventListener('click', async () => {
    if (!title.value.trim()) return title.focus();
    await api.createTask(project, `design: ${title.value.trim()}`);
    void render();
  });
  main.append(h('div', {class: 'cards-row'}, [
    h('div', {class: 'card'}, [
      h('h3', {}, ['design tasks']),
      ...state.tasks.filter(task => task.title.startsWith('design:')).map(task => h('p', {}, [`● ${task.title.slice(8)}  ·  ${task.status}`])),
      h('div', {class: 'field'}, [title, add])
    ]),
    h('div', {class: 'card'}, [
      h('h3', {}, ['handoff contract']),
      h('p', {class: 'section-sub'}, ['Every task can carry token decisions, claimed implementation files, a preview URL, and an explicit reviewer handoff.']),
      h('p', {class: 'section-sub'}, [`${state.claims.length} claimed files · ${state.handoffs.filter(handoff => handoff.status === 'open').length} reviews open`])
    ]),
    h('div', {class: 'card'}, [
      h('h3', {}, ['source of truth']),
      h('p', {class: 'section-sub'}, ['Fluent design source: design/pen/fluent-code.pen']),
      h('p', {class: 'section-sub'}, [openDesignStatus.reachable ? 'OpenDesign is connected for design work; use Preview to inspect the running local app.' : 'Use Preview to inspect the running local app without leaving Fluent.'])
    ])
  ]));
}

async function renderPreview(main: HTMLElement) {
  const stored = localStorage.getItem('fluent.preview-url') ?? 'http://localhost:3000';
  const urlInput = h('input', {type: 'url', value: stored, placeholder: 'http://localhost:3000'});
  const open = h('button', {class: 'btn primary'}, ['open preview']);
  const status = h('p', {class: 'section-sub'}, ['local URLs only — Fluent never proxies preview traffic']);
  const frame = h('iframe', {class: 'preview-frame', title: 'local preview', src: stored});
  open.addEventListener('click', () => {
    const value = urlInput.value.trim();
    if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/.test(value)) {
      status.textContent = 'for safety, preview accepts a local http(s) URL only.';
      status.className = 'error';
      return;
    }
    localStorage.setItem('fluent.preview-url', value);
    frame.src = value;
    status.textContent = `previewing ${value}`;
    status.className = 'section-sub';
  });
  const inspect = h('button', {class: 'btn'}, ['create visual-check task']);
  inspect.addEventListener('click', () => navigate({name: 'design'}));
  main.append(
    h('div', {class: 'toolbar'}, [
      h('div', {}, [h('h1', {class: 'section-title'}, [markEl(), 'preview & visual check']), status]),
      inspect
    ]),
    h('div', {class: 'field preview-controls'}, [urlInput, open]),
    frame
  );
}

async function renderRemote(main: HTMLElement) {
  const profiles = await api.listRemotes();
  const selectedSocket = activeRemoteSocket();
  const name = h('input', {type: 'text', placeholder: 'server name'});
  const host = h('input', {type: 'text', placeholder: 'user@host'});
  const add = h('button', {class: 'btn primary'}, ['add SSH server']);
  add.addEventListener('click', async () => {
    if (!name.value.trim() || !host.value.trim()) return host.focus();
    await api.saveRemote({name: name.value.trim(), host: host.value.trim()});
    void render();
  });
  main.append(
    h('h1', {class: 'section-title'}, [markEl(), 'remote servers']),
    h('p', {class: 'section-sub'}, ['connects through SSH Unix-socket forwarding; Fluent never exposes a daemon port publicly.']),
    h('div', {class: 'field'}, [name, host, add])
  );
  for (const profile of profiles) {
    const action = h('button', {class: profile.status === 'connected' ? 'btn' : 'btn primary'}, [profile.status === 'connected' ? 'disconnect' : 'connect']);
    action.addEventListener('click', async () => {
      if (profile.status === 'connected') {
        await api.disconnectRemote(profile.id);
        if (selectedSocket === profile.localSocket) selectRemoteSocket();
      } else {
        await api.connectRemote(profile.id);
        // SSH forwarding proves remote fluentd is reachable asynchronously. Once it is
        // connected, "use this server" becomes available without guessing at a target.
        setTimeout(() => void render(), 1200);
      }
      void render();
    });
    const useHere = h('button', {class: `btn${selectedSocket === profile.localSocket ? ' primary' : ''}`}, [selectedSocket === profile.localSocket ? 'using this server' : 'use this server']);
    useHere.disabled = profile.status !== 'connected';
    useHere.addEventListener('click', () => { selectRemoteSocket(profile.localSocket); void render(); });
    main.append(h('div', {class: 'option-row'}, [
      h('span', {class: 'label'}, [profile.name]),
      h('span', {class: 'meta'}, [profile.host + ' · ' + profile.status + (profile.error ? ' · ' + profile.error : '')]),
      useHere,
      action
    ]));
  }
  if (selectedSocket) {
    try {
      const [hardware, software] = await Promise.all([api.hardwareSnapshot(), api.softwareSnapshot()]);
      const memory = `${bytes(hardware.current.memoryUsedBytes)} / ${bytes(hardware.current.memoryTotalBytes)}`;
      main.append(h('div', {class: 'cards-row'}, [
        h('div', {class: 'card'}, [
          h('h3', {}, ['active remote hardware']),
          h('p', {class: 'trace cpu'}, [`cpu     ${sparkline(hardware.history, 'cpuPercent')}`]),
          h('p', {class: 'trace memory'}, [`memory  ${sparkline(hardware.history, 'memoryUsedBytes')}`]),
          h('p', {class: 'section-sub'}, [`${hardware.current.cpuPercent.toFixed(1)}% fluentd CPU · ${memory} memory · uptime ${duration(hardware.current.uptimeSeconds)}`])
        ]),
        h('div', {class: 'card'}, [
          h('h3', {}, ['active remote software']),
          h('p', {class: 'section-sub'}, [`${software.hostname} · ${software.kernel} · Node ${software.nodeVersion}`]),
          ...software.providers.map(provider => h('p', {class: 'section-sub'}, [`${provider.label}  ${provider.installed ? provider.version || 'installed' : 'not installed'}`]))
        ])
      ]));
    } catch (error) {
      main.append(h('p', {class: 'error'}, [`remote observability unavailable: ${error instanceof Error ? error.message : String(error)}`]));
    }
  }
}

// --- Themes & appearance -----------------------------------------------------

async function renderThemes(main: HTMLElement) {
  const currentMode = resolvedMode();
  const darkThemes = ['Fluent Dark', 'Midnight', 'Ember', 'Nord Dark', 'High Contrast Dark'];
  const lightThemes = ['Fluent Light', 'Paper', 'Nord Light', 'High Contrast Light'];
  const options: Array<{id: Appearance; label: string}> = [{id: 'system', label: 'system'}, {id: 'light', label: 'light'}, {id: 'dark', label: 'dark'}];
  const appearanceRow = h('div', {class: 'segmented'});
  for (const option of options) {
    const button = h('button', {class: `btn${appearance === option.id ? ' primary' : ''}`}, [option.label]);
    button.addEventListener('click', () => {
      appearance = option.id;
      localStorage.setItem(appearanceKey, appearance);
      applyAppearance();
      void render();
    });
    appearanceRow.append(button);
  }
  const names = currentMode === 'dark' ? darkThemes : lightThemes;
  const themeCards = h('div', {class: 'cards-row'});
  for (const name of names) {
    const card = h('div', {class: `card selectable${bundles[currentMode] === name ? ' selected' : ''}`}, [
      h('h3', {}, [name]),
      h('p', {class: 'subtitle'}, ['semantic palette · ANSI · syntax · density'])
    ]);
    card.addEventListener('click', () => {
      bundles = {...bundles, [currentMode]: name};
      localStorage.setItem(bundleKey, JSON.stringify(bundles));
      applyAppearance();
      void render();
    });
    themeCards.append(card);
  }
  main.append(
    h('h1', {class: 'section-title'}, [markEl(), 'themes & appearance']),
    h('p', {class: 'section-sub'}, ['appearance mode is separate from each mode’s saved theme bundle. Light and dark themes never mix.']),
    h('label', {class: 'field-label'}, ['appearance mode']),
    appearanceRow,
    h('p', {class: 'section-sub'}, [appearance === 'system' ? `system currently resolves to ${currentMode}; dark → ${bundles.dark}, light → ${bundles.light}` : `${currentMode} themes`]),
    themeCards,
    h('div', {class: 'card'}, [h('h3', {}, ['terminal preview']), h('pre', {class: 'theme-preview'}, ['› pnpm check\n✓ typecheck passed\nconst agent = await run()'])])
  );
}

function navButton(label: string, name: Route['name']): HTMLButtonElement {
  const button = h('button', {}, [label]);
  if (route.name === name) button.classList.add('active');
  button.addEventListener('click', () => navigate({name} as Route));
  return button;
}

function markEl(): HTMLElement {
  return h('span', {class: 'mark'}, [h('span'), h('span'), h('span'), h('span')]);
}

// --- Splash ---------------------------------------------------------------

async function renderSplash(main: HTMLElement) {
  const container = h('div', {class: 'splash'});
  main.append(container);

  let ping: {ok: boolean; pid: number};
  try {
    ping = await api.ping();
  } catch (error) {
    container.append(
      h('div', {class: 'wordmark'}, [markEl(), 'fluent code']),
      h('p', {class: 'error'}, [error instanceof Error ? error.message : String(error)]),
      retryButton(() => void render())
    );
    return;
  }

  const chains = await api.listCredentials().catch(() => [] as CredentialChainState[]);
  const providers: Array<{id: ProviderId; label: string}> = [
    {id: 'claude', label: 'anthropic claude'},
    {id: 'codex', label: 'openai codex'}
  ];

  container.append(
    h('div', {class: 'wordmark'}, [markEl(), 'fluent code']),
    h('p', {class: 'version'}, [`fluentd connected · pid ${ping.pid}`]),
    h('div', {class: 'providers'}, providers.map(provider => {
      const chain = chains.find(c => c.provider === provider.id);
      const connected = Boolean(chain?.activeAccountId);
      return h('span', {class: 'badge'}, [h('span', {class: `dot${connected ? ' on' : ''}`}), provider.label]);
    })),
    h('p', {class: 'prompt'}, ['press ', h('kbd', {}, ['enter']), ' to continue'])
  );

  const hasClaudeAccount = Boolean(chains.find(c => c.provider === 'claude')?.accounts.length);
  const advance = () => navigate(hasClaudeAccount ? {name: 'sessions'} : {name: 'onboarding'});
  container.addEventListener('click', advance);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      document.removeEventListener('keydown', onKey);
      advance();
    }
  };
  document.addEventListener('keydown', onKey);
}

function replaceMain(main: HTMLElement): HTMLElement {
  main.innerHTML = '';
  return main;
}

function retryButton(onClick: () => void): HTMLButtonElement {
  const button = h('button', {class: 'btn primary'}, ['retry']);
  button.addEventListener('click', onClick);
  return button;
}

// --- Onboarding ------------------------------------------------------------

async function renderOnboarding(main: HTMLElement) {
  main.append(
    h('h1', {class: 'section-title'}, [markEl(), 'connect a provider']),
    h('p', {class: 'section-sub'}, ['choose an authentication method to get started'])
  );

  const cards = h('div', {class: 'cards-row'});
  main.append(cards);

  // Provider CLIs retain their own login flows; Fluent launches each one unchanged and supplies
  // an explicitly selected secure API-key credential only when the user has configured it.
  const dirInput = h('input', {type: 'text', placeholder: '/path/to/project'});
  const loginButton = h('button', {class: 'btn primary'}, ['connect via CLI login']);
  loginButton.addEventListener('click', async () => {
    const directory = dirInput.value.trim();
    if (!directory) return dirInput.focus();
    const summary = await api.createSession({provider: 'claude', directory});
    navigate({name: 'active-session', sessionId: summary.id});
  });

  const keyLabel = h('input', {type: 'text', placeholder: 'label (e.g. personal)'});
  const keyInput = h('input', {type: 'password', placeholder: 'sk-ant-...'});
  const keyStatus = h('p', {class: 'section-sub'}, []);
  const keyButton = h('button', {class: 'btn'}, ['save API key']);
  keyButton.addEventListener('click', async () => {
    const apiKey = keyInput.value.trim();
    if (!apiKey) return keyInput.focus();
    await api.upsertAccount({
      provider: 'claude',
      id: crypto.randomUUID(),
      mode: 'api-key',
      label: keyLabel.value.trim() || 'API key',
      apiKey
    });
    keyStatus.textContent = 'saved — manage precedence in Credentials';
    keyInput.value = '';
  });
  const routerLabel = h('input', {type: 'text', placeholder: 'label (e.g. team router)'});
  const routerKey = h('input', {type: 'password', placeholder: 'sk-or-...'});
  const routerStatus = h('p', {class: 'section-sub'}, []);
  const routerButton = h('button', {class: 'btn'}, ['save OpenRouter key']);
  routerButton.addEventListener('click', async () => {
    const apiKey = routerKey.value.trim();
    if (!apiKey) return routerKey.focus();
    await api.upsertAccount({
      provider: 'claude',
      id: crypto.randomUUID(),
      mode: 'api-key',
      label: routerLabel.value.trim() || 'OpenRouter',
      apiKey,
      baseUrl: 'https://openrouter.ai/api'
    });
    routerStatus.textContent = 'saved securely — select OpenRouter in the Claude Code account chain';
    routerKey.value = '';
  });
  const codexKeyLabel = h('input', {type: 'text', placeholder: 'label (e.g. OpenAI work)'});
  const codexKey = h('input', {type: 'password', placeholder: 'sk-...'});
  const codexStatus = h('p', {class: 'section-sub'}, []);
  const codexKeyButton = h('button', {class: 'btn'}, ['save Codex API key']);
  codexKeyButton.addEventListener('click', async () => {
    const apiKey = codexKey.value.trim();
    if (!apiKey) return codexKey.focus();
    await api.upsertAccount({
      provider: 'codex',
      id: crypto.randomUUID(),
      mode: 'api-key',
      label: codexKeyLabel.value.trim() || 'OpenAI API key',
      apiKey
    });
    codexStatus.textContent = 'saved securely — select it when starting a Codex session';
    codexKey.value = '';
  });
  const codexLogin = h('button', {class: 'btn primary'}, ['connect via Codex login']);
  codexLogin.addEventListener('click', async () => {
    const directory = dirInput.value.trim();
    if (!directory) return dirInput.focus();
    const summary = await api.createSession({provider: 'codex', directory});
    navigate({name: 'active-session', sessionId: summary.id});
  });

  cards.append(
    h('div', {class: 'card'}, [
      h('h3', {}, ['Claude Code']),
      h('p', {class: 'subtitle'}, ['Anthropic']),
      h('div', {class: 'field'}, [h('label', {class: 'field-label'}, ['CLI login — working directory']), dirInput, loginButton]),
      h('div', {class: 'field'}, [
        h('label', {class: 'field-label'}, ['or use an API key']),
        keyLabel,
        keyInput,
        keyButton,
        keyStatus
      ])
    ]),
    h('div', {class: 'card'}, [
      h('h3', {}, ['Codex']),
      h('p', {class: 'subtitle'}, ['OpenAI · subscription login or API key']),
      h('div', {class: 'field'}, [h('label', {class: 'field-label'}, ['CLI login — same working directory']), codexLogin]),
      h('div', {class: 'field'}, [codexKeyLabel, codexKey, codexKeyButton, codexStatus])
    ]),
    h('div', {class: 'card'}, [
      h('h3', {}, ['OpenRouter']),
      h('p', {class: 'subtitle'}, ['Claude Code compatibility preset · API key']),
      h('div', {class: 'field'}, [
        routerLabel,
        routerKey,
        routerButton,
        routerStatus
      ])
    ])
  );

  const skip = h('button', {class: 'btn'}, ['skip for now']);
  skip.addEventListener('click', () => navigate({name: 'sessions'}));
  main.append(h('div', {class: 'toolbar'}, [h('span', {}, []), skip]));
}

// --- Session list ------------------------------------------------------------

async function renderSessions(main: HTMLElement) {
  const [sessions, chains] = await Promise.all([api.listSessions(), api.listCredentials()]);

  const newSessionButton = h('button', {class: 'btn primary'}, ['+ new session']);
  newSessionButton.addEventListener('click', () => navigate({name: 'new-session'}));
  main.append(
    h('div', {class: 'toolbar'}, [h('h1', {class: 'section-title'}, [markEl(), 'sessions']), newSessionButton])
  );

  if (sessions.length === 0) {
    main.append(h('div', {class: 'empty-state'}, ['No sessions yet — start one with "+ new session".']));
    return;
  }

  const table = h('table', {class: 'sessions'});
  table.append(
    h('thead', {}, [h('tr', {}, ['session', 'provider', 'account', 'status', 'checks', 'checkout', 'ready in', 'last active'].map(label => h('th', {}, [label])))])
  );
  const tbody = h('tbody');
  for (const session of sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const name = session.task?.trim() || session.directory.split('/').filter(Boolean).pop() || session.directory;
    const row = h('tr', {}, [
      h('td', {}, [name]),
      h('td', {}, [session.provider]),
      h('td', {}, [accountLabel(session.accountId, chains)]),
      h('td', {}, [h('span', {class: `pill status-${session.status}`}, [session.status])]),
      h('td', {}, [verificationPill(session.verification)]),
      h('td', {}, [session.worktreePath ? 'isolated' : 'shared']),
      h('td', {}, [laneReady(session)]),
      h('td', {}, [relativeTime(session.updatedAt)])
    ]);
    row.addEventListener('click', () => navigate({name: 'active-session', sessionId: session.id}));
    tbody.append(row);
  }
  table.append(tbody);
  main.append(table);
}

// --- New session ------------------------------------------------------------

async function renderNewSession(main: HTMLElement) {
  main.append(
    h('h1', {class: 'section-title'}, [markEl(), 'new session']),
    h('p', {class: 'section-sub'}, ['pick a provider and an account, then point it at a working directory'])
  );

  const [chains, providers] = await Promise.all([api.listCredentials(), api.listProviders()]);
  let selectedProvider: ProviderId = providers.find(provider => provider.id === 'claude' && provider.installed)?.id
    ?? providers.find(provider => provider.installed)?.id
    ?? 'claude';

  main.append(h('label', {class: 'field-label'}, ['provider']));
  const providerCards = h('div', {class: 'cards-row'});
  main.append(providerCards);

  main.append(h('label', {class: 'field-label'}, ['account']));
  let selectedAccountId: string | undefined;
  const accountsContainer = h('div', {});
  const renderAccounts = () => {
    const chain = chains.find(candidate => candidate.provider === selectedProvider);
    selectedAccountId = chain?.activeAccountId ?? chain?.chain[0];
    accountsContainer.innerHTML = '';
    if (!chain?.accounts.length) {
      accountsContainer.append(h('p', {class: 'section-sub'}, ['No Fluent account connected — the provider CLI can still use its own subscription login.']));
      return;
    }
    for (const account of chain.accounts) {
      const row = h('div', {class: `option-row${account.id === selectedAccountId ? ' selected' : ''}`}, [
        h('span', {class: 'label'}, [account.label]),
        h('span', {class: 'meta'}, [`${account.mode}${account.hasSecret ? ' · secure' : ''}`])
      ]);
      row.addEventListener('click', () => {
        selectedAccountId = account.id;
        for (const sibling of accountsContainer.children) sibling.classList.remove('selected');
        row.classList.add('selected');
      });
      accountsContainer.append(row);
    }
  };
  for (const provider of providers) {
    const card = h('div', {class: `card ${provider.installed ? 'selectable' : 'disabled'}${provider.id === selectedProvider ? ' selected' : ''}`}, [
      h('h3', {}, [provider.label]),
      h('p', {class: 'subtitle'}, [provider.installed ? provider.version || provider.executable || 'installed' : 'not installed'])
    ]);
    if (provider.installed) card.addEventListener('click', () => {
      selectedProvider = provider.id;
      for (const sibling of providerCards.children) sibling.classList.remove('selected');
      card.classList.add('selected');
      renderAccounts();
      void renderHeadroom();
    });
    providerCards.append(card);
  }
  providerCards.append(h('div', {class: 'card disabled'}, [h('h3', {}, ['+ provider']), h('p', {class: 'subtitle'}, ['adapter extension point'])]));
  renderAccounts();
  main.append(accountsContainer);

  const dirInput = h('input', {type: 'text', placeholder: '/path/to/project'});
  const taskInput = h('textarea', {placeholder: 'what should this session start with? (optional)'});
  const isolateInput = h('input', {type: 'checkbox'}) as HTMLInputElement;
  const isolateLabel = h('label', {class: 'check-label'}, [isolateInput, ' run in an isolated Git worktree']);
  main.append(
    h('div', {class: 'field'}, [h('label', {class: 'field-label'}, ['working directory']), dirInput]),
    h('div', {class: 'field'}, [h('label', {class: 'field-label'}, ['starting task (optional)']), taskInput, isolateLabel, h('p', {class: 'section-sub'}, ['recommended for parallel agents — creates a separate checkout beside the project'])])
  );

  // Headroom is shown where the decision is made, and it never blocks the button: the advice is
  // Fluent's, the call is the user's (spec §2 principle 4, §13).
  const headroom = h('div', {class: 'field'});
  main.append(headroom);
  const renderHeadroom = async () => {
    headroom.innerHTML = '';
    try {
      const verdict = await api.assessAdmission(selectedProvider, selectedAccountId);
      headroom.append(
        h('div', {class: 'option-row'}, [
          h('span', {class: 'label'}, [admissionLabel(verdict)]),
          h('span', {class: verdict.decision === 'over' ? 'error' : 'meta'}, [`${verdict.runningLanes} running · ${verdict.estimateSource === 'observed' ? 'measured here' : 'estimated'}`])
        ]),
        ...verdict.reasons.map(reason => h('p', {class: 'section-sub'}, [reason]))
      );
    } catch {
      // Headroom advice is never the reason a session cannot be started.
    }
  };
  void renderHeadroom();

  const startButton = h('button', {class: 'btn primary'}, ['start session']);
  startButton.addEventListener('click', async () => {
    const directory = dirInput.value.trim();
    if (!directory) return dirInput.focus();
    const summary = await api.createSession({provider: selectedProvider, directory, task: taskInput.value.trim() || undefined, accountId: selectedAccountId, isolate: isolateInput.checked});
    navigate({name: 'active-session', sessionId: summary.id});
  });
  const cancelButton = h('button', {class: 'btn'}, ['cancel']);
  cancelButton.addEventListener('click', () => navigate({name: 'sessions'}));
  main.append(h('div', {class: 'toolbar'}, [h('span', {}, []), h('div', {}, [cancelButton, startButton])]));
}

// --- Active session ------------------------------------------------------------

async function renderActiveSession(main: HTMLElement, sessionId: string) {
  const chains = await api.listCredentials();
  const header = h('div', {class: 'session-header'});
  const banner = h('div', {});
  const review = h('div', {class: 'review-panel'});
  const terminalContainer = h('div', {id: 'terminal'});
  main.append(header, banner, review, terminalContainer);

  const terminal = new Terminal({
    convertEol: true,
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
    fontSize: terminalFontSize(),
    theme: terminalTheme()
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalContainer);
  fitAddon.fit();
  // The daemon spawns the PTY at a fixed default size (session-manager.ts) before the frontend
  // has ever mounted a terminal to fit against — sync the real size now, or the CLI keeps
  // drawing (and wrapping) for a grid that doesn't match what's rendered.
  void api.resize(sessionId, terminal.cols, terminal.rows).catch(() => undefined);
  const onWindowResize = () => {
    fitAddon.fit();
    void api.resize(sessionId, terminal.cols, terminal.rows).catch(() => undefined);
  };
  window.addEventListener('resize', onWindowResize);

  terminal.onData(data => {
    void api.send(sessionId, data).catch(() => undefined);
  });

  function renderHeader(summary: SessionSummary) {
    header.innerHTML = '';
    const stopButton = h('button', {class: 'btn'}, ['stop session']);
    stopButton.disabled = summary.status !== 'running';
    stopButton.addEventListener('click', async () => {
      await api.stop(sessionId);
    });
    const removeWorktree = h('button', {class: 'btn'}, ['remove worktree']);
    removeWorktree.disabled = !summary.worktreePath || summary.status === 'running' || summary.status === 'starting';
    removeWorktree.addEventListener('click', async () => {
      if (!confirm('Remove this stopped agent worktree? Uncommitted changes in it will be discarded.')) return;
      await api.removeWorktree(sessionId);
      void render();
    });
    const reviewChanges = h('button', {class: 'btn'}, ['review changes']);
    reviewChanges.addEventListener('click', async () => {
      review.innerHTML = '';
      try {
        const diff = await api.sessionDiff(sessionId);
        review.append(h('div', {class: 'card'}, [
          h('div', {class: 'toolbar'}, [h('div', {}, [h('h3', {}, ['Git change review']), h('p', {class: 'section-sub'}, [diff.status])]), h('button', {class: 'btn'}, ['close'])]),
          diff.patch ? h('pre', {class: 'diff'}, [diff.patch + (diff.truncated ? '\n\n… diff truncated' : '')]) : h('p', {class: 'section-sub'}, ['No tracked-file diff. Untracked files, if any, are listed above.'])
        ]));
        (review.querySelector('button') as HTMLButtonElement | null)?.addEventListener('click', () => { review.innerHTML = ''; });
      } catch (error) {
        review.append(h('p', {class: 'error'}, [error instanceof Error ? error.message : String(error)]));
      }
    });
    // Merging writes to the user's own checkout, so it is two deliberate steps: see exactly what
    // would happen, then say yes. Nothing here resolves a conflict or rewrites history.
    const mergeLane = h('button', {class: 'btn'}, ['merge lane']);
    mergeLane.disabled = !summary.worktreePath;
    mergeLane.addEventListener('click', async () => {
      review.innerHTML = '';
      mergeLane.disabled = true;
      try {
        showMergePlan(await api.mergePlan(sessionId));
      } catch (error) {
        review.append(h('p', {class: 'error'}, [error instanceof Error ? error.message : String(error)]));
      } finally {
        mergeLane.disabled = !summary.worktreePath;
      }
    });
    const runChecks = h('button', {class: 'btn'}, ['run checks']);
    runChecks.addEventListener('click', async () => {
      review.innerHTML = '';
      runChecks.disabled = true;
      try {
        showVerification(await api.verifySession(sessionId));
      } catch (error) {
        review.append(h('p', {class: 'error'}, [error instanceof Error ? error.message : String(error)]));
      } finally {
        runChecks.disabled = false;
      }
    });
    header.append(
      h('div', {class: 'meta'}, [
        h('span', {class: 'pill status-default'}, [summary.provider]),
        h('span', {class: 'pill'}, [accountLabel(summary.accountId, chains)]),
        h('span', {class: `pill status-${summary.status}`}, [summary.status]),
        verificationPill(summary.verification),
        h('span', {class: 'dir'}, [summary.worktreePath ? `isolated · ${summary.directory}` : summary.directory])
      ]),
      h('div', {class: 'actions'}, [mergeLane, runChecks, reviewChanges, removeWorktree, stopButton])
    );
  }

  /** The plan before the merge: which branch, how many commits, what git predicts would conflict,
   * and anything standing in the way — stated before anything is touched, not after. */
  function showMergePlan(plan: MergePlan) {
    review.innerHTML = '';
    const blocked = plan.blockers.length > 0 || plan.conflicts.length > 0;
    const close = h('button', {class: 'btn'}, ['close']);
    close.addEventListener('click', () => { review.innerHTML = ''; });
    const confirm = h('button', {class: 'btn primary'}, [`merge into ${plan.base}`]);
    confirm.disabled = blocked;
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      try {
        showMergeOutcome(await api.mergeIntegrate(sessionId));
      } catch (error) {
        review.append(h('p', {class: 'error'}, [error instanceof Error ? error.message : String(error)]));
      }
    });
    review.append(h('div', {class: 'card'}, [
      h('div', {class: 'toolbar'}, [
        h('div', {}, [
          h('h3', {}, [blocked ? 'this lane cannot merge yet' : `merge into ${plan.base}`]),
          h('p', {class: 'section-sub'}, [`${plan.ahead} commit${plan.ahead === 1 ? '' : 's'} ahead · ${plan.uncommittedFiles} uncommitted file${plan.uncommittedFiles === 1 ? '' : 's'} · checks run before anything merges`])
        ]),
        h('div', {class: 'actions'}, [confirm, close])
      ]),
      ...plan.blockers.map(blocker => h('p', {class: 'error'}, [blocker])),
      ...(plan.conflicts.length > 0
        ? [h('p', {class: 'error'}, [`git predicts ${plan.conflicts.length} conflicting file${plan.conflicts.length === 1 ? '' : 's'}. Resolve them in the lane, then try again — fluentd will not resolve them for you.`]), h('pre', {class: 'diff'}, [plan.conflicts.join('\n')])]
        : [])
    ]));
  }

  function showMergeOutcome(outcome: MergeOutcome) {
    review.innerHTML = '';
    const close = h('button', {class: 'btn'}, ['close']);
    close.addEventListener('click', () => { review.innerHTML = ''; });
    review.append(h('div', {class: 'card'}, [
      h('div', {class: 'toolbar'}, [h('div', {}, [h('h3', {}, [outcome.status === 'merged' ? 'merged' : `not merged — ${outcome.status}`])]), close]),
      h('p', {class: outcome.status === 'merged' ? 'section-sub' : 'error'}, [outcome.detail]),
      ...(outcome.verification?.output && outcome.status === 'unverified' ? [h('pre', {class: 'diff'}, [outcome.verification.output])] : [])
    ]));
  }

  /** Shows what ran, not just whether it was green — including the reasons to read a pass
   * sceptically, which is the part a reviewer cannot reconstruct from a pill. */
  function showVerification(result: VerificationResult) {
    review.innerHTML = '';
    const heading = {running: 'checks running', passed: 'checks passed', failed: 'checks failed', unavailable: 'no checks to run'}[result.status];
    const close = h('button', {class: 'btn'}, ['close']);
    close.addEventListener('click', () => { review.innerHTML = ''; });
    review.append(h('div', {class: 'card'}, [
      h('div', {class: 'toolbar'}, [
        h('div', {}, [
          h('h3', {}, [heading]),
          h('p', {class: 'section-sub'}, [result.command ? `${result.command} · ${result.source} · ${(result.durationMs / 1000).toFixed(1)}s` : result.detail ?? ''])
        ]),
        close
      ]),
      ...result.warnings.map(warning => h('p', {class: 'error'}, [warning])),
      result.output ? h('pre', {class: 'diff'}, [result.output]) : h('p', {class: 'section-sub'}, ['The check produced no output.'])
    ]));
  }

  /**
   * The fallback question, with the recommendation reflected in which button leads. Switching is
   * not free — a new account starts with a cold prompt cache — so when waiting is the better trade
   * the emphasis follows the advice instead of nudging toward the switch regardless.
   */
  function showBanner(message: string, onSwitch?: () => void, recommendation?: 'switch' | 'wait') {
    banner.innerHTML = '';
    const actions = h('div', {class: 'actions'});
    if (onSwitch) {
      const preferWaiting = recommendation === 'wait';
      const switchButton = h('button', {class: preferWaiting ? 'btn' : 'btn primary'}, [preferWaiting ? 'switch anyway' : 'switch now']);
      switchButton.addEventListener('click', () => {
        onSwitch();
        banner.innerHTML = '';
      });
      const dismiss = h('button', {class: preferWaiting ? 'btn primary' : 'btn'}, ['keep waiting']);
      dismiss.addEventListener('click', () => (banner.innerHTML = ''));
      actions.append(switchButton, dismiss);
    }
    banner.append(h('div', {class: 'banner'}, [h('span', {}, [message]), actions]));
  }

  const {snapshot, unsubscribe} = subscribeSession(sessionId, {
    onOutput: chunk => terminal.write(chunk),
    onStatus: summary => renderHeader(summary)
  });
  const initial = await snapshot;
  renderHeader(initial);
  terminal.write(initial.output);

  const unlistenNotice = await onCredentialNotice(event => {
    if (event.provider !== initial.provider) return;
    showBanner(event.message, () => {
      void api.confirmFallback(event.provider, true, event.resetAt);
    }, event.guidance?.recommendation);
  });
  // A verification result is pushed whether the user asked for it or ran it themselves, so an
  // automatic check on lane exit lands in the same place a manual one does.
  const unlistenVerification = await onSessionVerification(event => {
    if (event.sessionId !== sessionId) return;
    showVerification(event.result);
  });
  // The lane is already running by the time this arrives — it is a warning, not a gate.
  const unlistenAdmission = await onAdmissionWarning(event => {
    if (event.sessionId !== sessionId) return;
    showBanner(`started without headroom — ${event.verdict.reasons[0]}`);
  });
  const unlistenSwitched = await onCredentialSwitched(event => {
    if (event.provider !== initial.provider) return;
    showBanner(`switched to ${accountLabel(event.accountId, chains)} (${event.reason})`);
  });

  activeSessionCleanup = () => {
    window.removeEventListener('resize', onWindowResize);
    void unsubscribe();
    unlistenNotice();
    unlistenSwitched();
    unlistenVerification();
    unlistenAdmission();
    terminal.dispose();
  };
}

// --- Credentials ------------------------------------------------------------

async function renderCredentials(main: HTMLElement) {
  const providerLabels: Record<ProviderId, string> = {claude: 'Claude Code', codex: 'Codex'};
  main.append(
    h('h1', {class: 'section-title'}, [markEl(), `${providerLabels[credentialProvider]} credentials`]),
    h('p', {class: 'section-sub'}, ['fluent uses these in order — the highest connected credential runs your sessions'])
  );

  const providers = h('div', {class: 'segmented'});
  (Object.keys(providerLabels) as ProviderId[]).forEach(provider => {
    const button = h('button', {class: `btn${credentialProvider === provider ? ' primary' : ''}`}, [providerLabels[provider]]);
    button.addEventListener('click', () => { credentialProvider = provider; void render(); });
    providers.append(button);
  });
  main.append(providers);

  const chain = (await api.listCredentials()).find(c => c.provider === credentialProvider) ?? {
    provider: credentialProvider,
    accounts: [],
    chain: [],
    fallbackPolicy: 'always-ask' as const
  };

  const list = h('div', {});
  main.append(list);

  function renderList() {
    list.innerHTML = '';
    chain.chain.forEach((accountId, index) => {
      const account = chain.accounts.find(a => a.id === accountId);
      if (!account) return;
      const isActive = chain.activeAccountId === accountId;
      const row = h('div', {class: `option-row${isActive ? ' selected' : ''}`}, [
        h('span', {class: 'label'}, [`${index + 1}. ${account.label}`]),
        h('span', {class: 'meta'}, [account.mode + (isActive ? ' · active now' : '')])
      ]);
      const controls = h('div', {});
      if (index > 0) {
        const up = h('button', {class: 'btn'}, ['↑']);
        up.addEventListener('click', async () => {
          const reordered = [...chain.chain];
          [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]];
          await api.setChain(credentialProvider, reordered);
          chain.chain = reordered;
          renderList();
        });
        controls.append(up);
      }
      row.append(controls);
      list.append(row);
    });
    if (chain.accounts.length === 0) list.append(h('p', {class: 'section-sub'}, ['No accounts yet — add one below or from onboarding.']));
  }
  renderList();

  main.append(h('label', {class: 'field-label'}, ['when a credential hits its limit']));
  const policies: Array<{id: CredentialChainState['fallbackPolicy']; label: string}> = [
    {id: 'always-ask', label: 'always ask'},
    {id: 'always-switch', label: 'always switch automatically'},
    {id: 'never-switch', label: 'never switch (just wait)'}
  ];
  const policyRow = h('div', {class: 'cards-row'});
  for (const policy of policies) {
    const card = h('div', {class: `card selectable${chain.fallbackPolicy === policy.id ? ' selected' : ''}`}, [policy.label]);
    card.addEventListener('click', async () => {
      await api.setFallbackPolicy(credentialProvider, policy.id);
      chain.fallbackPolicy = policy.id;
      for (const sibling of policyRow.children) sibling.classList.remove('selected');
      card.classList.add('selected');
    });
    policyRow.append(card);
  }
  main.append(policyRow);
  const activeLabel = chain.accounts.find(account => account.id === chain.activeAccountId)?.label ?? 'the provider CLI login';
  main.append(h('p', {class: 'section-sub'}, [chain.fallbackPolicy === 'always-ask'
    ? `if ${activeLabel} reaches a limit, Fluent asks before trying the next credential, then reverts after reset.`
    : chain.fallbackPolicy === 'always-switch'
      ? `if ${activeLabel} reaches a limit, Fluent tries the next credential and reverts after reset.`
      : `if ${activeLabel} reaches a limit, Fluent waits and does not switch credentials.`]));

  main.append(h('label', {class: 'field-label'}, ['add an API key account']));
  const labelInput = h('input', {type: 'text', placeholder: 'label'});
  const keyInput = h('input', {type: 'password', placeholder: credentialProvider === 'claude' ? 'sk-ant-...' : 'sk-...'});
  const baseUrlInput = h('input', {type: 'text', placeholder: 'base URL (optional — e.g. OpenRouter preset)'});
  const addButton = h('button', {class: 'btn'}, ['add account']);
  addButton.addEventListener('click', async () => {
    const apiKey = keyInput.value.trim();
    if (!apiKey) return keyInput.focus();
    await api.upsertAccount({
      provider: credentialProvider,
      id: crypto.randomUUID(),
      mode: 'api-key',
      label: labelInput.value.trim() || 'API key',
      apiKey,
      baseUrl: credentialProvider === 'claude' ? baseUrlInput.value.trim() || undefined : undefined
    });
    await renderCredentials(replaceMain(main));
  });
  main.append(h('div', {class: 'field'}, [labelInput, keyInput, ...(credentialProvider === 'claude' ? [baseUrlInput] : []), addButton]));
}

void render();
