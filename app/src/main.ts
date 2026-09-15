import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {open as openDialog} from '@tauri-apps/plugin-dialog';
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
  type CredentialMode,
  type HardwareSample,
  type PriceOverride,
  type ProviderId,
  type Run,
  type SessionSnapshot,
  type MergeOutcome,
  type MergePlan,
  type QuotaWindow,
  type SessionSummary,
  type SpendModelBucket,
  type VerificationResult,
  type VerificationStatus
} from './api';
import type {AssignedIssue, OpenPullRequest, PullRequestStatus, RepoStatus} from './api';
import type {CatalogPlugin, ExtensionSourcePolicyState, ExtensionTrust, MarketplaceEntry, McpServerEntry, McpTransport, RecipeDefinition, RecipeReceipt} from './api';
import {
  retainedCoordinationHistory,
  inspectCoordination,
  isExplorerScope,
  type CoordinationInspection,
  type CoordinationSubject,
  type ExplorerScope
} from './coordination-explorer';
import {currentProject} from './project-scope';
import {leadLoad, sessionMatches, sessionTotals, sessionTree, type SessionView} from './session-tree';

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
  | {name: 'source-control'}
  | {name: 'catalog'}
  | {name: 'themes'}
  | {name: 'orchestration'}
  | {name: 'design'}
  | {name: 'preview'}
  | {name: 'remote'};

let route: Route = {name: 'splash'};
// Non-null only while a page with live lane terminals is mounted, so replacing that page — by
// navigating or by re-rendering the same route — releases their streams.
let routeCleanup: (() => void) | undefined;

/** Registers what a page releases when it is replaced. A render that finishes after a newer render
 * already replaced its page releases at once, instead of overwriting the current page's cleanup and
 * leaking every terminal and subscription that page mounted. */
function setRouteCleanup(page: HTMLElement, cleanup: () => void) {
  if (!page.isConnected) return cleanup();
  routeCleanup = cleanup;
}
let credentialProvider: ProviderId = 'claude';
type Appearance = 'system' | 'dark' | 'light';
type ThemeMode = 'dark' | 'light';
const appearanceKey = 'fluent.appearance';
const bundleKey = 'fluent.theme-bundles';
const workspacePathKey = 'fluent.workspace-path';
const explorerScopeKey = 'fluent.orchestration-explorer.scope.v1';
// Fluent Dark is the first-run bundle. System remains available as an explicit preference, but
// letting a light OS silently choose the initial product surface contradicts the desktop design
// contract and makes first impressions vary by machine.
let appearance: Appearance = (localStorage.getItem(appearanceKey) as Appearance | null) ?? 'dark';
let bundles: Record<ThemeMode, string> = JSON.parse(localStorage.getItem(bundleKey) ?? '{"dark":"Fluent Dark","light":"Fluent Light"}');
// A workspace is a local path chosen by the user, never a path from the machine that built the
// app. It is an input default only; each session still records its own working directory.
let workspacePath = localStorage.getItem(workspacePathKey) ?? '';
// Presentation preferences stay on this machine. Project coordination remains in fluentd and is
// deliberately not changed by a user's preferred explorer view.
let explorerScope: ExplorerScope = (() => {
  try {
    const saved = localStorage.getItem(explorerScopeKey);
    return isExplorerScope(saved) ? saved : 'overview';
  } catch { return 'overview'; }
})();
let orchestrationProject: string | undefined;
let explorerSelection: {project: string; subject: CoordinationSubject} | undefined;
let sessionView: SessionView = 'all';
/** Kept across re-renders so a status update does not wipe what the user typed. */
let sessionQuery = '';

function setExplorerScope(next: ExplorerScope) {
  explorerScope = next;
  try { localStorage.setItem(explorerScopeKey, next); } catch { /* a private-browsing failure should not block coordination */ }
}

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

const actionNotices = h('div', {class: 'action-notices', role: 'status', 'aria-live': 'polite'});
document.body.append(actionNotices);
let noticeTimer: number | undefined;

function actionErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error:\s*/, '') || 'The action could not be completed.';
}

/** Every async control gets a visible result if its daemon call rejects. A provider issue must
 * never be mistaken for an unresponsive button, even on a route that has no local status panel. */
function showActionError(error: unknown) {
  actionNotices.innerHTML = '';
  actionNotices.append(h('div', {class: 'action-notice error'}, [actionErrorText(error)]));
  if (noticeTimer) window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { actionNotices.innerHTML = ''; }, 12_000);
}

/**
 * Asks before a consequential action, inside the app. `window.confirm` is unusable here: Tauri's
 * macOS webview (wry) implements no WKUIDelegate JavaScript panels, so it returns false without
 * showing anything, and every action gated on it silently did nothing in the desktop app. Escape
 * and cancel both resolve false; a destructive action starts focused on cancel so a stray Enter
 * cannot confirm it.
 */
function askConfirm(options: {title: string; body: string; detail?: string; confirmLabel: string; danger?: boolean}): Promise<boolean> {
  return new Promise(resolve => {
    const cancel = h('button', {class: 'btn', type: 'button'}, ['cancel']);
    const accept = h('button', {class: options.danger ? 'btn danger' : 'btn primary', type: 'button'}, [options.confirmLabel]);
    const dialog = h('dialog', {class: 'confirm-dialog', 'aria-label': options.title}, [
      h('h2', {}, [options.title]),
      h('p', {}, [options.body]),
      ...(options.detail ? [h('pre', {class: 'confirm-detail'}, [options.detail])] : []),
      h('div', {class: 'actions'}, [cancel, accept])
    ]);
    cancel.addEventListener('click', () => dialog.close('cancel'));
    accept.addEventListener('click', () => dialog.close('confirm'));
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(dialog.returnValue === 'confirm');
    });
    document.body.append(dialog);
    dialog.showModal();
    (options.danger ? cancel : accept).focus();
  });
}

window.addEventListener('unhandledrejection', event => {
  event.preventDefault();
  showActionError(event.reason);
});

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
  routeCleanup?.();
  routeCleanup = undefined;
  root.innerHTML = '';
  const main = h('main');
  // `main` is the full-width scroll owner (its scrollbar always sits at the true panel edge);
  // `.page` is the separate, width-capped wrapper every route actually renders into. Splash has no
  // rail/scroll shell at all, so it renders straight into `main` instead.
  let page: HTMLElement;
  if (route.name === 'splash') {
    main.classList.add('splash-main');
    root.append(main);
    page = main;
  } else {
    // The shell is deliberately stable while routes change. The top command bar carries the
    // current target and project at a glance; the rail keeps the user's place in the control
    // surface visible without competing with the active work plane.
    root.append(renderTopbar(), h('div', {class: 'app-shell'}, [renderAppRail(), main]));
    page = h('div', {class: 'page'});
    main.append(page);
  }

  try {
    switch (route.name) {
      case 'splash':
        await renderSplash(page);
        break;
      case 'onboarding':
        await renderOnboarding(page);
        break;
      case 'sessions':
        await renderSessions(page);
        break;
      case 'new-session':
        await renderNewSession(page);
        break;
      case 'active-session':
        await renderActiveSession(page, route.sessionId);
        break;
      case 'credentials':
        await renderCredentials(page);
        break;
      case 'usage':
        await renderUsage(page);
        break;
      case 'spend':
        await renderSpend(page);
        break;
      case 'source-control':
        await renderSourceControl(page);
        break;
      case 'catalog':
        await renderCatalog(page);
        break;
      case 'themes':
        await renderThemes(page);
        break;
      case 'orchestration':
        await renderOrchestration(page);
        break;
      case 'design':
        await renderDesignWorkspace(page);
        break;
      case 'preview':
        await renderPreview(page);
        break;
      case 'remote':
        await renderRemote(page);
        break;
    }
  } catch (error) {
    page.innerHTML = '';
    page.append(h('p', {class: 'splash error'}, [error instanceof Error ? error.message : String(error)]));
  }
}

function renderTopbar(): HTMLElement {
  const target = activeRemoteSocket()
    ? h('span', {class: 'target-pill'}, ['● remote target'])
    : h('span', {class: 'target-pill local'}, ['● local · owner only']);
  return h('header', {class: 'topbar app-topbar'}, [
    h('div', {class: 'brand'}, [markEl(), 'fluent code']),
    h('span', {class: 'topbar-divider'}),
    h('span', {class: 'topbar-product'}, ['agent control surface']),
    h('span', {class: 'topbar-divider topbar-project-divider'}),
    h('span', {class: 'topbar-project-path'}, [workspacePath || 'no workspace selected']),
    h('div', {class: 'topbar-target'}, [target])
  ]);
}

function renderAppRail(): HTMLElement {
  const workspace = h('nav', {class: 'primary-nav'}, [
    h('span', {class: 'rail-label'}, ['workspace']),
    navButton('sessions', 'sessions'),
    navButton('new session', 'new-session'),
    navButton('orchestrate', 'orchestration'),
    navButton('remote', 'remote')
  ]);
  const control = h('nav', {class: 'primary-nav'}, [
    h('span', {class: 'rail-label'}, ['control plane']),
    navButton('usage', 'usage'),
    navButton('spend', 'spend'),
    navButton('source control', 'source-control'),
    navButton('catalog', 'catalog'),
    navButton('credentials', 'credentials')
  ]);
  const tools = h('nav', {class: 'primary-nav'}, [
    h('span', {class: 'rail-label'}, ['tools']),
    navButton('design workspace', 'design'),
    navButton('preview', 'preview'),
    navButton('themes', 'themes')
  ]);
  const workspaceName = h('strong', {}, [workspacePath ? workspaceFolderName(workspacePath) : 'choose a workspace']);
  const workspaceLocation = h('span', {class: 'rail-project-path'}, [workspacePath || 'select a folder to begin']);
  const chooseWorkspace = h('button', {class: 'rail-project-picker', type: 'button'}, ['browse folders…']);
  chooseWorkspace.addEventListener('click', async () => {
    const selected = await pickDirectory('Choose workspace folder', workspacePath);
    if (!selected) return;
    setWorkspacePath(selected);
    void render();
  });

  return h('aside', {class: 'app-rail'}, [
    h('div', {class: 'rail-project'}, [
      h('span', {class: 'rail-project-label'}, ['current project']),
      workspaceName,
      workspaceLocation,
      chooseWorkspace
    ]),
    h('div', {class: 'rail-sections'}, [workspace, control, tools]),
    h('div', {class: 'rail-footer'}, [h('span', {}, ['local-first · inspectable'])])
  ]);
}

function workspaceFolderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function setWorkspacePath(path: string) {
  workspacePath = path;
  localStorage.setItem(workspacePathKey, path);
}

function isNativePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(path);
}

/** Opens the OS folder chooser instead of asking a developer to know and type an absolute path.
 * The dialog is intentionally limited to one directory: Fluent passes that exact path to the
 * local daemon; it does not receive broad filesystem read access. */
async function pickDirectory(title: string, defaultPath = ''): Promise<string | undefined> {
  const selected = await openDialog({
    title,
    directory: true,
    multiple: false,
    ...(isNativePath(defaultPath) ? {defaultPath} : {})
  });
  return typeof selected === 'string' ? selected : undefined;
}

/** A spec remains on the user's machine. Fluent only passes the chosen local path to the planner
 * lane; it does not upload or parse the document behind the user's back. */
async function pickSpecFile(title: string, defaultPath = ''): Promise<string | undefined> {
  const selected = await openDialog({
    title,
    multiple: false,
    filters: [{name: 'Specification documents', extensions: ['md', 'mdx', 'txt', 'rst']}],
    ...(isNativePath(defaultPath) ? {defaultPath} : {})
  });
  return typeof selected === 'string' ? selected : undefined;
}

function directoryField(input: HTMLInputElement, title = 'Choose workspace folder'): HTMLElement {
  const browse = h('button', {class: 'btn directory-browse', type: 'button'}, ['browse…']);
  browse.addEventListener('click', async () => {
    browse.disabled = true;
    try {
      const selected = await pickDirectory(title, input.value.trim() || workspacePath);
      if (!selected) return;
      input.value = selected;
      setWorkspacePath(selected);
      input.dispatchEvent(new Event('input', {bubbles: true}));
    } finally {
      browse.disabled = false;
    }
  });
  return h('div', {class: 'directory-field'}, [input, browse]);
}

// --- Chart primitives --------------------------------------------------------
// Plain inline SVG, no charting library — kept consistent with the rest of app/ (vanilla TS,
// esbuild-bundled, no framework). Curve math and axis rounding follow the same approach T3 Code's
// usage chart uses (apps/web/src/components/usage/UsageProviderChart.tsx, MIT licensed): monotone
// cubic interpolation so a curve can never overshoot spiky data, and a "nice" axis max so the
// tallest value is never clipped. `vector-effect="non-scaling-stroke"` plus a
// `preserveAspectRatio="none"` viewBox make every chart here fluid to its container's size without
// the stroke getting fatter or thinner as the window resizes.

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, children: Array<Node | string> = []): SVGElementTagNameMap[K] {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  for (const child of children) element.append(child);
  return element;
}

interface ChartPoint { x: number; y: number; }

/** Shape-preserving cubic tangents (Fritsch-Carlson) — the curve follows the data without
 * overshooting between two points that both sit on a local peak or valley. */
function monotoneTangents(points: readonly ChartPoint[]): number[] {
  const count = points.length;
  if (count < 2) return [0];
  const slopes: number[] = [];
  for (let i = 0; i < count - 1; i += 1) {
    const dx = points[i + 1]!.x - points[i]!.x;
    const dy = points[i + 1]!.y - points[i]!.y;
    slopes.push(dx === 0 ? 0 : dy / dx);
  }
  const tangents = new Array<number>(count).fill(0);
  tangents[0] = slopes[0] ?? 0;
  tangents[count - 1] = slopes[count - 2] ?? 0;
  for (let i = 1; i < count - 1; i += 1) {
    const previous = slopes[i - 1] ?? 0;
    const next = slopes[i] ?? 0;
    tangents[i] = previous * next <= 0 ? 0 : (previous + next) / 2;
  }
  for (let i = 0; i < count - 1; i += 1) {
    const slope = slopes[i] ?? 0;
    if (slope === 0) { tangents[i] = 0; tangents[i + 1] = 0; continue; }
    const a = (tangents[i] ?? 0) / slope;
    const b = (tangents[i + 1] ?? 0) / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[i] = scale * a * slope;
      tangents[i + 1] = scale * b * slope;
    }
  }
  return tangents;
}

function curvePath(points: readonly ChartPoint[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M${points[0]!.x.toFixed(2)},${points[0]!.y.toFixed(2)}`;
  const tangents = monotoneTangents(points);
  let path = `M${points[0]!.x.toFixed(2)},${points[0]!.y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i]!;
    const to = points[i + 1]!;
    const dx = to.x - from.x;
    const c1x = from.x + dx / 3;
    const c1y = from.y + ((tangents[i] ?? 0) * dx) / 3;
    const c2x = to.x - dx / 3;
    const c2y = to.y - ((tangents[i + 1] ?? 0) * dx) / 3;
    path += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${to.x.toFixed(2)},${to.y.toFixed(2)}`;
  }
  return path;
}

/** Rounds an axis max up to a readable 1/2/5 x 10^n step at or above the peak, so the tallest
 * value is never drawn past the top of the plot and clipped. */
function niceAxisMax(peak: number, steps = 4): number {
  if (peak <= 0) return 0;
  const rawStep = peak / steps;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  return Math.ceil(peak / step) * step;
}

/** A compact trend line with no axis — the inline replacement for the old glyph sparkline
 * (rendered as monospace block characters). */
function sparklineChart(values: readonly number[], color = 'currentColor'): SVGSVGElement {
  const width = 96;
  const height = 24;
  const finite = values.filter(Number.isFinite);
  const svg = svgEl('svg', {class: 'sparkline', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', 'aria-hidden': 'true'});
  if (finite.length < 2) return svg;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const range = Math.max(max - min, 1e-6);
  const step = width / (finite.length - 1);
  const points = finite.map((value, index) => ({x: index * step, y: height - 2 - ((value - min) / range) * (height - 4)}));
  const line = curvePath(points);
  svg.append(
    svgEl('path', {d: `${line} L${width},${height} L0,${height} Z`, fill: color, 'fill-opacity': '0.14'}),
    svgEl('path', {d: line, fill: 'none', stroke: color, 'stroke-width': '1.6', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke'})
  );
  return svg;
}

interface ChartSeries { readonly label: string; readonly color: string; readonly values: readonly number[]; }

/** Multi-series line chart with gridlines, a legend, and start/mid/end category labels — the same
 * shape as the Usage Observatory artboard (design/previews/hNqHb.png, "Multi-series token flow").
 * Each category gets an invisible hit column with a native `<title>` tooltip rather than a
 * hand-rolled positioned tooltip, which keeps this dependency-free while still making exact
 * values inspectable on hover. */
function lineChart(categories: readonly string[], series: readonly ChartSeries[], formatValue: (value: number) => string): HTMLElement {
  const width = 960;
  const height = 200;
  const topPad = 10;
  const peak = Math.max(1e-9, ...series.flatMap(item => item.values));
  const axisMax = niceAxisMax(peak) || peak;
  const toY = (value: number) => height - (value / axisMax) * (height - topPad);
  const stepX = categories.length > 1 ? width / (categories.length - 1) : 0;
  const gridTicks = 4;
  const ticks = Array.from({length: gridTicks + 1}, (_, index) => (axisMax / gridTicks) * index);

  const svg = svgEl('svg', {class: 'line-chart-svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'multi-series chart'});
  for (const tick of ticks) {
    const y = toY(tick);
    svg.append(svgEl('line', {class: 'chart-grid-line', x1: '0', x2: String(width), y1: y.toFixed(2), y2: y.toFixed(2)}));
  }
  // Heaviest series painted first so a small series is never buried under a larger one's fill.
  const byWeight = [...series].sort((a, b) => Math.max(...b.values, 0) - Math.max(...a.values, 0));
  const pointsByLabel = new Map<string, ChartPoint[]>();
  for (const item of byWeight) {
    const points = item.values.map((value, index) => ({x: index * stepX, y: toY(value)}));
    pointsByLabel.set(item.label, points);
    const line = curvePath(points);
    if (line) svg.append(svgEl('path', {d: `${line} L${width},${height} L0,${height} Z`, fill: item.color, 'fill-opacity': '0.12'}));
  }
  for (const item of byWeight) {
    const line = curvePath(pointsByLabel.get(item.label) ?? []);
    if (line) svg.append(svgEl('path', {d: line, fill: 'none', stroke: item.color, 'stroke-width': '2', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke'}));
  }
  if (categories.length > 0 && stepX > 0) {
    categories.forEach((category, index) => {
      const detail = series.map(item => `${item.label} ${formatValue(item.values[index] ?? 0)}`).join(' · ');
      svg.append(svgEl('rect', {class: 'chart-hit-area', x: String(index * stepX - stepX / 2), y: '0', width: String(stepX), height: String(height)}, [
        svgEl('title', {}, [`${category} — ${detail}`])
      ]));
    });
  }

  const axisColumn = h('div', {class: 'chart-y-axis'}, ticks.slice().reverse().map(tick => h('span', {style: `top:${((toY(tick) / height) * 100).toFixed(2)}%`}, [tick === 0 ? '0' : formatValue(tick)])));
  const legend = h('div', {class: 'chart-legend'}, series.map(item => h('span', {class: 'chart-legend-item'}, [h('span', {class: 'chart-legend-swatch', style: `background:${item.color}`}), item.label])));
  const axisLabels = h('div', {class: 'chart-axis-labels'}, [
    h('span', {}, [categories[0] ?? '']),
    h('span', {}, [categories[Math.floor(categories.length / 2)] ?? '']),
    h('span', {}, [categories.at(-1) ?? ''])
  ]);
  return h('div', {class: 'line-chart'}, [
    legend,
    h('div', {class: 'line-chart-body'}, [axisColumn, h('div', {class: 'line-chart-plot'}, [svg])]),
    axisLabels
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
    metricCard('cpu process share', `${current.cpuPercent.toFixed(1)}%`, sparklineChart(history.map(sample => sample.cpuPercent), 'var(--success)')),
    metricCard('memory', `${bytes(current.memoryUsedBytes)} / ${bytes(current.memoryTotalBytes)}`, sparklineChart(history.map(sample => sample.memoryUsedBytes), 'var(--fg-muted)')),
    metricCard('disk used', `${bytes(current.diskUsedBytes)} / ${bytes(current.diskTotalBytes)}`, current.diskTotalBytes ? `${((current.diskUsedBytes! / current.diskTotalBytes) * 100).toFixed(0)}% capacity` : 'not available'),
    metricCard('uptime', duration(current.uptimeSeconds), `${current.platform} · ${current.arch}`)
  ]));
  main.append(h('div', {class: 'cards-row'}, [
    h('div', {class: 'card'}, [
      h('h3', {}, ['hardware trace']),
      h('p', {class: 'trace cpu'}, ['cpu', sparklineChart(history.map(sample => sample.cpuPercent), 'var(--success)')]),
      h('p', {class: 'trace memory'}, ['memory', sparklineChart(history.map(sample => sample.memoryUsedBytes), 'var(--fg-muted)')]),
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
        h('strong', {}, [item.model ?? providerLabel[item.provider]]),
        // Coral is reserved for actions/alerts/thresholds (AGENTS.md), never an ordinary data
        // series — this is a routine per-session trend, so it stays in the muted trace palette.
        h('span', {class: 'trace'}, [`context ${item.contextPercent?.toFixed(0) ?? '—'}%`, sparklineChart(item.history.map(sample => sample.contextPercent ?? NaN), 'var(--fg-muted)')]),
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

function metricCard(label: string, value: string, detail: string | Node): HTMLElement {
  return h('div', {class: 'metric-card'}, [h('span', {class: 'metric-label'}, [label]), h('strong', {}, [value]), h('span', {class: 'metric-detail'}, [detail])]);
}

// --- Spend ---------------------------------------------------------------------
// Layout adapted from T3 Code's Usage page (apps/web/src/components/usage/UsagePage.tsx,
// MIT licensed) — the same visual shape (provider breakdown + daily chart, totals row, a
// model/day breakdown table, price overrides) redrawn as vanilla TS/CSS. Distinct from the
// 'usage' screen above (which is live, per-session status-line telemetry): this is cross-session
// historical cost, scanned from the providers' own transcript files, same as T3's approach.

const providerLabel: Record<ProviderId, string> = {
  claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI',
  qwen: 'Qwen', glm: 'GLM', nvidia: 'NVIDIA NIM'
};
const modelLinkDefaults: Record<'qwen' | 'glm' | 'nvidia', {model: string; endpoint: string; keyPlaceholder: string}> = {
  qwen: {model: 'qwen3-coder', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyPlaceholder: 'sk-…'},
  glm: {model: 'GLM-4.7', endpoint: 'https://api.z.ai/api/coding/paas/v4', keyPlaceholder: '…'},
  nvidia: {model: 'nvidia/nemotron-3-super', endpoint: 'https://integrate.api.nvidia.com/v1', keyPlaceholder: 'nvapi-…'}
};
// Muted, data-viz-safe series colors matching `.provider-dot` in styles.css — Coral stays reserved
// for actions/alerts/thresholds (AGENTS.md), never an ordinary provider series.
const providerColor: Record<ProviderId, string> = {
  claude: '#b08968', codex: '#6b8fb0', gemini: '#8a9a6b',
  qwen: '#5d9990', glm: '#9a7bb3', nvidia: '#739e78'
};

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

    // Daily cost as a per-provider line chart — the same shape as T3's own usage chart
    // (apps/web/src/components/usage/UsageProviderChart.tsx) and the Usage Observatory artboard.
    const chartColumn = h('div', {});
    chartColumn.append(h('h2', {class: 'section-title'}, ['daily cost']));
    const dailySeries = activeProviders.map(provider => ({
      label: providerLabel[provider],
      color: providerColor[provider],
      values: summary.days.map(day => day.models.filter(model => model.provider === provider).reduce((sum, model) => sum + model.costUsd, 0))
    }));
    chartColumn.append(lineChart(summary.days.map(day => dayLabel(day.day)), dailySeries, formatUsd));

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

// --- Source control ------------------------------------------------------------
// GitHub status via `gh` (already authenticated by the user's own `gh auth login` — spec §7.5's
// "orchestrate, don't rebuild" applied to source control too). T3 Code's own PR system is a
// ~100KB multi-provider, event-sourced implementation; this covers what was actually asked for:
// merge status for what you're working on, issues assigned to you, and your open PRs.

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

async function renderSourceControl(main: HTMLElement) {
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

// --- Catalog --------------------------------------------------------------------
// Browse and one-click install Claude Code / Codex skills, plugins, MCP servers — orchestrating
// each CLI's own plugin/marketplace/MCP subcommands rather than reimplementing them (see
// src/catalog-manager.ts). "Favor installing what already exists" applied to the whole agent
// ecosystem, not just provider sessions.

function trustLabel(trust: ExtensionTrust) {
  switch (trust.level) {
    case 'provider-bundled': return 'provider bundled';
    case 'provider-owned': return 'provider-owned source';
    case 'local': return 'local source';
    case 'third-party': return 'third-party source';
    case 'unverified': return 'unverified source';
  }
}

function trustPill(trust: ExtensionTrust) {
  return h('span', {class: `pill${trust.reviewRequired ? ' status-default' : ' status-running'}`}, [trustLabel(trust)]);
}

function pluginRow(plugin: CatalogPlugin, onInstall: () => void): HTMLElement {
  const meta = [providerLabel[plugin.target], plugin.marketplace, plugin.version ? `v${plugin.version}` : null, `source: ${plugin.source}`].filter(Boolean).join(' · ');
  const installButton = h('button', {class: `btn${plugin.installed ? '' : ' primary'}`}, [plugin.installed ? 'installed' : 'install']);
  installButton.toggleAttribute('disabled', plugin.installed);
  if (!plugin.installed) installButton.addEventListener('click', onInstall);
  return h('div', {class: 'option-row'}, [
    h('div', {}, [
      h('div', {class: 'label'}, [plugin.name]),
      h('div', {class: 'meta'}, [plugin.description ? `${plugin.description} — ${meta}` : meta]),
      h('div', {class: 'meta'}, [plugin.trust.disclosures[0] ?? 'Review extension source before use.'])
    ]),
    trustPill(plugin.trust),
    installButton
  ]);
}

function mcpServerRow(server: McpServerEntry): HTMLElement {
  const endpoint = server.transport === 'stdio' ? server.displayCommand : server.displayUrl;
  const args = server.displayArgs?.length ? `args: ${JSON.stringify(server.displayArgs)}` : undefined;
  const meta = [providerLabel[server.target], server.transport, endpoint, args].filter(Boolean).join(' · ');
  const status = server.needsAuth
    ? h('span', {class: 'pill status-default'}, ['needs auth'])
    : server.connected === false
      ? h('span', {class: 'pill status-failed'}, ['disabled'])
      : h('span', {class: 'pill status-running'}, ['connected']);
  return h('div', {class: 'option-row'}, [
    h('div', {}, [h('div', {class: 'label'}, [server.name]), h('div', {class: 'meta'}, [meta]), h('div', {class: 'meta'}, [server.trust.disclosures[0] ?? 'Review server source before use.'])]),
    trustPill(server.trust),
    status
  ]);
}

function marketplaceRow(marketplace: MarketplaceEntry, onTrust?: () => void): HTMLElement {
  const trustSource = h('button', {class: 'btn', type: 'button'}, ['trust source']);
  trustSource.disabled = !onTrust;
  if (onTrust) trustSource.addEventListener('click', onTrust);
  return h('div', {class: 'option-row'}, [
    h('div', {}, [
      h('div', {class: 'label'}, [`${providerLabel[marketplace.target]} · ${marketplace.name}`]),
      h('div', {class: 'meta'}, [marketplace.source]),
      h('div', {class: 'meta'}, [marketplace.trust.disclosures[0] ?? 'Review marketplace source before use.'])
    ]),
    trustPill(marketplace.trust),
    trustSource
  ]);
}

async function renderCatalog(main: HTMLElement) {
  // Plugins and MCP servers live in their own dedicated sections — switched by a tab rather than
  // stacked into one long scroll — so neither crowds the other and the plugin list's own filters
  // don't sit visually on top of the MCP form below it.
  let section: 'plugins' | 'mcp' = 'plugins';
  let targetFilter: ProviderId | 'all' = 'all';
  let installedFilter: 'all' | 'installed' | 'available' = 'all';
  let search = '';
  const container = h('div', {});
  main.append(container);
  container.append(h('div', {class: 'empty-state'}, ['reading installed plugins, marketplaces, and MCP servers…']));

  let plugins: CatalogPlugin[];
  let servers: McpServerEntry[];
  let marketplaces: MarketplaceEntry[];
  let sourcePolicy: ExtensionSourcePolicyState;
  try {
    [plugins, servers, marketplaces, sourcePolicy] = await Promise.all([api.catalogPlugins(), api.catalogMcpServers(), api.catalogMarketplaces(), api.catalogSourcePolicy()]);
  } catch (error) {
    container.innerHTML = '';
    container.append(h('div', {class: 'empty-state'}, [error instanceof Error ? error.message : String(error)]));
    return;
  }

  function drawPlugins(): HTMLElement {
    const wrap = h('div', {});

    // Plugins card: search + target/installed filters over the full merged catalog.
    const pluginsCard = h('div', {class: 'card'});
    pluginsCard.append(h('h3', {}, [`plugins (${plugins.length})`]));

    const targetToggle = h('div', {class: 'segmented'});
    for (const option of ['all', 'claude', 'codex', 'gemini'] as const) {
      const button = h('button', {class: `btn${targetFilter === option ? ' primary' : ''}`}, [option === 'all' ? 'all' : providerLabel[option]]);
      button.addEventListener('click', () => {
        targetFilter = option;
        draw();
      });
      targetToggle.append(button);
    }
    const installedToggle = h('div', {class: 'segmented'});
    for (const option of ['all', 'installed', 'available'] as const) {
      const button = h('button', {class: `btn${installedFilter === option ? ' primary' : ''}`}, [option]);
      button.addEventListener('click', () => {
        installedFilter = option;
        draw();
      });
      installedToggle.append(button);
    }
    const searchInput = h('input', {type: 'text', placeholder: 'search plugins…', value: search});
    searchInput.addEventListener('input', () => {
      search = searchInput.value;
      draw();
    });
    pluginsCard.append(h('div', {class: 'catalog-filter-row'}, [targetToggle, installedToggle]), searchInput);

    const needle = search.trim().toLowerCase();
    const filtered = plugins.filter(plugin => {
      if (targetFilter !== 'all' && plugin.target !== targetFilter) return false;
      if (installedFilter === 'installed' && !plugin.installed) return false;
      if (installedFilter === 'available' && plugin.installed) return false;
      if (!needle) return true;
      return plugin.name.toLowerCase().includes(needle) || (plugin.description ?? '').toLowerCase().includes(needle) || plugin.marketplace.toLowerCase().includes(needle);
    });

    const pluginList = h('div', {class: 'plugin-list'});
    if (filtered.length === 0) {
      pluginList.append(h('p', {class: 'section-sub'}, ['No plugins match.']));
    } else {
      const shown = filtered.slice(0, 200);
      for (const plugin of shown) {
        pluginList.append(
        pluginRow(plugin, async () => {
            const sourceNotice = `${trustLabel(plugin.trust)}: ${plugin.source}. ${plugin.trust.disclosures.join(' ')}`;
            if (!(await askConfirm({title: `install ${plugin.name}`, body: `Install ${plugin.name} for ${providerLabel[plugin.target]}? ${sourceNotice} This runs the provider CLI and may add extension code.`, confirmLabel: 'install'}))) return;
            const result = await api.installCatalogPlugin(plugin.target, plugin.id);
            if (result.ok) {
              plugin.installed = true;
              draw();
            } else {
              showActionError(`Install failed: ${result.output}`);
            }
          })
        );
      }
      if (filtered.length > shown.length) {
        pluginList.append(h('p', {class: 'section-sub'}, [`+${filtered.length - shown.length} more — narrow your search to see them.`]));
      }
    }
    pluginsCard.append(pluginList);
    wrap.append(pluginsCard);

    const policyCard = h('div', {class: 'card'}, [
      h('h3', {}, ['extension source policy']),
      h('p', {class: 'section-sub'}, [sourcePolicy.mode === 'trusted-only'
        ? 'Trusted-only is active: provider-bundled plugins still work, while every other marketplace source and every exact MCP declaration must be listed below in addition to its install approval.'
        : 'Review-each is active: every extension action still requires approval, and trusted sources are retained for a future trusted-only policy.'])
    ]);
    const policyMode = h('select', {'aria-label': 'Extension source policy'}) as HTMLSelectElement;
    policyMode.append(h('option', {value: 'review-each'}, ['review each extension']), h('option', {value: 'trusted-only'}, ['trusted sources only']));
    policyMode.value = sourcePolicy.mode;
    const savePolicy = h('button', {class: 'btn'}, ['save policy']);
    savePolicy.addEventListener('click', async () => {
      savePolicy.disabled = true;
      try {
        sourcePolicy = await api.setCatalogSourcePolicyMode(policyMode.value as ExtensionSourcePolicyState['mode']);
        draw();
      } catch (error) {
        showActionError(`Could not save extension source policy: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        savePolicy.disabled = false;
      }
    });
    const trustedList = h('div', {class: 'plugin-list'});
    if (sourcePolicy.sources.length === 0) {
      trustedList.append(h('p', {class: 'section-sub'}, ['No sources are trusted yet. Trust a configured marketplace below or select “remember this exact declaration” when adding an MCP server.']));
    } else {
      for (const source of sourcePolicy.sources) {
        const remove = h('button', {class: 'btn danger', type: 'button'}, ['remove trust']);
        remove.addEventListener('click', async () => {
          if (!(await askConfirm({title: 'remove trusted source', body: `Remove ${source.source} from the trusted extension allowlist? This does not uninstall anything.`, confirmLabel: 'remove trust', danger: true}))) return;
          remove.disabled = true;
          try {
            sourcePolicy = await api.removeCatalogTrustedSource(source.id);
            draw();
          } catch (error) {
            showActionError(`Could not remove trusted source: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            remove.disabled = false;
          }
        });
        trustedList.append(h('div', {class: 'option-row'}, [h('div', {}, [h('div', {class: 'label'}, [source.kind]), h('div', {class: 'meta'}, [source.source])]), remove]));
      }
    }
    policyCard.append(h('div', {class: 'actions'}, [policyMode, savePolicy]), trustedList);
    wrap.append(policyCard);

    const marketplaceListCard = h('div', {class: 'card'}, [
      h('h3', {}, [`configured marketplaces (${marketplaces.length})`]),
      h('p', {class: 'section-sub'}, ['Source provenance is evidence from the provider configuration, not a permission manifest or safety guarantee.'])
    ]);
    marketplaceListCard.append(...(marketplaces.length ? marketplaces.map(marketplace => marketplaceRow(marketplace, async () => {
      if (!(await askConfirm({title: 'trust marketplace source', body: `Trust ${marketplace.source} for future marketplace plugin installs? This does not install code or bypass the per-install approval.`, confirmLabel: 'trust source'}))) return;
      try {
        sourcePolicy = await api.trustCatalogMarketplaceSource(marketplace.source);
        draw();
      } catch (error) {
        showActionError(`Could not trust marketplace source: ${error instanceof Error ? error.message : String(error)}`);
      }
    })) : [h('p', {class: 'section-sub'}, ['No provider marketplaces were reported.'])]));
    wrap.append(marketplaceListCard);

    // Add-marketplace card — a new marketplace source unlocks more plugins in the list above.
    const marketplaceCard = h('div', {class: 'card'}, [
      h('h3', {}, ['add a marketplace']),
      h('p', {class: 'section-sub'}, ['Use a GitHub repo (owner/repo, HTTPS, or Git SSH) or an absolute local path that publishes a Claude Code or Codex marketplace.'])
    ]);
    const marketplaceTargetSelect = h('select', {}, [h('option', {value: 'claude'}, ['Claude Code']), h('option', {value: 'codex'}, ['Codex'])]);
    const marketplaceSourceInput = h('input', {type: 'text', placeholder: 'owner/repo or path'});
    const trustNewMarketplace = h('input', {type: 'checkbox'}) as HTMLInputElement;
    const trustNewMarketplaceLabel = h('label', {class: 'section-sub'}, [trustNewMarketplace, ' remember this source in the trusted allowlist']);
    const marketplaceAddButton = h('button', {class: 'btn primary'}, ['add']);
    marketplaceAddButton.addEventListener('click', async () => {
      const source = marketplaceSourceInput.value.trim();
      if (!source) return;
      const target = marketplaceTargetSelect.value as ProviderId;
      if (!(await askConfirm({title: 'add marketplace', body: `Add marketplace “${source}” for ${providerLabel[target]}? Fluent will validate the source before the provider CLI is allowed to fetch it. Review any local or third-party code before installing plugins.`, confirmLabel: 'add marketplace'}))) return;
      const result = await api.addCatalogMarketplace(target, source, trustNewMarketplace.checked);
      if (result.ok) {
        [plugins, marketplaces, sourcePolicy] = await Promise.all([api.catalogPlugins(), api.catalogMarketplaces(), api.catalogSourcePolicy()]);
        marketplaceSourceInput.value = '';
        trustNewMarketplace.checked = false;
        draw();
      } else {
        showActionError(`Add marketplace failed: ${result.output}`);
      }
    });
    marketplaceCard.append(h('div', {class: 'marketplace-form'}, [marketplaceTargetSelect, marketplaceSourceInput, marketplaceAddButton]), trustNewMarketplaceLabel);
    wrap.append(marketplaceCard);
    return wrap;
  }

  function drawMcp(): HTMLElement {
    const mcpCard = h('div', {class: 'card'}, [h('h3', {}, [`MCP servers (${servers.length})`])]);
    if (servers.length === 0) {
      mcpCard.append(h('p', {class: 'section-sub'}, ['No MCP servers configured yet.']));
    } else {
      for (const server of servers) mcpCard.append(mcpServerRow(server));
    }
    const mcpTargetSelect = h('select', {}, [h('option', {value: 'all'}, ['all supported agents']), h('option', {value: 'claude'}, ['Claude Code']), h('option', {value: 'codex'}, ['Codex']), h('option', {value: 'gemini'}, ['Gemini CLI'])]);
    const mcpTransportSelect = h('select', {}, [h('option', {value: 'stdio'}, ['stdio']), h('option', {value: 'http'}, ['http']), h('option', {value: 'sse'}, ['sse'])]);
    const mcpNameInput = h('input', {type: 'text', placeholder: 'server name'});
    const mcpCommandInput = h('input', {type: 'text', placeholder: 'executable, or https:// URL'});
    const mcpArgsInput = h('input', {type: 'text', placeholder: 'arguments JSON array (optional)'});
    const trustMcpSource = h('input', {type: 'checkbox'}) as HTMLInputElement;
    const trustMcpSourceLabel = h('label', {class: 'section-sub'}, [trustMcpSource, ' remember this exact declaration in the trusted allowlist']);
    const mcpAddButton = h('button', {class: 'btn primary'}, ['add']);
    mcpAddButton.addEventListener('click', async () => {
      const name = mcpNameInput.value.trim();
      const endpoint = mcpCommandInput.value.trim();
      const transport = mcpTransportSelect.value as McpTransport;
      if (!name || !endpoint) return;
      let args: string[] = [];
      try {
        const parsed = mcpArgsInput.value.trim() ? JSON.parse(mcpArgsInput.value) : [];
        if (!Array.isArray(parsed) || parsed.some(arg => typeof arg !== 'string')) throw new Error();
        args = parsed;
      } catch {
        showActionError('Arguments must be a JSON array of strings, for example ["-y", "@scope/server"].');
        return;
      }
      const selection = mcpTargetSelect.value as ProviderId | 'all';
      const targets: ProviderId[] = selection === 'all' ? ['claude', 'codex', 'gemini'] : [selection];
      const config = transport === 'stdio'
        ? {name, transport, command: endpoint, args, scope: 'user' as const}
        : {name, transport, url: endpoint, scope: 'user' as const};
      const boundary = transport === 'stdio'
        ? `This launches the local process “${endpoint}” with ${args.length} structured argument${args.length === 1 ? '' : 's'} when used by an agent.`
        : 'This connects to a remote HTTPS endpoint when used by an agent; it does not launch a local process.';
      if (!(await askConfirm({title: 'add MCP server', body: `Add MCP server “${name}” for ${targets.map(target => providerLabel[target]).join(', ')}? ${boundary} Review the server source before use.`, confirmLabel: 'add server'}))) return;
      const results = await api.addCatalogMcpServer(targets, config, trustMcpSource.checked);
      const failures = results.filter(result => !result.ok);
      if (failures.length === 0) {
        [servers, sourcePolicy] = await Promise.all([api.catalogMcpServers(), api.catalogSourcePolicy()]);
        trustMcpSource.checked = false;
        draw();
      } else {
        showActionError(`MCP setup failed for ${failures.map(result => `${providerLabel[result.target]}: ${result.output}`).join('\n')}`);
      }
    });
    mcpCard.append(
      h('p', {class: 'section-sub'}, ['Portable MCP servers can be registered at user scope for every installed agent. Native marketplace plugins remain provider-specific.']),
      h('div', {class: 'mcp-form'}, [mcpTargetSelect, mcpTransportSelect, mcpNameInput, mcpCommandInput, mcpArgsInput, mcpAddButton]),
      trustMcpSourceLabel
    );
    return mcpCard;
  }

  function draw() {
    container.innerHTML = '';
    const sectionTabs = h('div', {class: 'segmented catalog-sections'});
    const tabs: Array<{id: 'plugins' | 'mcp'; label: string}> = [
      {id: 'plugins', label: `plugins (${plugins.length})`},
      {id: 'mcp', label: `MCP servers (${servers.length})`}
    ];
    for (const tab of tabs) {
      const button = h('button', {class: `btn${section === tab.id ? ' primary' : ''}`}, [tab.label]);
      button.addEventListener('click', () => {
        section = tab.id;
        draw();
      });
      sectionTabs.append(button);
    }
    container.append(
      h('div', {class: 'toolbar'}, [
        h('div', {}, [
          h('h1', {class: 'section-title'}, [markEl(), 'catalog']),
          h('p', {class: 'section-sub'}, ['browse and install Claude Code / Codex / Gemini skills, plugins, and MCP servers — orchestrated through each CLI\'s own catalog'])
        ])
      ]),
      sectionTabs,
      section === 'plugins' ? drawPlugins() : drawMcp()
    );
  }

  draw();
}

// --- Parallel orchestration --------------------------------------------------

async function renderOrchestration(main: HTMLElement) {
  const sessions = await api.listSessions();
  const projects = [...new Set(sessions.map(session => session.projectDirectory ?? session.directory))];
  if (!orchestrationProject || !projects.includes(orchestrationProject)) orchestrationProject = projects[0];
  const project = orchestrationProject;
  // An inspector selection is intentionally transient. It cannot follow a project change and it
  // must not describe a record that disappeared while the board was being refreshed.
  if (explorerSelection && explorerSelection.project !== project) explorerSelection = undefined;
  const refresh = h('button', {class: 'btn'}, ['refresh']);
  refresh.addEventListener('click', () => void render());
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
  const projectPicker = h('select', {class: 'orchestration-project-picker', 'aria-label': 'Coordination project'});
  for (const candidate of projects) projectPicker.append(h('option', {value: candidate}, [candidate]));
  if (project) projectPicker.value = project;
  projectPicker.addEventListener('change', () => {
    orchestrationProject = projectPicker.value;
    explorerSelection = undefined;
    void render();
  });
  main.append(h('div', {class: 'toolbar'}, [
    h('div', {}, [
      h('h1', {class: 'section-title'}, [markEl(), 'parallel orchestration']),
      h('p', {class: 'section-sub'}, ['shared, inspectable coordination — claims signal intent; they never lock files'])
    ]),
    h('div', {class: 'actions'}, [projects.length > 1 ? projectPicker : h('span', {class: 'meta'}, [project ?? 'no project']), refresh, addAgent])
  ]));
  main.append(advisory, laneLauncher(project ?? workspacePath));
  if (!project) {
    main.append(h('div', {class: 'empty-state'}, ['Launch lanes above to establish a project coordination board.']));
    return;
  }
  const stopProject = h('button', {class: 'btn'}, ['stop project agents']);
  stopProject.addEventListener('click', async () => {
    const projectSessions = sessions.filter(session => (session.projectDirectory ?? session.directory) === project && session.status === 'running');
    if (!projectSessions.length) return;
    if (!(await askConfirm({title: 'stop project agents', body: `Stop ${projectSessions.length} running agent${projectSessions.length === 1 ? '' : 's'} in this project?`, confirmLabel: 'stop agents', danger: true}))) return;
    await Promise.all(projectSessions.map(session => api.stop(session.id)));
    void render();
  });
  // Keep the potentially disruptive action near the selected project rather than in a global
  // toolbar whose scope is easy to misread when several repositories have active lanes.
  advisory.append(h('div', {class: 'orchestration-project-actions'}, [stopProject]));
  await renderLaneGrid(main, sessions.filter(session => (session.projectDirectory ?? session.directory) === project && (session.status === 'running' || session.status === 'starting')));
  const state = await api.coordination(project);
  const conflicts = await api.conflicts(project);
  const skills = await api.skillStatus().catch(() => []);
  const evals = await api.evalReadiness().catch(() => undefined);
  const live = sessions.filter(session => (session.projectDirectory ?? session.directory) === project && session.status === 'running');
  let inspection: CoordinationInspection | undefined;
  if (explorerSelection?.project === project) {
    inspection = inspectCoordination(explorerSelection.subject, state, sessions, conflicts);
    if (!inspection) explorerSelection = undefined;
  }
  const selectSubject = (label: string, subject: CoordinationSubject, extraClass = '') => {
    const button = h('button', {class: `object-link${extraClass ? ` ${extraClass}` : ''}`, type: 'button'}, [label]);
    button.addEventListener('click', () => {
      explorerSelection = {project, subject};
      void render();
    });
    return button;
  };
  const taskInput = h('input', {type: 'text', placeholder: 'add a shared task'});
  const addTask = h('button', {class: 'btn primary'}, ['add task']);
  addTask.addEventListener('click', async () => {
    if (!taskInput.value.trim()) return taskInput.focus();
    await api.createTask(project, {title: taskInput.value.trim()});
    void render();
  });
  // Coordination recorded from this screen names the lane the user picked. Defaulting silently to
  // the first running lane attributed claims and reviews to an agent that never asked for them.
  const lanePicker = (label: string, selected?: string) => {
    const select = h('select', {'aria-label': label}) as HTMLSelectElement;
    for (const lane of live) select.append(h('option', {value: lane.id}, [`${lane.provider} · ${lane.id.slice(0, 8)}`]));
    if (selected) select.value = selected;
    return select;
  };
  const claimInput = h('input', {type: 'text', placeholder: 'claim a file path'});
  const claimLane = lanePicker('Lane for this claim');
  const claimButton = h('button', {class: 'btn'}, ['claim file']);
  claimButton.disabled = live.length === 0;
  const claimNotice = h('p', {class: 'section-sub'}, []);
  claimButton.addEventListener('click', async () => {
    if (!claimInput.value.trim() || !claimLane.value) return claimInput.focus();
    const result = await api.claimFile(project, claimInput.value.trim(), claimLane.value);
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
    await api.addDecision(project, decisionInput.value.trim());
    void render();
  });
  const handoffInput = h('input', {type: 'text', placeholder: 'handoff summary'});
  const handoffFrom = lanePicker('Handoff from lane', live[0]?.id);
  const handoffTo = lanePicker('Handoff to lane', live[1]?.id);
  const handoffButton = h('button', {class: 'btn'}, ['request review']);
  const handoffNotice = h('p', {class: 'section-sub'}, []);
  handoffButton.disabled = live.length < 2;
  handoffButton.addEventListener('click', async () => {
    if (!handoffInput.value.trim()) return handoffInput.focus();
    if (!handoffFrom.value || handoffFrom.value === handoffTo.value) {
      handoffNotice.textContent = 'Choose two different lanes for a review handoff.';
      handoffNotice.className = 'error';
      return handoffTo.focus();
    }
    await api.createHandoff(project, handoffFrom.value, handoffTo.value, handoffInput.value.trim());
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

  // The board keeps project direction once, then gives each lane only the narrow task it needs.
  // This deliberately avoids pasting every prior conversation into every new provider session.
  const providerSelect = (selected: ProviderId = 'codex') => {
    const select = h('select', {'aria-label': 'Preferred provider'}) as HTMLSelectElement;
    for (const provider of ['claude', 'codex', 'gemini', 'qwen', 'glm', 'nvidia'] as ProviderId[]) {
      select.append(h('option', {value: provider}, [provider]));
    }
    select.value = selected;
    return select;
  };
  const ticketPrompt = (task: typeof state.tasks[number]) => [
    `You are the ${task.role || 'implementation'} specialist for this Fluent Code project.`,
    '',
    'Project direction:',
    state.masterBrief || 'No master brief has been set. Work only from the ticket and inspect the repository before changing files.',
    '',
    `Assigned ticket: ${task.title}`,
    task.description ? `Ticket details:\n${task.description}` : 'Ticket details: inspect the relevant code and make the smallest complete change.',
    ...(task.dependsOn?.length ? [
      `Prerequisites: ${task.dependsOn.map(id => {
        const dependency = state.tasks.find(candidate => candidate.id === id);
        return dependency ? `${dependency.title} (${dependency.status})` : `${id.slice(0, 8)} (missing)`;
      }).join(', ')}`
    ] : []),
    ...(task.designHandoff ? [
      '',
      'Design-to-build handoff:',
      task.designHandoff.sourceRef ? `Source mapping: ${task.designHandoff.sourceRef}` : '',
      task.designHandoff.componentSpec ? `Component specification: ${task.designHandoff.componentSpec}` : '',
      task.designHandoff.tokenSpec ? `Token specification: ${task.designHandoff.tokenSpec}` : '',
      task.designHandoff.previewUrl ? `Local preview: ${task.designHandoff.previewUrl}` : '',
      task.designHandoff.implementationPaths?.length ? `Intended implementation paths (claim before editing): ${task.designHandoff.implementationPaths.join(', ')}` : ''
    ].filter(Boolean) : []),
    '',
    'Keep your context focused on this ticket. Coordinate file claims and handoffs through Fluent when needed; do not take unrelated work. Before reporting completion, run the relevant checks and state changed files, verification, and any handoff needed.'
  ].join('\n');

  const boardNotice = h('p', {class: 'section-sub orchestration-notice'}, [
    'Create a ticket, then deliberately assign a live lane or launch a clean isolated lane. Provider choice and role remain visible on the ticket.'
  ]);
  const masterBrief = h('textarea', {
    class: 'orchestration-master-brief',
    placeholder: 'Master brief: product goal, constraints, acceptance criteria, and relevant links',
    rows: '5'
  }) as HTMLTextAreaElement;
  masterBrief.value = state.masterBrief ?? '';
  const saveBrief = h('button', {class: 'btn primary', type: 'button'}, ['save master brief']);
  saveBrief.addEventListener('click', async () => {
    saveBrief.disabled = true;
    try {
      await api.setMasterBrief(project, masterBrief.value);
      void render();
    } catch (error: unknown) {
      boardNotice.textContent = error instanceof Error ? error.message : 'Could not save the master brief';
      boardNotice.className = 'error orchestration-notice';
    } finally {
      saveBrief.disabled = false;
    }
  });

  const ticketTitle = h('input', {type: 'text', placeholder: 'ticket title, e.g. implement account settings'}) as HTMLInputElement;
  const ticketRole = h('input', {type: 'text', placeholder: 'role, e.g. frontend'}) as HTMLInputElement;
  const ticketProvider = providerSelect('codex');
  const ticketDescription = h('textarea', {placeholder: 'Ticket-local brief, constraints, and acceptance checks', rows: '4'}) as HTMLTextAreaElement;
  const ticketDependencies = h('select', {multiple: 'multiple', 'aria-label': 'Ticket prerequisites'}) as HTMLSelectElement;
  for (const task of state.tasks) {
    ticketDependencies.append(h('option', {value: task.id}, [`${task.status} · ${task.id.slice(0, 8)} · ${task.title}`]));
  }
  const createTicket = h('button', {class: 'btn primary', type: 'button'}, ['create ticket']);
  createTicket.addEventListener('click', async () => {
    if (!ticketTitle.value.trim()) return ticketTitle.focus();
    createTicket.disabled = true;
    try {
      await api.createTask(project, {
        title: ticketTitle.value,
        description: ticketDescription.value,
        role: ticketRole.value,
        provider: ticketProvider.value as ProviderId,
        source: 'manual',
        dependsOn: [...ticketDependencies.selectedOptions].map(option => option.value)
      });
      void render();
    } catch (error: unknown) {
      boardNotice.textContent = error instanceof Error ? error.message : 'Could not create ticket';
      boardNotice.className = 'error orchestration-notice';
    } finally {
      createTicket.disabled = false;
    }
  });

  const specPath = h('input', {type: 'text', placeholder: 'choose a .md, .mdx, .txt, or .rst spec file'}) as HTMLInputElement;
  const browseSpec = h('button', {class: 'btn directory-browse', type: 'button'}, ['choose spec…']);
  browseSpec.addEventListener('click', async () => {
    browseSpec.disabled = true;
    try {
      const selected = await pickSpecFile('Choose specification document', specPath.value);
      if (selected) specPath.value = selected;
    } finally {
      browseSpec.disabled = false;
    }
  });
  const plannerProvider = providerSelect('claude');
  const launchPlanner = h('button', {class: 'btn primary', type: 'button'}, ['launch spec planner']);
  launchPlanner.addEventListener('click', async () => {
    if (!specPath.value.trim()) return specPath.focus();
    launchPlanner.disabled = true;
    try {
      const plannerState = await api.createTask(project, {
        title: `Plan spec: ${workspaceFolderName(specPath.value)}`,
        description: `Read and break down the selected specification: ${specPath.value.trim()}`,
        role: 'master orchestrator',
        provider: plannerProvider.value as ProviderId,
        source: 'planner'
      });
      const plannerTask = plannerState.tasks[0]!;
      const plannerPrompt = [
        'You are the master orchestration planner for this project.',
        '',
        `Read this local specification file: ${specPath.value.trim()}`,
        'If the path is inaccessible, say so and ask for the relevant text rather than guessing.',
        '',
        'Project direction:',
        plannerState.masterBrief || 'No master brief has been saved yet.',
        '',
        'Break the specification into small, independently verifiable Kanban tickets. For each, recommend a role and provider, call out file or dependency risks, and avoid doing implementation yourself. Use Fluent coordination tools to create the tickets when available; otherwise produce the numbered breakdown for the user to review.'
      ].join('\n');
      const session = await api.createSession({
        provider: plannerProvider.value as ProviderId,
        directory: project,
        task: plannerPrompt,
        isolate: true
      });
      await api.assignTask(project, plannerTask.id, {
        sessionId: session.id,
        provider: plannerProvider.value as ProviderId,
        role: 'master orchestrator'
      });
      void render();
    } catch (error: unknown) {
      boardNotice.textContent = error instanceof Error ? error.message : 'Could not launch the spec planner';
      boardNotice.className = 'error orchestration-notice';
    } finally {
      launchPlanner.disabled = false;
    }
  });

  const taskColumns: Array<{status: 'todo' | 'active' | 'done'; label: string}> = [
    {status: 'todo', label: 'ready'}, {status: 'active', label: 'in progress'}, {status: 'done', label: 'complete'}
  ];
  const activeLanes = sessions.filter(session => (session.projectDirectory ?? session.directory) === project && (session.status === 'running' || session.status === 'starting'));
  const ticketColumns = taskColumns.map(column => {
    const tickets = state.tasks.filter(task => task.status === column.status);
    const cards = tickets.length === 0
      ? [h('p', {class: 'section-sub kanban-empty'}, ['No tickets'])]
      : tickets.map(task => {
          const dependencies = (task.dependsOn ?? []).map(id => state.tasks.find(candidate => candidate.id === id));
          const blockers = dependencies.filter(dependency => !dependency || dependency.status !== 'done');
          const blocked = blockers.length > 0;
          const lanePicker = h('select', {'aria-label': `Assign ${task.title} to a running lane`}) as HTMLSelectElement;
          lanePicker.append(h('option', {value: ''}, ['choose running lane']));
          for (const lane of activeLanes) lanePicker.append(h('option', {value: lane.id}, [`${lane.provider} · ${lane.id.slice(0, 8)} · ${lane.task || 'untitled lane'}`]));
          if (task.sessionId && activeLanes.some(lane => lane.id === task.sessionId)) lanePicker.value = task.sessionId;
          const assignExisting = h('button', {class: 'btn', type: 'button'}, ['assign & brief']);
          assignExisting.disabled = activeLanes.length === 0 || blocked;
          assignExisting.addEventListener('click', async () => {
            const sessionId = lanePicker.value;
            if (!sessionId) return lanePicker.focus();
            assignExisting.disabled = true;
            try {
              // Delivery first: the board never claims a lane has a ticket if its terminal did not
              // accept the focused brief.
              await api.inject(sessionId, ticketPrompt(task));
              const lane = activeLanes.find(candidate => candidate.id === sessionId);
              await api.assignTask(project, task.id, {sessionId, provider: lane?.provider ?? task.provider, role: task.role});
              void render();
            } catch (error: unknown) {
              boardNotice.textContent = error instanceof Error ? error.message : 'Could not assign this lane';
              boardNotice.className = 'error orchestration-notice';
            } finally {
              assignExisting.disabled = false;
            }
          });
          const launch = h('button', {class: 'btn primary', type: 'button'}, ['launch clean lane']);
          launch.disabled = blocked;
          launch.addEventListener('click', async () => {
            const provider = task.provider ?? 'codex';
            launch.disabled = true;
            try {
              const session = await api.createSession({provider, directory: project, task: ticketPrompt(task), isolate: true});
              await api.assignTask(project, task.id, {sessionId: session.id, provider, role: task.role});
              void render();
            } catch (error: unknown) {
              boardNotice.textContent = error instanceof Error ? error.message : 'Could not launch this lane';
              boardNotice.className = 'error orchestration-notice';
            } finally {
              launch.disabled = false;
            }
          });
          const nextStatus = task.status === 'todo' ? 'active' : task.status === 'active' ? 'done' : 'todo';
          const advance = h('button', {class: 'btn', type: 'button'}, [task.status === 'todo' ? 'start' : task.status === 'active' ? 'mark done' : 'reopen']);
          advance.disabled = task.status === 'todo' && blocked;
          advance.addEventListener('click', async () => { await api.updateTask(project, task.id, nextStatus, task.sessionId); void render(); });
          const review = h('button', {class: 'btn', type: 'button'}, ['review lane']);
          review.disabled = !task.sessionId;
          review.addEventListener('click', () => task.sessionId && navigate({name: 'active-session', sessionId: task.sessionId}));
          const dependencyPicker = h('select', {multiple: 'multiple', 'aria-label': `Set prerequisites for ${task.title}`}) as HTMLSelectElement;
          for (const candidate of state.tasks) {
            if (candidate.id === task.id) continue;
            dependencyPicker.append(h('option', {value: candidate.id}, [`${candidate.status} · ${candidate.id.slice(0, 8)} · ${candidate.title}`]));
          }
          for (const option of dependencyPicker.options) option.selected = Boolean(task.dependsOn?.includes(option.value));
          const saveDependencies = h('button', {class: 'btn', type: 'button'}, ['save prerequisites']);
          saveDependencies.disabled = task.status !== 'todo';
          saveDependencies.addEventListener('click', async () => {
            saveDependencies.disabled = true;
            try {
              await api.setTaskDependencies(project, task.id, [...dependencyPicker.selectedOptions].map(option => option.value));
              void render();
            } catch (error: unknown) {
              boardNotice.textContent = error instanceof Error ? error.message : 'Could not save task prerequisites';
              boardNotice.className = 'error orchestration-notice';
            } finally {
              saveDependencies.disabled = task.status !== 'todo';
            }
          });
          const edit = h('button', {class: 'btn', type: 'button'}, ['edit']);
          const remove = h('button', {class: 'btn danger', type: 'button'}, ['delete']);
          const editTitle = h('input', {type: 'text', value: task.title, 'aria-label': `Title for ${task.title}`}) as HTMLInputElement;
          const editRole = h('input', {type: 'text', value: task.role ?? '', placeholder: 'role, e.g. frontend', 'aria-label': `Role for ${task.title}`}) as HTMLInputElement;
          const editDescription = h('textarea', {rows: '3', placeholder: 'ticket-local brief', 'aria-label': `Brief for ${task.title}`}) as HTMLTextAreaElement;
          editDescription.value = task.description ?? '';
          const saveEdit = h('button', {class: 'btn primary', type: 'button'}, ['save ticket']);
          const cancelEdit = h('button', {class: 'btn', type: 'button'}, ['cancel']);
          const editor = h('div', {class: 'kanban-editor'}, [editTitle, editRole, editDescription, h('div', {class: 'actions'}, [cancelEdit, saveEdit])]);
          editor.hidden = true;
          edit.addEventListener('click', () => { editor.hidden = !editor.hidden; });
          cancelEdit.addEventListener('click', () => { editor.hidden = true; });
          saveEdit.addEventListener('click', async () => {
            saveEdit.disabled = true;
            try {
              await api.editTask(project, task.id, {title: editTitle.value, description: editDescription.value, role: editRole.value});
              void render();
            } catch (error: unknown) {
              boardNotice.textContent = actionErrorText(error);
              boardNotice.className = 'error orchestration-notice';
              saveEdit.disabled = false;
            }
          });
          remove.addEventListener('click', async () => {
            if (!(await askConfirm({title: 'delete ticket', body: `Delete “${task.title}” from the board? Tickets that list it as a prerequisite stop waiting for it. A lane already working on it keeps running.`, confirmLabel: 'delete ticket', danger: true}))) return;
            try {
              await api.deleteTask(project, task.id);
              void render();
            } catch (error: unknown) {
              boardNotice.textContent = actionErrorText(error);
              boardNotice.className = 'error orchestration-notice';
            }
          });
          const prerequisiteSummary = blocked
            ? `blocked by ${blockers.map(dependency => dependency ? `${dependency.title} (${dependency.status})` : 'a missing ticket').join(' · ')}`
            : `prerequisites complete · ${dependencies.filter((dependency): dependency is NonNullable<typeof dependency> => Boolean(dependency)).map(dependency => dependency.title).join(' · ')}`;
          return h('article', {class: 'kanban-ticket'}, [
            h('div', {class: 'kanban-ticket-head'}, [h('strong', {}, [task.title]), h('span', {class: 'pill'}, [task.source ?? 'manual'])]),
            task.description ? h('p', {class: 'section-sub'}, [task.description]) : h('p', {class: 'section-sub'}, ['No ticket-local brief yet.']),
            ...(task.dependsOn?.length ? [h('p', {class: blocked ? 'error' : 'section-sub'}, [prerequisiteSummary])] : []),
            ...(task.designHandoff ? [h('p', {class: 'section-sub'}, [
              [
                task.designHandoff.sourceRef ? `source ${task.designHandoff.sourceRef}` : '',
                task.designHandoff.previewUrl ? `preview ${task.designHandoff.previewUrl}` : '',
                task.designHandoff.implementationPaths?.length ? `${task.designHandoff.implementationPaths.length} intended path${task.designHandoff.implementationPaths.length === 1 ? '' : 's'}` : ''
              ].filter(Boolean).join(' · ')
            ])] : []),
            h('p', {class: 'kanban-meta'}, [`${task.role || 'generalist'} · ${task.provider || 'provider undecided'}${task.sessionId ? ` · lane ${task.sessionId.slice(0, 8)}` : ''}`]),
            h('div', {class: 'kanban-assignment'}, [lanePicker, assignExisting]),
            h('div', {class: 'kanban-assignment'}, [dependencyPicker, saveDependencies]),
            h('div', {class: 'kanban-actions'}, [launch, review, advance, edit, remove]),
            editor
          ]);
        });
    return h('section', {class: 'kanban-column'}, [h('div', {class: 'kanban-column-head'}, [h('h3', {}, [column.label]), h('span', {class: 'meta'}, [String(tickets.length)])]), ...cards]);
  });
  const sourceControl = h('button', {class: 'btn', type: 'button'}, ['open source control']);
  sourceControl.addEventListener('click', () => navigate({name: 'source-control'}));
  main.append(h('section', {class: 'orchestration-command card'}, [
    h('div', {class: 'orchestration-command-head'}, [
      h('div', {}, [h('h2', {}, ['orchestration command center']), h('p', {class: 'section-sub'}, ['Master direction stays on the board. Each named specialist lane receives a clean, accountable ticket prompt.'])]),
      sourceControl
    ]),
    boardNotice,
    h('div', {class: 'orchestration-composer-grid'}, [
      h('div', {class: 'orchestration-panel'}, [h('h3', {}, ['master brief']), masterBrief, h('div', {class: 'actions'}, [saveBrief])]),
      h('div', {class: 'orchestration-panel'}, [h('h3', {}, ['new ticket']), ticketTitle, h('div', {class: 'orchestration-form-row'}, [ticketRole, ticketProvider]), ticketDescription, h('label', {class: 'section-sub'}, ['prerequisites (optional)', ticketDependencies]), h('div', {class: 'actions'}, [createTicket])]),
      h('div', {class: 'orchestration-panel'}, [h('h3', {}, ['spec → Kanban planner']), h('p', {class: 'section-sub'}, ['Starts an isolated planner with this file path and the saved brief. It creates a visible planner ticket first.']), h('div', {class: 'directory-field'}, [specPath, browseSpec]), h('div', {class: 'orchestration-form-row'}, [plannerProvider, launchPlanner])])
    ]),
    h('div', {class: 'kanban-board'}, ticketColumns)
  ]));
  const scopeLabels: Record<ExplorerScope, string> = {overview: 'overview', tasks: 'tasks', files: 'files', reviews: 'reviews'};
  const scopeButtons = (Object.keys(scopeLabels) as ExplorerScope[]).map(scope => {
    const button = h('button', {
      class: `scope-button${explorerScope === scope ? ' active' : ''}`,
      type: 'button',
      'aria-pressed': explorerScope === scope ? 'true' : 'false'
    }, [scopeLabels[scope]]);
    button.addEventListener('click', () => { setExplorerScope(scope); void render(); });
    return button;
  });
  const relatedRows = (label: string, rows: HTMLElement[]) => rows.length > 0
    ? h('div', {class: 'relationship-group'}, [h('h4', {}, [label]), ...rows])
    : undefined;
  const inspectionBody: HTMLElement[] = [];
  if (inspection) {
    inspectionBody.push(
      h('h3', {}, ['inspect relationship']),
      h('p', {class: 'inspector-title'}, [inspection.title]),
      h('p', {class: 'section-sub'}, [inspection.relationshipNote])
    );
    const relationshipGroups = [
      relatedRows('lanes', [
        ...inspection.lanes.map(lane => h('div', {class: 'relationship-row'}, [
          selectSubject(`${lane.provider} · ${lane.id.slice(0, 8)} · ${lane.status}`, {kind: 'lane', sessionId: lane.id}),
          verificationPill(lane.verification)
        ])),
        ...inspection.missingLaneIds.map(id => h('p', {class: 'meta relationship-missing'}, [`${id.slice(0, 8)} · no longer in this session snapshot`]))
      ]),
      relatedRows('tasks', inspection.tasks.map(task => h('div', {class: 'relationship-row'}, [
        selectSubject(task.title, {kind: 'task', id: task.id}),
        h('span', {class: 'meta'}, [task.status])
      ]))),
      relatedRows('claims', inspection.claims.map(claim => h('div', {class: 'relationship-row'}, [
        selectSubject(claim.path, {kind: 'claim', id: claim.id}),
        h('span', {class: 'meta'}, [claim.origin])
      ]))),
      relatedRows('handoffs', inspection.handoffs.map(handoff => h('div', {class: 'relationship-row'}, [
        selectSubject(handoff.summary, {kind: 'handoff', id: handoff.id}),
        h('span', {class: 'meta'}, [handoff.status])
      ]))),
      relatedRows('lane messages', inspection.messages.map(message => h('div', {class: 'relationship-row'}, [
        selectSubject(message.body, {kind: 'message', id: message.id}),
        h('span', {class: 'meta'}, [`${message.from.slice(0, 8)} → ${message.to.slice(0, 8)}${message.readAt ? ' · read' : ''}`])
      ]))),
      relatedRows('decisions', inspection.decisions.map(decision => h('div', {class: 'relationship-row'}, [
        selectSubject(decision.summary, {kind: 'decision', id: decision.id})
      ]))),
      relatedRows('path overlaps', inspection.conflicts.map(conflict => h('div', {class: 'relationship-row'}, [
        selectSubject(`${conflict.path} ↔ ${conflict.claimedPath}`, {kind: 'conflict', path: conflict.path, claimedPath: conflict.claimedPath, sessionId: conflict.sessionId}),
        h('span', {class: conflict.hotspot ? 'error' : 'meta'}, [conflict.hotspot ? 'hotspot' : conflict.overlap])
      ])))
    ];
    for (const group of relationshipGroups) if (group) inspectionBody.push(group);
  } else {
    inspectionBody.push(
      h('h3', {}, ['inspect relationship']),
      h('p', {class: 'section-sub'}, ['Select a lane, task, claim, handoff, decision, message, or overlap to see the records related in this current board.'])
    );
  }
  const activity = retainedCoordinationHistory(state, 8);
  const activityRows = activity.length > 0
    ? activity.map(item => h('div', {class: 'activity-row'}, [
        h('span', {class: 'activity-time'}, [Number.isFinite(Date.parse(item.at)) ? relativeTime(item.at) : 'time unavailable']),
        h('span', {class: 'activity-kind'}, [item.label]),
        item.subject ? selectSubject(item.detail, item.subject) : h('span', {class: 'activity-detail'}, [item.detail])
      ]))
    : [h('p', {class: 'section-sub'}, ['No retained coordination events yet.'])];
  main.append(h('section', {class: 'coordination-explorer'}, [
    h('div', {class: 'explorer-header'}, [
      h('div', {}, [
        h('h2', {}, ['coordination explorer']),
        h('p', {class: 'section-sub'}, ['Personal saved view · derived from the current project board · never shared with agents'])
      ]),
      h('div', {class: 'scope-tabs', role: 'group', 'aria-label': 'Saved coordination views'}, scopeButtons)
    ]),
    h('div', {class: 'explorer-grid'}, [
      h('div', {class: 'card coordination-inspector'}, inspectionBody),
      (explorerScope === 'overview' || explorerScope === 'reviews')
        ? h('div', {class: 'card current-record-activity'}, [
            h('h3', {}, ['retained coordination history']),
            h('p', {class: 'section-sub'}, ['Meaningful board changes only. This is not terminal history, a provider transcript, or an audit log.']),
            ...activityRows
          ])
        : h('div', {class: 'card current-record-activity'}, [
            h('h3', {}, ['focused view']),
            h('p', {class: 'section-sub'}, [explorerScope === 'tasks'
              ? 'Task and decision controls stay visible below.'
              : 'Claims, overlap signals, and release controls stay visible below.'])
          ])
    ])
  ]));
  const taskRows = state.tasks.map(task => {
    const next = task.status === 'todo' ? 'start' : task.status === 'active' ? 'mark done' : 'reopen';
    const nextStatus = task.status === 'todo' ? 'active' : task.status === 'active' ? 'done' : 'todo';
    const button = h('button', {class: 'btn'}, [next]);
    button.addEventListener('click', async () => { await api.updateTask(project, task.id, nextStatus, task.sessionId); void render(); });
    return h('div', {class: 'option-row'}, [selectSubject(task.title, {kind: 'task', id: task.id}), h('span', {class: 'meta'}, [task.status]), button]);
  });
  const handoffRows = state.handoffs.map(handoff => {
    const accept = h('button', {class: 'btn'}, ['accept']);
    accept.disabled = handoff.status !== 'open';
    accept.addEventListener('click', async () => { await api.acceptHandoff(project, handoff.id); void render(); });
    const decline = h('button', {class: 'btn'}, ['decline']);
    decline.disabled = handoff.status !== 'open';
    decline.addEventListener('click', async () => { await api.declineHandoff(project, handoff.id); void render(); });
    return h('div', {class: 'option-row'}, [selectSubject(handoff.summary, {kind: 'handoff', id: handoff.id}), h('span', {class: 'meta'}, [`${handoff.fromSessionId.slice(0, 6)} → ${handoff.toSessionId.slice(0, 6)} · ${handoff.status}`]), h('div', {class: 'actions'}, [accept, decline])]);
  });
  const claimRows = state.claims.map(claim => {
    const release = h('button', {class: 'btn'}, ['release']);
    release.addEventListener('click', async () => { await api.releaseClaim(project, claim.path, claim.sessionId); void render(); });
    return h('div', {class: 'option-row'}, [selectSubject(claim.path, {kind: 'claim', id: claim.id}), h('span', {class: 'meta'}, [`${claim.sessionId.slice(0, 8)} · ${claim.origin}`]), release]);
  });
  // Overlaps read as their own card rather than as decoration on the claims list: an overlap is a
  // thing to act on now, while both lanes are still working, not a property of one claim.
  const conflictRows = conflicts.length === 0
    ? [h('p', {class: 'section-sub'}, ['0 open conflicts — no two lanes are touching the same paths.'])]
    : conflicts.map(conflict => h('div', {class: 'option-row'}, [
        selectSubject(conflict.overlap === 'same' ? conflict.path : `${conflict.path} ↔ ${conflict.claimedPath}`, {kind: 'conflict', path: conflict.path, claimedPath: conflict.claimedPath, sessionId: conflict.sessionId}),
        h('span', {class: conflict.hotspot ? 'error' : 'meta'}, [conflict.hotspot ? `hotspot · also held by ${conflict.sessionId.slice(0, 8)}` : `also held by ${conflict.sessionId.slice(0, 8)}`])
      ]));
  const workbenchCards: HTMLElement[] = [];
  if (explorerScope === 'overview' || explorerScope === 'tasks') {
    workbenchCards.push(
      h('div', {class: 'card'}, [h('h3', {}, ['shared task board']), ...taskRows, h('div', {class: 'field'}, [taskInput, addTask])]),
      h('div', {class: 'card'}, [
        h('h3', {}, ['project memory']),
        ...state.decisions.map(decision => h('div', {class: 'option-row'}, [selectSubject(decision.summary || 'decision', {kind: 'decision', id: decision.id})])),
        h('div', {class: 'field'}, [decisionInput, decisionButton])
      ])
    );
  }
  if (explorerScope === 'overview' || explorerScope === 'files') {
    workbenchCards.push(
      h('div', {class: 'card'}, [h('h3', {}, ['file overlaps']), ...conflictRows]),
      h('div', {class: 'card'}, [h('h3', {}, ['file claims']), ...claimRows, h('div', {class: 'field'}, [claimInput, claimLane, claimButton, claimNotice])])
    );
  }
  if (explorerScope === 'overview' || explorerScope === 'reviews') {
    workbenchCards.push(h('div', {class: 'card'}, [h('h3', {}, ['handoffs & review']), ...handoffRows, h('div', {class: 'field'}, [handoffInput, handoffFrom, handoffTo, handoffButton, handoffNotice])]));
  }
  main.append(h('div', {class: 'cards-row'}, workbenchCards));

  // Lanes talking to each other is coordination, so it is shown like every other kind: visible by
  // default, never something happening out of sight (spec §2 principle 3).
  const messageRows = state.messages.length === 0
    ? [h('p', {class: 'section-sub'}, ['No messages between lanes yet — an agent sends one with `fluent-coord send`.'])]
    : [...state.messages].reverse().slice(0, 12).map(message => h('div', {class: 'option-row'}, [
        selectSubject(message.body, {kind: 'message', id: message.id}),
        h('span', {class: 'meta'}, [`${message.from.slice(0, 8)} → ${message.to.slice(0, 8)} · ${message.readAt ? 'read' : 'unread'}`])
      ]));

  const missingSkill = skills.filter(skill => !skill.current || skill.mcpConfigured !== true);
  const installButton = h('button', {class: 'btn primary'}, [skills.some(skill => skill.installed) ? 'update coordination bundle' : 'install coordination bundle']);
  const installNotice = h('p', {class: 'section-sub'}, [
    missingSkill.length === 0
      ? 'Every installed provider has the current skill and compact MCP coordination tool.'
      : `${missingSkill.map(skill => skill.provider).join(' and ')} ${missingSkill.length === 1 ? 'is' : 'are'} missing part of the coordination bundle. Installing writes user-scoped skills and MCP configuration only; it never touches this repository.`
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
    if (!(await askConfirm({title: 'run the eval suite', body: costSentence, confirmLabel: 'run evals'}))) return;
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

  const messageLane = lanePicker('Lane to message');
  const messageBody = h('textarea', {rows: '2', placeholder: 'message a lane — it reads this when it next checks its inbox', 'aria-label': 'Message to lane'}) as HTMLTextAreaElement;
  const sendMessage = h('button', {class: 'btn', type: 'button'}, ['send message']);
  sendMessage.disabled = live.length === 0;
  const messageNotice = h('p', {class: 'section-sub'}, []);
  sendMessage.addEventListener('click', async () => {
    if (!messageBody.value.trim() || !messageLane.value) return messageBody.focus();
    sendMessage.disabled = true;
    try {
      await api.sendLaneMessage(project, messageLane.value, messageBody.value);
      void render();
    } catch (error: unknown) {
      messageNotice.textContent = actionErrorText(error);
      messageNotice.className = 'error';
      sendMessage.disabled = false;
    }
  });

  const supportCards: HTMLElement[] = [];
  if (explorerScope === 'overview' || explorerScope === 'reviews') {
    const verificationRows = live.length > 0
      ? live.map(lane => h('div', {class: 'option-row'}, [
          selectSubject(`${lane.provider} · ${lane.id.slice(0, 8)}`, {kind: 'lane', sessionId: lane.id}),
          verificationPill(lane.verification)
        ]))
      : [h('p', {class: 'section-sub'}, ['No running lanes in this project.'])];
    supportCards.push(
      h('div', {class: 'card'}, [h('h3', {}, ['lane messages']), ...messageRows, h('div', {class: 'field'}, [messageLane, messageBody, sendMessage, messageNotice])]),
      h('div', {class: 'card'}, [h('h3', {}, ['current lane verification']), ...verificationRows])
    );
  }
  if (explorerScope === 'overview') {
    supportCards.push(
      h('div', {class: 'card'}, [h('h3', {}, ['collaboration skill']), installNotice, h('div', {class: 'field'}, [installButton])]),
      h('div', {class: 'card'}, [h('h3', {}, ['eval suite']), evalSummary, ...evalRows, evalNotice, h('div', {class: 'field'}, [evalButton])])
    );
  }
  if (supportCards.length > 0) main.append(h('div', {class: 'cards-row'}, supportCards));
}

// --- Design workspace & visual check ----------------------------------------

async function renderDesignWorkspace(main: HTMLElement) {
  const sessions = await api.listSessions();
  const project = currentProject(workspacePath, sessions);
  const [openDesign, openDesignStatus] = await Promise.all([
    api.openDesign().catch(() => ({url: 'http://127.0.0.1:7456', enabled: false})),
    api.openDesignStatus().catch(() => ({url: 'http://127.0.0.1:7456', enabled: false, reachable: false, status: undefined, error: 'fluentd could not check OpenDesign'}))
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
    openDesignStatus.reachable
      ? `OpenDesign connected · HTTP ${openDesignStatus.status ?? 'ok'}${openDesign.enabled ? ' · embedding enabled' : ' · embedding disabled until you save this origin'}`
      : `OpenDesign is not running at this URL${openDesignStatus.error ? ` · ${openDesignStatus.error}` : ''}`
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
          if (!(await askConfirm({title: `install OpenDesign MCP for ${target}`, body: `OpenDesign will update ${target}'s MCP configuration.`, confirmLabel: 'install'}))) return;
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
  if (openDesignStatus.reachable && openDesign.enabled) {
    const openOpenDesign = h('button', {class: 'btn primary', type: 'button'}, ['open OpenDesign']);
    const openNotice = h('p', {class: 'section-sub'}, ['This saved local origin opens in a separate guarded window. It cannot navigate to another origin or receive Fluent’s desktop privileges.']);
    openOpenDesign.addEventListener('click', async () => {
      openOpenDesign.disabled = true;
      try {
        const origin = await api.openEmbeddedContent('open-design', openDesign.url);
        openNotice.textContent = `OpenDesign is open at ${origin}.`;
        openNotice.className = 'success';
      } catch (error) {
        openNotice.textContent = `OpenDesign could not open: ${actionErrorText(error)}`;
        openNotice.className = 'error';
      } finally {
        openOpenDesign.disabled = false;
      }
    });
    main.append(h('div', {class: 'card'}, [
      h('div', {class: 'toolbar'}, [h('div', {}, [h('h3', {}, ['OpenDesign']), h('p', {class: 'section-sub'}, ['Edit in its guarded local window, then create a repository-bound implementation handoff here.'])]), openOpenDesign]),
      openNotice
    ]));
  }
  if (!project) {
    main.append(h('div', {class: 'empty-state'}, ['Start a session to bind design work and implementation handoffs to a repository.']));
    return;
  }
  const state = await api.coordination(project);
  const designLanes = sessions.filter(session => (session.projectDirectory ?? session.directory) === project && session.status === 'running');
  const title = h('input', {type: 'text', placeholder: 'design task, e.g. credential fallback states'}) as HTMLInputElement;
  const sourceRef = h('input', {type: 'text', value: 'design/pen/fluent-code.pen', placeholder: 'repo-relative source, e.g. design/pen/fluent-code.pen'}) as HTMLInputElement;
  const componentSpec = h('textarea', {placeholder: 'component specification', rows: '2'}) as HTMLTextAreaElement;
  const tokenSpec = h('textarea', {placeholder: 'token and interaction notes', rows: '2'}) as HTMLTextAreaElement;
  const previewUrl = h('input', {type: 'url', placeholder: 'local preview, e.g. http://127.0.0.1:4173'}) as HTMLInputElement;
  const paths = h('textarea', {placeholder: 'intended implementation paths, one per line', rows: '3'}) as HTMLTextAreaElement;
  const owner = h('select', {'aria-label': 'Design handoff owner'}) as HTMLSelectElement;
  owner.append(h('option', {value: ''}, ['assign later — no lane']));
  for (const lane of designLanes) owner.append(h('option', {value: lane.id}, [`${lane.provider} · ${lane.id.slice(0, 8)}`]));
  const reviewer = h('select', {'aria-label': 'Design handoff reviewer'}) as HTMLSelectElement;
  reviewer.append(h('option', {value: ''}, ['no reviewer handoff yet']));
  for (const lane of designLanes) reviewer.append(h('option', {value: lane.id}, [`${lane.provider} · ${lane.id.slice(0, 8)}`]));
  const reservePaths = h('input', {type: 'checkbox'}) as HTMLInputElement;
  const designNotice = h('p', {class: 'section-sub'}, ['Intended paths are not claims. Reserve them only for the selected active lane.']);
  const add = h('button', {class: 'btn primary'}, ['create design task']);
  add.addEventListener('click', async () => {
    if (!title.value.trim()) return title.focus();
    if (reservePaths.checked && !owner.value) {
      designNotice.textContent = 'Choose an active owner before reserving files.';
      designNotice.className = 'error';
      return owner.focus();
    }
    if (reviewer.value && (!owner.value || reviewer.value === owner.value)) {
      designNotice.textContent = 'A reviewer handoff needs a different active owner and reviewer.';
      designNotice.className = 'error';
      return reviewer.focus();
    }
    add.disabled = true;
    try {
      const implementationPaths = paths.value.split(/[,\n]/).map(path => path.trim()).filter(Boolean);
      await api.createTask(project, {
        title: `design: ${title.value.trim()}`,
        role: 'design',
        source: 'manual',
        sessionId: owner.value || undefined,
        designHandoff: {
          sourceRef: sourceRef.value,
          componentSpec: componentSpec.value,
          tokenSpec: tokenSpec.value,
          previewUrl: previewUrl.value,
          implementationPaths
        }
      });
      const claims: string[] = [];
      if (reservePaths.checked && owner.value) {
        for (const path of implementationPaths) {
          const result = await api.claimFile(project, path, owner.value);
          claims.push(result.granted ? `${path} reserved` : `${path} overlaps an existing claim`);
        }
      }
      if (reviewer.value && owner.value) await api.createHandoff(project, owner.value, reviewer.value, `Design review: ${title.value.trim()} (${sourceRef.value.trim() || 'source not recorded'})`);
      designNotice.textContent = [
        'Design task created.',
        claims.length ? claims.join(' · ') : '',
        reviewer.value ? 'Review handoff proposed.' : ''
      ].filter(Boolean).join(' ');
      designNotice.className = 'success';
      void render();
    } catch (error: unknown) {
      designNotice.textContent = error instanceof Error ? error.message : 'Could not create design task';
      designNotice.className = 'error';
    } finally {
      add.disabled = false;
    }
  });
  main.append(h('div', {class: 'cards-row'}, [
    h('div', {class: 'card'}, [
      h('h3', {}, ['design tasks']),
      ...state.tasks.filter(task => task.title.startsWith('design:')).map(task => h('div', {class: 'option-row'}, [
        h('span', {class: 'label'}, [`● ${task.title.slice(8)}`]),
        h('span', {class: 'meta'}, [`${task.status}${task.designHandoff?.sourceRef ? ` · ${task.designHandoff.sourceRef}` : ''}${task.designHandoff?.implementationPaths?.length ? ` · ${task.designHandoff.implementationPaths.length} paths` : ''}`])
      ])),
      h('div', {class: 'field'}, [title, sourceRef, componentSpec, tokenSpec, previewUrl, paths, owner, reviewer, h('label', {class: 'section-sub'}, [reservePaths, ' reserve intended paths for owner']), add, designNotice])
    ]),
    h('div', {class: 'card'}, [
      h('h3', {}, ['handoff contract']),
      h('p', {class: 'section-sub'}, ['Each design task records its source, component and token notes, loopback preview, and intended implementation paths. Claims stay advisory and lane-owned.']),
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
  const previewSessions = await api.listSessions();
  const project = currentProject(workspacePath, previewSessions);
  let recipes: RecipeDefinition[] = [];
  let receipts: RecipeReceipt[] = [];
  let recipeError: string | undefined;
  if (project) {
    try {
      [recipes, receipts] = await Promise.all([api.listRecipes(project), api.recipeReceipts(project)]);
    } catch (error) {
      recipeError = error instanceof Error ? error.message : String(error);
    }
  }
  const stored = localStorage.getItem('fluent.preview-url');
  const urlInput = h('input', {type: 'url', value: stored ?? 'http://localhost:3000', placeholder: 'http://localhost:3000'});
  const open = h('button', {class: 'btn primary'}, ['open preview']);
  const status = h('p', {class: 'section-sub'}, [stored ? `last selected preview: ${stored}` : 'Choose one local origin to open in a guarded preview window. Fluent never proxies preview traffic.']);
  const previewNotice = h('div', {class: 'preview-empty'}, [
    h('strong', {}, ['local preview opens in a guarded window']),
    h('p', {}, ['The window allows only the exact loopback origin you select. Its redirects and pop-ups cannot leave that origin.'])
  ]);
  open.addEventListener('click', async () => {
    const value = urlInput.value.trim();
    open.disabled = true;
    try {
      const origin = await api.openEmbeddedContent('preview', value);
      localStorage.setItem('fluent.preview-url', origin);
      status.textContent = `preview open at ${origin}`;
      status.className = 'success';
    } catch (error) {
      status.textContent = `for safety, ${actionErrorText(error)}`;
      status.className = 'error';
    } finally {
      open.disabled = false;
    }
  });
  const inspect = h('button', {class: 'btn'}, ['create visual-check task']);
  inspect.addEventListener('click', () => navigate({name: 'design'}));
  const recipeCard = h('div', {class: 'card'}, [
    h('h3', {}, ['reviewed project recipes']),
    h('p', {class: 'section-sub'}, [project
      ? 'Recipes are read from fluent.recipe.json. Running one always requires a one-time approval and records a redacted receipt.'
      : 'Start a project session before Fluent can read its fluent.recipe.json.'])
  ]);
  const recipeOutput = h('div', {});
  if (recipeError) {
    recipeCard.append(h('p', {class: 'error'}, [recipeError]));
  } else if (!project || recipes.length === 0) {
    recipeCard.append(h('p', {class: 'section-sub'}, [project ? 'No fluent.recipe.json recipes were found.' : 'No project is active.']));
  } else {
    for (const recipe of recipes) {
      const execute = h('button', {class: 'btn', type: 'button'}, ['run recipe']);
      execute.addEventListener('click', async () => {
        if (!(await askConfirm({title: `run recipe “${recipe.name}”`, body: `Fluent will run this exact command from ${project}.`, detail: recipe.command, confirmLabel: 'run recipe'}))) return;
        execute.disabled = true;
        recipeOutput.innerHTML = '';
        try {
          const receipt = await api.executeRecipe(project, recipe);
          receipts = [receipt, ...receipts].slice(0, 8);
          recipeOutput.append(h('div', {class: 'card'}, [
            h('h3', {}, [`recipe ${receipt.status}`]),
            h('p', {class: receipt.status === 'passed' ? 'success' : 'error'}, [`${receipt.name} · ${(receipt.durationMs / 1000).toFixed(1)}s · exit ${receipt.exitCode ?? 'unknown'}`]),
            h('pre', {class: 'diff'}, [receipt.output || 'Recipe produced no output.'])
          ]));
        } catch (error) {
          recipeOutput.append(h('p', {class: 'error'}, [error instanceof Error ? error.message : String(error)]));
        } finally {
          execute.disabled = false;
        }
      });
      recipeCard.append(h('div', {class: 'option-row'}, [h('div', {}, [h('div', {class: 'label'}, [recipe.name]), h('div', {class: 'meta'}, [recipe.description ?? recipe.command]), h('div', {class: 'section-sub'}, [`timeout ${(recipe.timeoutMs / 1000).toFixed(0)}s`])]), execute]));
    }
  }
  if (receipts.length > 0) {
    recipeCard.append(h('p', {class: 'section-sub'}, [`Latest receipt: ${receipts[0]!.name} · ${receipts[0]!.status} · ${new Date(receipts[0]!.startedAt).toLocaleString()}`]));
  }
  main.append(
    h('div', {class: 'toolbar'}, [
      h('div', {}, [h('h1', {class: 'section-title'}, [markEl(), 'preview & visual check']), status]),
      inspect
    ]),
    h('div', {class: 'field preview-controls'}, [urlInput, open]),
    previewNotice,
    recipeCard,
    recipeOutput
  );
}

async function renderRemote(main: HTMLElement) {
  const profiles = await api.listRemotes();
  const selectedSocket = activeRemoteSocket();
  const name = h('input', {type: 'text', placeholder: 'server name'});
  const host = h('input', {type: 'text', placeholder: 'user@host'});
  const port = h('input', {type: 'number', value: '22', min: '1', max: '65535', step: '1', placeholder: 'SSH port'}) as HTMLInputElement;
  const remoteSocket = h('input', {type: 'text', value: '/tmp/fluent-code.sock', placeholder: 'remote Fluent socket path'}) as HTMLInputElement;
  const autoReconnect = h('input', {type: 'checkbox'}) as HTMLInputElement;
  const setupStatus = h('p', {class: 'section-sub'}, ['Use the remote daemon’s actual Unix-socket path. Fluent verifies its protocol before it can become the active target.']);
  const add = h('button', {class: 'btn primary'}, ['add SSH server']);
  add.addEventListener('click', async () => {
    if (!name.value.trim() || !host.value.trim()) return host.focus();
    try {
      await api.saveRemote({name: name.value.trim(), host: host.value.trim(), port: Number(port.value), remoteSocket: remoteSocket.value.trim(), autoReconnect: autoReconnect.checked});
      void render();
    } catch (error) {
      setupStatus.textContent = error instanceof Error ? error.message : String(error);
      setupStatus.className = 'error';
    }
  });
  main.append(
    h('div', {class: 'toolbar'}, [
      h('div', {}, [
        h('h1', {class: 'section-title'}, [markEl(), 'remote servers']),
        h('p', {class: 'section-sub'}, ['connects through SSH Unix-socket forwarding; Fluent never exposes a daemon port publicly.'])
      ])
    ]),
    h('div', {class: 'card remote-connect-card'}, [
      h('h3', {}, ['add a remote target']),
      h('p', {class: 'section-sub'}, ['Name a server, then use your existing SSH identity to establish an owner-controlled tunnel. Automatic reconnect is opt-in and bounded.']),
      h('div', {class: 'field'}, [name, host, port, remoteSocket, h('label', {class: 'section-sub'}, [autoReconnect, ' reconnect automatically after a tunnel failure']), add, setupStatus])
    ])
  );
  if (profiles.length === 0) {
    main.append(h('div', {class: 'empty-state remote-empty'}, ['No remote servers configured. Your local machine remains the active target.']));
  }
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
    const removeProfile = h('button', {class: 'btn danger', type: 'button'}, ['remove']);
    removeProfile.addEventListener('click', async () => {
      if (!(await askConfirm({title: `remove ${profile.name}`, body: `Remove the saved SSH profile for ${profile.host}? Its tunnel closes if it is open. The remote daemon and its sessions keep running.`, confirmLabel: 'remove profile', danger: true}))) return;
      removeProfile.disabled = true;
      try {
        await api.removeRemote(profile.id);
        if (selectedSocket === profile.localSocket) selectRemoteSocket();
        void render();
      } catch (error) {
        showActionError(error);
        removeProfile.disabled = false;
      }
    });
    main.append(h('div', {class: 'option-row'}, [
      h('span', {class: 'label'}, [profile.name]),
      h('span', {class: 'meta'}, [`${profile.host}:${profile.port} · ${profile.remoteSocket} · ${profile.autoReconnect ? 'auto-reconnect' : 'manual reconnect'} · ${profile.status}${profile.error ? ` · ${profile.error}` : ''}`]),
      useHere,
      action,
      removeProfile
    ]));
  }
  if (selectedSocket) {
    try {
      const [hardware, software] = await Promise.all([api.hardwareSnapshot(), api.softwareSnapshot()]);
      const memory = `${bytes(hardware.current.memoryUsedBytes)} / ${bytes(hardware.current.memoryTotalBytes)}`;
      main.append(h('div', {class: 'cards-row'}, [
        h('div', {class: 'card'}, [
          h('h3', {}, ['active remote hardware']),
          h('p', {class: 'trace cpu'}, ['cpu', sparklineChart(hardware.history.map(sample => sample.cpuPercent), 'var(--success)')]),
          h('p', {class: 'trace memory'}, ['memory', sparklineChart(hardware.history.map(sample => sample.memoryUsedBytes), 'var(--fg-muted)')]),
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
  // Most navigation lives in the rail, which supplies its compact treatment. A few contextual
  // actions (for example “open preview” in Design) reuse this helper outside the rail, where a
  // plain browser button looks broken; the base button treatment keeps both cases intentional.
  const button = h('button', {class: 'btn'}, [label]);
  if (route.name === name) {
    button.classList.add('active');
    button.setAttribute('aria-current', 'page');
  }
  button.addEventListener('click', () => navigate({name} as Route));
  return button;
}

function markEl(): HTMLElement {
  return h('span', {class: 'mark'}, [h('span'), h('span'), h('span'), h('span')]);
}

// --- Splash ---------------------------------------------------------------

/** The packaged daemon is started by Tauri immediately before the webview loads. Give its
 * owner-local socket a bounded moment to come up instead of presenting a false startup failure
 * on a fast first render. A genuine daemon failure remains visible and retryable afterwards. */
async function waitForLocalDaemon() {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      return await api.ping();
    } catch (error) {
      lastError = error;
      if (attempt < 24) await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

async function renderSplash(main: HTMLElement) {
  const container = h('div', {class: 'splash'});
  main.append(container);
  const wordmark = h('div', {class: 'wordmark'}, [markEl(), 'fluent code']);
  container.append(wordmark, h('p', {class: 'version'}, ['starting local engine…']));

  let ping: {ok: boolean; pid: number};
  try {
    ping = await waitForLocalDaemon();
  } catch (error) {
    container.innerHTML = '';
    container.append(
      wordmark,
      h('p', {class: 'error'}, [error instanceof Error ? error.message : String(error)]),
      retryButton(() => void render())
    );
    return;
  }

  const chains = await api.listCredentials().catch(() => [] as CredentialChainState[]);
  const providers: Array<{id: ProviderId; label: string}> = [
    {id: 'claude', label: 'anthropic claude'},
    {id: 'codex', label: 'openai codex'},
    {id: 'gemini', label: 'google gemini'},
    {id: 'qwen', label: 'qwen'},
    {id: 'glm', label: 'z.ai glm'},
    {id: 'nvidia', label: 'nvidia nim'}
  ];

  container.innerHTML = '';
  container.append(
    wordmark,
    h('p', {class: 'version'}, [`fluentd connected · pid ${ping.pid}`]),
    h('div', {class: 'providers'}, providers.map(provider => {
      const chain = chains.find(c => c.provider === provider.id);
      const connected = Boolean(chain?.activeAccountId);
      return h('span', {class: 'badge'}, [h('span', {class: `dot${connected ? ' on' : ''}`}), provider.label]);
    })),
    h('p', {class: 'prompt'}, ['press ', h('kbd', {}, ['enter']), ' to continue'])
  );

  const hasConnectedAccount = chains.some(chain => chain.accounts.length > 0);
  const advance = () => navigate(hasConnectedAccount ? {name: 'sessions'} : {name: 'onboarding'});
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
  const dirInput = h('input', {type: 'text', placeholder: '/path/to/project', value: workspacePath}) as HTMLInputElement;
  const loginButton = h('button', {class: 'btn primary'}, ['connect via CLI login']);
  loginButton.addEventListener('click', async () => {
    const directory = dirInput.value.trim();
    if (!directory) return dirInput.focus();
    setWorkspacePath(directory);
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
  const geminiKeyLabel = h('input', {type: 'text', placeholder: 'label (e.g. Google AI Studio)'});
  const geminiKey = h('input', {type: 'password', placeholder: 'AIza...'});
  const geminiStatus = h('p', {class: 'section-sub'}, []);
  const geminiKeyButton = h('button', {class: 'btn'}, ['save Gemini API key']);
  geminiKeyButton.addEventListener('click', async () => {
    const apiKey = geminiKey.value.trim();
    if (!apiKey) return geminiKey.focus();
    await api.upsertAccount({
      provider: 'gemini',
      id: crypto.randomUUID(),
      mode: 'api-key',
      label: geminiKeyLabel.value.trim() || 'Gemini API key',
      apiKey
    });
    geminiStatus.textContent = 'saved securely — select it when starting a Gemini session';
    geminiKey.value = '';
  });
  const geminiLogin = h('button', {class: 'btn primary'}, ['connect via Gemini login']);
  geminiLogin.addEventListener('click', async () => {
    const directory = dirInput.value.trim();
    if (!directory) return dirInput.focus();
    const summary = await api.createSession({provider: 'gemini', directory});
    navigate({name: 'active-session', sessionId: summary.id});
  });

  const modelLinkCard = (provider: 'qwen' | 'glm' | 'nvidia', subtitle: string) => {
    const defaults = modelLinkDefaults[provider];
    const labelInput = h('input', {type: 'text', placeholder: 'account label (e.g. work)'});
    const keyInput = h('input', {type: 'password', placeholder: defaults.keyPlaceholder});
    const modelInput = h('input', {type: 'text', value: defaults.model, placeholder: 'model id'});
    const endpointInput = h('input', {type: 'url', value: defaults.endpoint, placeholder: 'OpenAI-compatible endpoint'});
    const status = h('p', {class: 'section-sub'}, []);
    const save = h('button', {class: 'btn'}, ['save API key']);
    save.addEventListener('click', async () => {
      const apiKey = keyInput.value.trim();
      if (!apiKey) return keyInput.focus();
      const model = modelInput.value.trim();
      if (!model) return modelInput.focus();
      const baseUrl = endpointInput.value.trim();
      if (!baseUrl) return endpointInput.focus();
      await api.upsertAccount({
        provider,
        id: crypto.randomUUID(),
        mode: 'api-key',
        label: labelInput.value.trim() || `${providerLabel[provider]} API key`,
        apiKey,
        model,
        baseUrl
      });
      status.textContent = 'saved securely — select this account when starting a session';
      keyInput.value = '';
    });
    return h('div', {class: 'card'}, [
      h('h3', {}, [providerLabel[provider]]),
      h('p', {class: 'subtitle'}, [subtitle]),
      h('div', {class: 'field'}, [
        h('label', {class: 'field-label'}, ['API key · model · endpoint']),
        labelInput,
        keyInput,
        modelInput,
        endpointInput,
        save,
        status,
        h('p', {class: 'section-sub'}, ['Uses the locally installed OpenCode agent; the endpoint and model stay explicit per account.'])
      ])
    ]);
  };

  cards.append(
    h('div', {class: 'card'}, [
      h('h3', {}, ['Claude Code']),
      h('p', {class: 'subtitle'}, ['Anthropic']),
      h('div', {class: 'field'}, [h('label', {class: 'field-label'}, ['CLI login — working directory']), directoryField(dirInput), h('p', {class: 'section-sub'}, ['browse folders on this computer, or enter a path']), loginButton]),
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
      h('h3', {}, ['Gemini CLI']),
      h('p', {class: 'subtitle'}, ['Google login or Gemini API key']),
      h('div', {class: 'field'}, [h('label', {class: 'field-label'}, ['CLI login — same working directory']), geminiLogin]),
      h('div', {class: 'field'}, [geminiKeyLabel, geminiKey, geminiKeyButton, geminiStatus])
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
    ]),
    modelLinkCard('qwen', 'Alibaba Cloud Model Studio · OpenAI-compatible API'),
    modelLinkCard('glm', 'Z.AI Coding Plan · OpenAI-compatible API'),
    modelLinkCard('nvidia', 'NVIDIA NIM · hosted or self-hosted OpenAI-compatible API')
  );

  const skip = h('button', {class: 'btn'}, ['skip for now']);
  skip.addEventListener('click', () => navigate({name: 'sessions'}));
  main.append(h('div', {class: 'toolbar'}, [h('span', {}, []), skip]));
}

// --- Session list ------------------------------------------------------------

async function renderSessions(main: HTMLElement) {
  const [allSessions, chains, usage] = await Promise.all([api.listSessions(true), api.listCredentials(), api.usageSnapshot().catch(() => ({sessions: []}))]);
  const usageBySession = new Map(usage.sessions.map(item => [item.sessionId, item]));
  const sessions = allSessions.filter(session => sessionMatches(session, sessionView, ''));

  const newSessionButton = h('button', {class: 'btn primary'}, ['+ new session']);
  newSessionButton.addEventListener('click', () => navigate({name: 'new-session'}));
  const viewButtons = (['all', 'active', 'archived'] as const).map(view => {
    const count = allSessions.filter(session => sessionMatches(session, view, '')).length;
    const button = h('button', {class: `btn${sessionView === view ? ' primary' : ''}`, type: 'button', 'aria-pressed': sessionView === view ? 'true' : 'false'}, [`${view} · ${count}`]);
    button.addEventListener('click', () => { sessionView = view; void render(); });
    return button;
  });
  const search = h('input', {type: 'search', value: sessionQuery, placeholder: 'search sessions…', 'aria-label': 'Search sessions'}) as HTMLInputElement;
  main.append(
    h('div', {class: 'toolbar'}, [
      h('div', {}, [h('h1', {class: 'section-title'}, [markEl(), sessionView === 'archived' ? 'archived sessions' : 'sessions']), h('p', {class: 'section-sub'}, [sessionView === 'archived' ? 'Archived session records stay local until you restore or delete them.' : 'Archive finished sessions to clear this list without deleting their worktree or project files.'])]),
      h('div', {class: 'actions'}, [newSessionButton])
    ]),
    h('div', {class: 'session-filters'}, [h('div', {class: 'segmented', role: 'group', 'aria-label': 'Session views'}, viewButtons), search])
  );

  if (sessions.length === 0) {
    main.append(h('div', {class: 'empty-state'}, [sessionView === 'archived' ? 'No archived sessions.' : sessionView === 'active' ? 'No sessions are running.' : 'No sessions yet — start one with "+ new session".']));
    return;
  }

  const table = h('table', {class: 'sessions'});
  table.append(
    h('thead', {}, [h('tr', {}, ['session', 'provider', 'account', 'status', 'tokens', 'checks', 'checkout', 'ready in', 'last active', 'actions'].map(label => h('th', {}, [label])))])
  );
  const rows: Array<{row: HTMLElement; session: SessionSummary; labels: string[]}> = [];
  const tbody = h('tbody');
  for (const {session, depth} of sessionTree(sessions)) {
    const name = session.task?.trim() || session.directory.split('/').filter(Boolean).pop() || session.directory;
    const isLive = session.status === 'running' || session.status === 'starting';
    const actions = h('div', {class: 'session-actions'});
    const archive = h('button', {class: 'btn', type: 'button'}, ['archive']);
    archive.disabled = isLive || Boolean(session.archivedAt);
    archive.addEventListener('click', async event => {
      event.stopPropagation();
      await api.archiveSession(session.id);
      void render();
    });
    const restore = h('button', {class: 'btn', type: 'button'}, ['restore']);
    restore.disabled = !session.archivedAt;
    restore.addEventListener('click', async event => {
      event.stopPropagation();
      await api.restoreSession(session.id);
      sessionView = 'all';
      void render();
    });
    const remove = h('button', {class: 'btn danger', type: 'button'}, ['delete']);
    remove.disabled = !session.archivedAt;
    remove.addEventListener('click', async event => {
      event.stopPropagation();
      if (!(await askConfirm({title: 'delete session record', body: `Delete the local record for “${name}”? Its project files and any isolated worktree will remain on disk.`, confirmLabel: 'delete', danger: true}))) return;
      await api.deleteSession(session.id);
      void render();
    });
    actions.append(session.archivedAt ? restore : archive, remove);
    const reported = usageBySession.get(session.id);
    const tokens = reported && (reported.inputTokens !== undefined || reported.outputTokens !== undefined)
      ? formatTokens((reported.inputTokens ?? 0) + (reported.outputTokens ?? 0))
      : '—';
    const row = h('tr', {}, [
      h('td', {}, [h('div', {class: `session-name${depth ? ' session-lane' : ''}`}, [
        depth ? `↳ ${name}` : name,
        ...(session.lead ? [h('span', {class: 'pill lead-pill'}, [leadLoad(session, allSessions) ?? 'lead'])] : []),
        ...(session.parentSessionId ? [h('p', {class: 'meta'}, [`started by lead ${session.parentSessionId.slice(0, 8)}`])] : []),
        ...(session.error ? [h('p', {class: 'error'}, [session.error])] : [])
      ])]),
      h('td', {}, [session.model ? `${providerLabel[session.provider]} · ${session.model}` : providerLabel[session.provider]]),
      h('td', {}, [accountLabel(session.accountId, chains)]),
      h('td', {}, [h('span', {class: `pill status-${session.status}`}, [session.status])]),
      h('td', {}, [tokens]),
      h('td', {}, [verificationPill(session.verification)]),
      h('td', {}, [session.worktreePath ? 'isolated' : 'shared']),
      h('td', {}, [laneReady(session)]),
      h('td', {}, [relativeTime(session.updatedAt)]),
      h('td', {}, [actions])
    ]);
    row.addEventListener('click', () => navigate({name: 'active-session', sessionId: session.id}));
    tbody.append(row);
    rows.push({row, session, labels: [providerLabel[session.provider], accountLabel(session.accountId, chains)]});
  }
  table.append(tbody);
  const noMatches = h('div', {class: 'empty-state'}, ['No sessions match this search.']);
  const footer = h('p', {class: 'section-sub session-footer', role: 'status'}, []);
  // Search hides rows in place, so typing never rebuilds the page or loses the cursor.
  const applySearch = () => {
    sessionQuery = search.value;
    const visible = rows.filter(({row, session, labels}) => {
      row.hidden = !sessionMatches(session, sessionView, sessionQuery, labels);
      return !row.hidden;
    }).map(({session}) => session);
    noMatches.hidden = visible.length > 0;
    const totals = sessionTotals(visible, usageBySession);
    footer.textContent = `${totals.count} session${totals.count === 1 ? '' : 's'} · ${totals.active} active · ${totals.tokens === undefined ? 'no token usage reported' : `${formatTokens(totals.tokens)} tokens reported`}`;
  };
  search.addEventListener('input', applySearch);
  applySearch();
  main.append(table, noMatches, footer);
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
        h('span', {class: 'meta'}, [[account.mode, account.model ? `model ${account.model}` : '', account.hasSecret ? 'secure' : ''].filter(Boolean).join(' · ')])
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

  const dirInput = h('input', {type: 'text', placeholder: '/path/to/project', value: workspacePath}) as HTMLInputElement;
  const taskInput = h('textarea', {placeholder: 'what should this session start with? (optional)'});
  const isolateInput = h('input', {type: 'checkbox'}) as HTMLInputElement;
  const isolateLabel = h('label', {class: 'check-label'}, [isolateInput, ' run in an isolated Git worktree']);
  const leadInput = h('input', {type: 'checkbox'}) as HTMLInputElement;
  const leadBudget = h('input', {type: 'number', min: '1', max: '10', step: '1', value: '3', class: 'lead-budget', 'aria-label': 'Lane budget'}) as HTMLInputElement;
  const leadLabel = h('label', {class: 'check-label'}, [leadInput, ' lead session — may start and direct up to ', leadBudget, ' lanes of its own at once']);
  main.append(
    h('div', {class: 'field'}, [h('label', {class: 'field-label'}, ['working directory']), directoryField(dirInput), h('p', {class: 'section-sub'}, ['browse folders on this computer, or enter a path'])]),
    h('div', {class: 'field'}, [h('label', {class: 'field-label'}, ['starting task (optional)']), taskInput, isolateLabel, h('p', {class: 'section-sub'}, ['recommended for parallel agents — creates a separate checkout beside the project']), leadLabel, h('p', {class: 'section-sub'}, ['each lane a lead starts is a full agent on your account; it appears under this session, where you can open or stop it'])])
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
  const startNotice = h('p', {class: 'action-status', role: 'status'}, []);
  startButton.addEventListener('click', async () => {
    const directory = dirInput.value.trim();
    if (!directory) return dirInput.focus();
    startButton.disabled = true;
    startNotice.className = 'action-status';
    startNotice.textContent = 'starting session…';
    try {
      setWorkspacePath(directory);
      const summary = await api.createSession({provider: selectedProvider, directory, task: taskInput.value.trim() || undefined, accountId: selectedAccountId, isolate: isolateInput.checked, lead: leadInput.checked ? {maxLanes: Number(leadBudget.value)} : undefined});
      navigate({name: 'active-session', sessionId: summary.id});
    } catch (error) {
      const message = actionErrorText(error);
      startNotice.className = 'error action-status';
      startNotice.textContent = message;
      showActionError(error);
    } finally {
      startButton.disabled = false;
    }
  });
  const cancelButton = h('button', {class: 'btn'}, ['cancel']);
  cancelButton.addEventListener('click', () => navigate({name: 'sessions'}));
  main.append(h('div', {class: 'toolbar'}, [startNotice, h('div', {class: 'actions'}, [cancelButton, startButton])]));
}

// --- Lane terminals ------------------------------------------------------------

type LaneTerminal = {snapshot: SessionSnapshot; dispose: () => void};

/**
 * Mounts one lane's live terminal: xterm.js on the lane's PTY stream, keystrokes back to the lane.
 *
 * Two things a plain write-and-forward got wrong. Output pushed before the snapshot arrives has to
 * be held and written after it, or the screen is drawn out of order. And replaying the snapshot
 * re-runs every terminal query the CLI sent while nobody was watching — cursor position, colours,
 * device attributes — which xterm.js answers again; those stale answers would be typed into the
 * lane as if the user had typed them.
 */
async function attachLaneTerminal(sessionId: string, container: HTMLElement, options: {fontSize?: number; onStatus?: (summary: SessionSummary) => void} = {}): Promise<LaneTerminal> {
  const terminal = new Terminal({
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
    fontSize: options.fontSize ?? terminalFontSize(),
    theme: terminalTheme()
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  let replaying = true;
  const pending: string[] = [];
  terminal.onData(data => {
    if (replaying) return;
    void api.send(sessionId, data).catch(error => {
      terminal.write(`\r\n[Fluent] ${actionErrorText(error)}\r\n`);
      showActionError(error);
    });
  });
  const subscription = subscribeSession(sessionId, {
    onOutput: chunk => {
      if (replaying) pending.push(chunk);
      else terminal.write(chunk);
    },
    onStatus: summary => options.onStatus?.(summary)
  });
  let disposed = false;
  let lastSize = '';
  // The daemon spawns the PTY at a fixed default size before any view has measured itself, and a
  // grid tile is much smaller than the single-lane view — keep the PTY at whatever is rendered, or
  // the CLI draws (and wraps) for a grid that doesn't match the screen.
  const fit = () => {
    if (disposed || !container.isConnected) return;
    fitAddon.fit();
    const size = `${terminal.cols}x${terminal.rows}`;
    if (size === lastSize) return;
    lastSize = size;
    void api.resize(sessionId, terminal.cols, terminal.rows).catch(() => undefined);
  };
  const resizeObserver = new ResizeObserver(() => fit());
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    resizeObserver.disconnect();
    void subscription.unsubscribe();
    terminal.dispose();
  };
  let snapshot: SessionSnapshot;
  try {
    snapshot = await subscription.snapshot;
  } catch (error) {
    dispose();
    throw error;
  }
  await new Promise<void>(resolve => terminal.write(snapshot.output, resolve));
  replaying = false;
  for (const chunk of pending.splice(0)) terminal.write(chunk);
  // The page may have been replaced while the snapshot loaded; nothing would release this later.
  if (!container.isConnected) {
    dispose();
    return {snapshot, dispose};
  }
  resizeObserver.observe(container);
  fit();
  return {snapshot, dispose};
}

/**
 * Where context goes into lanes: one paste per lane, then Enter — what a person pasting a brief
 * into each terminal and pressing return would do, never a change to what the CLI does with it.
 * `targets` is read at click time, so a lane selection changed after mounting is honoured.
 */
function contextComposer(targets: () => string[], label = 'inject context'): HTMLElement {
  const input = h('textarea', {class: 'context-input', rows: '3', placeholder: 'context to paste into the lane — the task, files to read first, constraints…', 'aria-label': 'Context to inject'}) as HTMLTextAreaElement;
  const submit = h('input', {type: 'checkbox', checked: ''}) as HTMLInputElement;
  const status = h('p', {class: 'action-status', role: 'status'}, []);
  const button = h('button', {class: 'btn primary'}, [label]);
  button.addEventListener('click', async () => {
    const text = input.value;
    const ids = targets();
    if (!text.trim()) return input.focus();
    if (ids.length === 0) {
      status.className = 'error action-status';
      status.textContent = 'select at least one running lane';
      return;
    }
    button.disabled = true;
    status.className = 'action-status';
    status.textContent = `injecting into ${ids.length} lane${ids.length === 1 ? '' : 's'}…`;
    const results = await Promise.allSettled(ids.map(id => api.inject(id, text, submit.checked)));
    const failed = results.flatMap((result, index) => result.status === 'rejected' ? [`${ids[index]!.slice(0, 8)}: ${actionErrorText(result.reason)}`] : []);
    status.className = failed.length ? 'error action-status' : 'action-status';
    status.textContent = failed.length
      ? `injected into ${ids.length - failed.length} of ${ids.length} — ${failed.join(' · ')}`
      : `injected into ${ids.length} lane${ids.length === 1 ? '' : 's'}${submit.checked ? ' and submitted' : ''}`;
    if (!failed.length) input.value = '';
    button.disabled = false;
  });
  return h('div', {class: 'context-composer'}, [
    input,
    h('div', {class: 'toolbar'}, [status, h('div', {class: 'actions'}, [h('label', {class: 'check-label'}, [submit, ' press enter after pasting']), button])])
  ]);
}

const laneCount = (value: string) => Math.max(0, Math.min(10, Number.parseInt(value, 10) || 0));

/**
 * Starts several lanes at once, each the real, unmodified provider CLI in its own terminal. They
 * start one after another rather than all at once: each Claude lane needs its own daemon-issued
 * consent to write the project's hook settings, and a failure is reported against the lane it
 * belongs to.
 */
function laneLauncher(defaultDirectory: string): HTMLElement {
  const directory = h('input', {type: 'text', placeholder: '/path/to/project', value: defaultDirectory}) as HTMLInputElement;
  const claudeCount = h('input', {type: 'number', min: '0', max: '10', value: '5', 'aria-label': 'Claude Code lanes'}) as HTMLInputElement;
  const codexCount = h('input', {type: 'number', min: '0', max: '10', value: '5', 'aria-label': 'Codex lanes'}) as HTMLInputElement;
  const isolate = h('input', {type: 'checkbox'}) as HTMLInputElement;
  const task = h('textarea', {rows: '2', placeholder: 'starting task for every lane (optional) — each CLI receives it as its first prompt'}) as HTMLTextAreaElement;
  const status = h('p', {class: 'action-status', role: 'status'}, []);
  const launch = h('button', {class: 'btn primary'}, ['launch lanes']);
  launch.addEventListener('click', async () => {
    const path = directory.value.trim();
    if (!path) return directory.focus();
    const plan: ProviderId[] = [
      ...Array<ProviderId>(laneCount(claudeCount.value)).fill('claude'),
      ...Array<ProviderId>(laneCount(codexCount.value)).fill('codex')
    ];
    if (plan.length === 0) return claudeCount.focus();
    launch.disabled = true;
    setWorkspacePath(path);
    const failures: string[] = [];
    for (const [index, provider] of plan.entries()) {
      status.className = 'action-status';
      status.textContent = `starting lane ${index + 1} of ${plan.length} · ${provider}…`;
      try {
        await api.createSession({provider, directory: path, task: task.value.trim() || undefined, isolate: isolate.checked});
      } catch (error) {
        failures.push(`${provider}: ${actionErrorText(error)}`);
      }
    }
    orchestrationProject = path;
    launch.disabled = false;
    if (failures.length) showActionError(new Error(`${failures.length} of ${plan.length} lanes did not start — ${failures[0]}`));
    void render();
  });
  return h('div', {class: 'card lane-launcher'}, [
    h('h3', {}, ['launch agent lanes']),
    h('p', {class: 'section-sub'}, ['each lane runs the real CLI in its own terminal, on the login or account that CLI would use']),
    h('div', {class: 'lane-launcher-grid'}, [
      h('div', {class: 'field'}, [h('label', {class: 'field-label'}, ['working directory']), directoryField(directory)]),
      h('div', {class: 'field'}, [h('label', {class: 'field-label'}, ['claude code']), claudeCount]),
      h('div', {class: 'field'}, [h('label', {class: 'field-label'}, ['codex']), codexCount])
    ]),
    h('div', {class: 'field'}, [task, h('label', {class: 'check-label'}, [isolate, ' give each lane its own Git worktree'])]),
    h('div', {class: 'toolbar'}, [status, launch])
  ]);
}

/**
 * Every live lane in the project as a working terminal: type into any tile to answer that lane (a
 * trust prompt, a permission question), or select tiles and inject one brief into all of them.
 */
async function renderLaneGrid(main: HTMLElement, lanes: SessionSummary[]) {
  const selected = new Set(lanes.map(lane => lane.id));
  const disposers: Array<() => void> = [];
  setRouteCleanup(main, () => { for (const dispose of disposers.splice(0)) dispose(); });
  const grid = h('div', {class: 'lane-grid'});
  main.append(h('section', {class: 'lane-section'}, [
    h('div', {}, [
      h('h2', {}, [`live lanes · ${lanes.length}`]),
      h('p', {class: 'section-sub'}, ['click a terminal to type into that lane · checked lanes receive injected context'])
    ]),
    lanes.length > 0
      ? contextComposer(() => [...selected], 'inject into checked lanes')
      : h('p', {class: 'section-sub'}, ['No lanes are running in this project — launch some above.']),
    grid
  ]));
  await Promise.all(lanes.map(async lane => {
    const statusPill = h('span', {class: `pill status-${lane.status}`}, [lane.status]);
    const pick = h('input', {type: 'checkbox', checked: '', 'aria-label': `Inject into ${lane.provider} lane ${lane.id.slice(0, 8)}`}) as HTMLInputElement;
    pick.addEventListener('change', () => {
      if (pick.checked) selected.add(lane.id);
      else selected.delete(lane.id);
    });
    const open = h('button', {class: 'btn'}, ['open']);
    open.addEventListener('click', () => navigate({name: 'active-session', sessionId: lane.id}));
    const stop = h('button', {class: 'btn'}, ['stop']);
    stop.addEventListener('click', async () => {
      stop.disabled = true;
      await api.stop(lane.id).catch(showActionError);
    });
    const screen = h('div', {class: 'lane-terminal'});
    grid.append(h('article', {class: 'lane-tile', 'data-session-id': lane.id}, [
      h('header', {class: 'lane-tile-head'}, [
        h('label', {class: 'check-label'}, [pick, ` ${lane.provider} · ${lane.id.slice(0, 8)}${lane.lead ? ' · lead' : ''}${lane.parentSessionId ? ` · ↳ lead ${lane.parentSessionId.slice(0, 8)}` : ''}`]),
        statusPill,
        h('div', {class: 'actions'}, [open, stop])
      ]),
      screen
    ]));
    try {
      const attached = await attachLaneTerminal(lane.id, screen, {
        fontSize: 11,
        onStatus: summary => {
          statusPill.className = `pill status-${summary.status}`;
          statusPill.textContent = summary.status;
          if (summary.status !== 'running' && summary.status !== 'starting') {
            stop.disabled = true;
            pick.checked = false;
            selected.delete(lane.id);
          }
        }
      });
      disposers.push(attached.dispose);
    } catch (error) {
      screen.append(h('p', {class: 'error'}, [actionErrorText(error)]));
    }
  }));
}

// --- Active session ------------------------------------------------------------

async function renderActiveSession(main: HTMLElement, sessionId: string) {
  const chains = await api.listCredentials();
  const header = h('div', {class: 'session-header'});
  const banner = h('div', {});
  const review = h('div', {class: 'review-panel'});
  const terminalContainer = h('div', {id: 'terminal'});
  let currentRun: Run | undefined;
  const lanesPanel = h('div', {class: 'lead-lanes'});
  let laneSessions: SessionSummary[] = [];
  let currentLeadPill: HTMLElement | undefined;
  main.append(header, banner, lanesPanel, review, terminalContainer, contextComposer(() => [sessionId]));

  /** The lanes this lead started — each a full agent the user can open or stop from here. */
  async function refreshLanes(summary: SessionSummary) {
    if (!summary.lead) {
      lanesPanel.innerHTML = '';
      return;
    }
    const budget = summary.lead.maxLanes;
    laneSessions = (await api.listSessions()).filter(session => session.parentSessionId === sessionId);
    if (currentLeadPill) currentLeadPill.textContent = leadLoad(summary, laneSessions) ?? 'lead';
    const isLive = (lane: SessionSummary) => lane.status === 'running' || lane.status === 'starting';
    lanesPanel.innerHTML = '';
    lanesPanel.append(h('div', {class: 'card'}, [
      h('h3', {}, [`lanes started by this lead · ${laneSessions.filter(isLive).length}/${budget} running`]),
      ...(laneSessions.length === 0
        ? [h('p', {class: 'section-sub'}, ['This lead has not started any lanes yet.'])]
        : laneSessions.map(lane => {
            const open = h('button', {class: 'btn', type: 'button'}, ['open']);
            open.addEventListener('click', () => navigate({name: 'active-session', sessionId: lane.id}));
            const stop = h('button', {class: 'btn', type: 'button'}, ['stop']);
            stop.disabled = !isLive(lane);
            stop.addEventListener('click', async () => {
              stop.disabled = true;
              await api.stop(lane.id).catch(showActionError);
              void refreshLanes(summary);
            });
            return h('div', {class: 'option-row'}, [
              h('span', {class: 'label'}, [`${providerLabel[lane.provider]} · ${lane.id.slice(0, 8)}`]),
              h('span', {class: 'meta'}, [`${lane.status} · ${lane.task?.split('\n')[0]?.slice(0, 80) || 'no prompt'}`]),
              h('div', {class: 'actions'}, [open, stop])
            ]);
          }))
    ]));
  }

  function renderHeader(summary: SessionSummary) {
    header.innerHTML = '';
    currentLeadPill = summary.lead ? h('span', {class: 'pill lead-pill'}, [leadLoad(summary, laneSessions) ?? 'lead']) : undefined;
    void refreshLanes(summary);
    const sessionName = summary.task?.trim() || summary.directory.split('/').filter(Boolean).at(-1) || summary.directory;
    const stopButton = h('button', {class: 'btn'}, ['stop session']);
    stopButton.disabled = summary.status !== 'running';
    stopButton.addEventListener('click', async () => {
      await api.stop(sessionId);
    });
    const removeWorktree = h('button', {class: 'btn'}, ['remove worktree']);
    removeWorktree.disabled = !summary.worktreePath || summary.status === 'running' || summary.status === 'starting';
    removeWorktree.addEventListener('click', async () => {
      if (!(await askConfirm({title: 'remove worktree', body: 'Remove this stopped agent worktree? Uncommitted changes in it will be discarded.', confirmLabel: 'remove worktree', danger: true}))) return;
      await api.removeWorktree(sessionId);
      void render();
    });
    const isLive = summary.status === 'running' || summary.status === 'starting';
    const archiveSession = h('button', {class: 'btn'}, ['archive session']);
    archiveSession.disabled = isLive || Boolean(summary.archivedAt);
    archiveSession.addEventListener('click', async () => {
      await api.archiveSession(sessionId);
      sessionView = 'archived';
      navigate({name: 'sessions'});
    });
    const restoreSession = h('button', {class: 'btn'}, ['restore session']);
    restoreSession.disabled = !summary.archivedAt;
    restoreSession.addEventListener('click', async () => {
      await api.restoreSession(sessionId);
      sessionView = 'all';
      navigate({name: 'sessions'});
    });
    const deleteSession = h('button', {class: 'btn danger'}, ['delete session']);
    deleteSession.disabled = !summary.archivedAt;
    deleteSession.addEventListener('click', async () => {
      if (!(await askConfirm({title: 'delete session record', body: `Delete the local record for “${sessionName}”? Its project files and any isolated worktree will remain on disk.`, confirmLabel: 'delete', danger: true}))) return;
      await api.deleteSession(sessionId);
      navigate({name: 'sessions'});
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
    const checkpoint = h('button', {class: 'btn'}, ['record checkpoint']);
    checkpoint.disabled = !currentRun;
    checkpoint.addEventListener('click', async () => {
      checkpoint.disabled = true;
      review.innerHTML = '';
      try {
        const saved = await api.checkpointRun(sessionId);
        if (currentRun && saved) currentRun = {...currentRun, checkpoint: saved};
        renderHeader(summary);
        review.append(h('div', {class: 'card'}, [
          h('div', {class: 'toolbar'}, [h('h3', {}, ['checkpoint recorded']), h('button', {class: 'btn'}, ['close'])]),
          h('p', {class: 'section-sub'}, [saved?.gitRef
            ? `${saved.gitRef.slice(0, 12)} · working tree ${saved.workingTree}`
            : `repository reference unavailable · working tree ${saved?.workingTree ?? 'unknown'}`]),
          h('p', {class: 'section-sub'}, ['This is a durable review marker only. Fluent did not commit, stash, reset, or automatically resume the provider session.'])
        ]));
        (review.querySelector('button') as HTMLButtonElement | null)?.addEventListener('click', () => { review.innerHTML = ''; });
      } catch (error) {
        review.append(h('p', {class: 'error'}, [error instanceof Error ? error.message : String(error)]));
      } finally {
        checkpoint.disabled = !currentRun;
      }
    });
    header.append(
      h('div', {class: 'session-ident'}, [
        h('span', {class: 'eyebrow'}, [summary.archivedAt ? 'archived session' : 'session']),
        h('h1', {class: 'session-title'}, [sessionName]),
        ...(summary.error ? [h('p', {class: 'error'}, [summary.error])] : []),
        h('div', {class: 'meta'}, [
          h('span', {class: 'pill status-default'}, [summary.model ? `${providerLabel[summary.provider]} · ${summary.model}` : providerLabel[summary.provider]]),
          h('span', {class: 'pill'}, [accountLabel(summary.accountId, chains)]),
          h('span', {class: `pill status-${summary.status}`}, [summary.status]),
          ...(currentLeadPill ? [currentLeadPill] : []),
          ...(summary.parentSessionId ? [(() => {
            const parent = summary.parentSessionId;
            const link = h('button', {class: 'btn pill-button', type: 'button'}, [`started by lead ${parent.slice(0, 8)}`]);
            link.addEventListener('click', () => navigate({name: 'active-session', sessionId: parent}));
            return link;
          })()] : []),
          ...(currentRun ? [h('span', {class: `pill status-${currentRun.state}`}, [`run · ${currentRun.state}${currentRun.delivery === 'unknown' ? ' · delivery review' : ''}`])] : []),
          ...(currentRun?.checkpoint ? [h('span', {class: 'pill'}, [`checkpoint · ${currentRun.checkpoint.gitRef?.slice(0, 8) ?? 'no git ref'} · ${currentRun.checkpoint.workingTree}`])] : []),
          ...(currentRun?.timing['provider.first_event']?.available === false ? [h('span', {class: 'pill'}, ['provider first event · unavailable'])] : []),
          verificationPill(summary.verification),
          h('span', {class: 'dir'}, [summary.worktreePath ? `isolated · ${summary.directory}` : summary.directory])
        ])
      ]),
      h('div', {class: 'actions'}, [mergeLane, runChecks, checkpoint, reviewChanges, removeWorktree, summary.archivedAt ? restoreSession : archiveSession, deleteSession, stopButton])
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

  const lane = await attachLaneTerminal(sessionId, terminalContainer, {
    onStatus: summary => {
      void api.getRun(sessionId).then(run => { currentRun = run; renderHeader(summary); }, () => renderHeader(summary));
    }
  });
  setRouteCleanup(main, lane.dispose);
  const initial = lane.snapshot;
  currentRun = await api.getRun(sessionId).catch(() => undefined);
  renderHeader(initial);

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

  setRouteCleanup(main, () => {
    lane.dispose();
    unlistenNotice();
    unlistenSwitched();
    unlistenVerification();
    unlistenAdmission();
  });
}

// --- Credentials ------------------------------------------------------------

async function renderCredentials(main: HTMLElement) {
  const providerLabels = providerLabel;
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

  // Connection state comes from the provider CLI's own `auth status`, never from its credential
  // files (spec §7.5) — so this says "connected" without Fluent ever holding an OAuth token.
  const authByAccount = credentialProvider === 'claude'
    ? Object.fromEntries((await api.authStatus().catch(() => [])).map(status => [status.accountId, status]))
    : {};

  const list = h('div', {});
  main.append(list);

  const removeButton = (account: CredentialChainState['accounts'][number]) => {
    const button = h('button', {class: 'btn danger', type: 'button'}, ['remove']);
    button.addEventListener('click', async () => {
      const detail = account.mode === 'api-key'
        ? 'Its stored key is deleted from the system keychain.'
        : 'Fluent’s separate sign-in profile for it is deleted, so you would sign in again if you add it back.';
      if (!(await askConfirm({title: `remove ${account.label}`, body: `Remove this ${providerLabels[credentialProvider]} account from Fluent? ${detail} Past sessions keep their record.`, confirmLabel: 'remove account', danger: true}))) return;
      button.disabled = true;
      try {
        await api.removeAccount(credentialProvider, account.id);
        void render();
      } catch (error) {
        showActionError(error);
        button.disabled = false;
      }
    });
    return button;
  };

  function renderList() {
    list.innerHTML = '';
    chain.chain.forEach((accountId, index) => {
      const account = chain.accounts.find(a => a.id === accountId);
      if (!account) return;
      const isActive = chain.activeAccountId === accountId;
      const auth = authByAccount[accountId];
      const connection = auth
        ? (auth.loggedIn ? `connected${auth.authMethod ? ` · ${auth.authMethod}` : ''}` : 'not connected')
        : '';
      const row = h('div', {class: `option-row${isActive ? ' selected' : ''}`}, [
        h('span', {class: 'label'}, [`${index + 1}. ${account.label}`]),
        h('span', {class: auth && !auth.loggedIn ? 'error' : 'meta'}, [[account.mode, account.model ? `model ${account.model}` : '', connection, isActive ? 'active now' : ''].filter(Boolean).join(' · ')])
      ]);
      // Every row has at least one control now (remove), so they sit in one right-aligned group.
      const controls = h('div', {class: 'actions'});
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
      controls.append(removeButton(account));
      row.append(controls);
      list.append(row);
      // Subscription and Console credits are both OAuth logins the CLI owns, so Fluent shows the
      // command rather than running it: the browser flow is the user's business with Anthropic
      // (spec §9), and each account keeps its own config directory so both can be connected.
      if (auth && !auth.loggedIn && auth.loginCommand) {
        list.append(h('p', {class: 'section-sub'}, [`connect it with:  ${auth.loginCommand}`]));
      }
      if (auth?.detail) list.append(h('p', {class: 'section-sub'}, [auth.detail]));
    });
    const manualAccounts = chain.accounts.filter(account => !chain.chain.includes(account.id));
    if (manualAccounts.length > 0) {
      list.append(h('p', {class: 'field-label'}, ['separate logins — manual session selection']));
      list.append(h('p', {class: 'section-sub'}, ['These profiles stay out of automatic fallback. Select one explicitly when starting a new session.']));
      for (const account of manualAccounts) {
        const auth = authByAccount[account.id];
        const connection = auth ? (auth.loggedIn ? 'connected' : 'not connected') : '';
        list.append(h('div', {class: 'option-row'}, [
          h('span', {class: 'label'}, [account.label]),
          h('span', {class: auth && !auth.loggedIn ? 'error' : 'meta'}, [[account.mode, account.model ? `model ${account.model}` : '', connection, 'manual only'].filter(Boolean).join(' · ')]),
          h('div', {class: 'actions'}, [removeButton(account)])
        ]));
        if (auth && !auth.loggedIn && auth.loginCommand) {
          list.append(h('p', {class: 'section-sub'}, [`connect it with:  ${auth.loginCommand}`]));
        }
      }
    }
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

  main.append(h('label', {class: 'field-label'}, ['add an account']));
  const modeInput = h('select') as HTMLSelectElement;
  // Claude is the only runtime where we have verified isolated config directories for distinct
  // subscription / Console profiles. Other providers remain honest API-key paths until their
  // respective CLIs expose equivalent profile isolation.
  const modes: CredentialMode[] = credentialProvider === 'claude'
    ? ['subscription', 'platform-credits', 'api-key']
    : ['api-key'];
  for (const mode of modes) modeInput.append(h('option', {value: mode}, [mode === 'platform-credits' ? 'platform API credits' : mode]));
  const labelInput = h('input', {type: 'text', placeholder: 'label'});
  const keyInput = h('input', {type: 'password', placeholder: credentialProvider === 'claude' ? 'sk-ant-...' : 'sk-...'});
  const linkedProvider = credentialProvider === 'qwen' || credentialProvider === 'glm' || credentialProvider === 'nvidia'
    ? credentialProvider
    : undefined;
  const modelLinked = linkedProvider !== undefined;
  const linkDefaults = linkedProvider ? modelLinkDefaults[linkedProvider] : undefined;
  const baseUrlInput = h('input', {type: 'url', value: linkDefaults?.endpoint ?? '', placeholder: modelLinked ? 'OpenAI-compatible endpoint' : 'base URL (optional — e.g. OpenRouter preset)'});
  const modelInput = h('input', {type: 'text', value: linkDefaults?.model ?? '', placeholder: 'model id'});
  const identityInput = h('select') as HTMLSelectElement;
  identityInput.append(h('option', {value: 'automatic'}, ['identity · automatic']));
  identityInput.append(h('option', {value: 'new'}, ['identity · separate login']));
  const seenIdentities = new Set<string>();
  for (const account of chain.accounts) {
    if (seenIdentities.has(account.identityId)) continue;
    seenIdentities.add(account.identityId);
    identityInput.append(h('option', {value: `link:${account.id}`}, [`identity · same login as ${account.label}`]));
  }
  const status = h('p', {class: 'section-sub'}, []);
  const addButton = h('button', {class: 'btn'}, ['add account']);
  const syncAccountForm = () => {
    const apiKeyMode = modeInput.value === 'api-key';
    keyInput.hidden = !apiKeyMode;
    baseUrlInput.hidden = !apiKeyMode || (credentialProvider !== 'claude' && !modelLinked);
    modelInput.hidden = !apiKeyMode || !modelLinked;
    addButton.textContent = apiKeyMode ? 'save API key' : 'add CLI profile';
    status.textContent = apiKeyMode
      ? modelLinked
        ? 'Keys are stored in the operating-system credential store. This account launches OpenCode with its own model and endpoint.'
        : 'Keys are stored in the operating-system credential store.'
      : 'This creates an isolated CLI profile. Fluent shows the exact provider login command after saving.';
  };
  modeInput.addEventListener('change', syncAccountForm);
  syncAccountForm();
  addButton.addEventListener('click', async () => {
    const mode = modeInput.value as CredentialMode;
    const apiKey = keyInput.value.trim();
    if (mode === 'api-key' && !apiKey) return keyInput.focus();
    const identityChoice = identityInput.value;
    try {
      await api.upsertAccount({
        provider: credentialProvider,
        id: crypto.randomUUID(),
        mode,
        label: labelInput.value.trim() || (mode === 'api-key' ? 'API key' : mode === 'subscription' ? 'subscription' : 'platform API credits'),
        apiKey: mode === 'api-key' ? apiKey : undefined,
        baseUrl: mode === 'api-key' && (credentialProvider === 'claude' || modelLinked) ? baseUrlInput.value.trim() || undefined : undefined,
        model: mode === 'api-key' && modelLinked ? modelInput.value.trim() || undefined : undefined,
        sameIdentityAs: identityChoice.startsWith('link:') ? identityChoice.slice('link:'.length) : undefined,
        forceNewIdentity: identityChoice === 'new'
      });
      await renderCredentials(replaceMain(main));
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      status.className = 'error';
    }
  });
  main.append(h('div', {class: 'field'}, [modeInput, labelInput, identityInput, keyInput, modelInput, baseUrlInput, addButton, status]));
}

void render();
