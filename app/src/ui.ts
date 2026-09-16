// DOM helpers, dialogs, notices, and formatters shared by every screen. No screen state lives here.
import {open as openDialog} from '@tauri-apps/plugin-dialog';
import type {CredentialChainState, ProviderId, QuotaWindow, VerificationStatus} from './api';

export type Child = Node | string | null | undefined | false;

/** `h('div', {class: 'x'}, [children])` — attrs are set as attributes, `class` sets className.
 * Falsy children are skipped so callers can write `cond && node` without wrapping. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Child[] = []
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') element.className = value;
    else element.setAttribute(key, value);
  }
  for (const child of children) if (child) element.append(child);
  return element;
}

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, children: Array<Node | string> = []): SVGElementTagNameMap[K] {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  for (const child of children) element.append(child);
  return element;
}

/** A button with a click handler in one call. */
export function button(label: Child | Child[], onClick: (event: MouseEvent) => void, attrs: Record<string, string> = {}): HTMLButtonElement {
  const element = h('button', {type: 'button', class: 'btn', ...attrs}, Array.isArray(label) ? label : [label]);
  element.addEventListener('click', onClick);
  return element;
}

/** Inline SVG icons, 16px grid, stroke-based so they inherit `currentColor`. */
export function icon(name: 'plus' | 'stop' | 'play' | 'grid' | 'rows' | 'focus' | 'panel' | 'search' | 'x' | 'more' | 'chevron' | 'check' | 'alert' | 'send' | 'expand' | 'folder' | 'lead' | 'arrow-right' | 'minus' | 'refresh'): SVGSVGElement {
  const paths: Record<string, string[]> = {
    plus: ['M8 3v10', 'M3 8h10'],
    minus: ['M3 8h10'],
    stop: ['M4 4h8v8H4z'],
    play: ['M5 3l8 5-8 5z'],
    grid: ['M2.5 2.5h4.5v4.5H2.5z', 'M9 2.5h4.5v4.5H9z', 'M2.5 9h4.5v4.5H2.5z', 'M9 9h4.5v4.5H9z'],
    focus: ['M2.5 2.5h11v11h-11z', 'M2.5 6h11'],
    rows: ['M2.5 2.5h11v3.5h-11z', 'M2.5 8.5h11v3.5h-11z'],
    panel: ['M2.5 2.5h11v11h-11z', 'M10 2.5v11'],
    search: ['M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z', 'M10.5 10.5L14 14'],
    x: ['M4 4l8 8', 'M12 4l-8 8'],
    more: ['M3.5 8h.01', 'M8 8h.01', 'M12.5 8h.01'],
    chevron: ['M6 4l4 4-4 4'],
    check: ['M3 8.5l3 3 7-7'],
    alert: ['M8 2.5l6 11H2z', 'M8 7v3', 'M8 12h.01'],
    send: ['M2.5 8h11', 'M9.5 4l4 4-4 4'],
    expand: ['M9.5 2.5h4v4', 'M13.5 2.5L9 7', 'M6.5 13.5h-4v-4', 'M2.5 13.5L7 9'],
    folder: ['M2 4.5h4l1.5 1.5H14v7.5H2z'],
    lead: ['M8 2.5l2 4 4 .5-3 3 .8 4.2L8 12l-3.8 2.2.8-4.2-3-3 4-.5z'],
    'arrow-right': ['M3 8h10', 'M9 4l4 4-4 4'],
    refresh: ['M13 8a5 5 0 1 1-1.5-3.6', 'M13 2.5v3h-3']
  };
  const svg = svgEl('svg', {class: `icon icon-${name}`, viewBox: '0 0 16 16', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'});
  for (const d of paths[name] ?? []) svg.append(svgEl('path', {d}));
  return svg;
}

export function markEl(): HTMLElement {
  return h('span', {class: 'mark', 'aria-hidden': 'true'}, [h('span'), h('span'), h('span'), h('span')]);
}

// --- Notices and dialogs ------------------------------------------------------

const actionNotices = h('div', {class: 'action-notices', role: 'status', 'aria-live': 'polite'});
document.body.append(actionNotices);
let noticeTimer: number | undefined;

export function actionErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error:\s*/, '') || 'The action could not be completed.';
}

function notice(text: string, kind: 'error' | 'info', ttl: number) {
  actionNotices.innerHTML = '';
  const item = h('div', {class: `action-notice ${kind}`}, [h('span', {}, [text]), button(icon('x'), () => { actionNotices.innerHTML = ''; }, {class: 'btn ghost icon-button', 'aria-label': 'dismiss'})]);
  actionNotices.append(item);
  if (noticeTimer) window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { actionNotices.innerHTML = ''; }, ttl);
}

/** Every async control gets a visible result if its daemon call rejects. A provider issue must
 * never be mistaken for an unresponsive button. */
export function showActionError(error: unknown) { notice(actionErrorText(error), 'error', 12_000); }
/** A neutral, transient notice, in the same place as action errors. */
export function showNotice(text: string) { notice(text, 'info', 8_000); }

window.addEventListener('unhandledrejection', event => {
  event.preventDefault();
  showActionError(event.reason);
});

/**
 * Asks before a consequential action, inside the app. `window.confirm` is unusable here: Tauri's
 * macOS webview (wry) implements no WKUIDelegate JavaScript panels, so it returns false without
 * showing anything. Escape and cancel both resolve false; a destructive action starts focused on
 * cancel so a stray Enter cannot confirm it.
 */
export function askConfirm(options: {title: string; body: string; detail?: string; confirmLabel: string; danger?: boolean}): Promise<boolean> {
  return new Promise(resolve => {
    const cancel = h('button', {class: 'btn', type: 'button'}, ['cancel']);
    const accept = h('button', {class: options.danger ? 'btn danger' : 'btn primary', type: 'button'}, [options.confirmLabel]);
    const dialog = h('dialog', {class: 'confirm-dialog', 'aria-label': options.title}, [
      h('h2', {}, [options.title]),
      h('p', {}, [options.body]),
      options.detail ? h('pre', {class: 'confirm-detail'}, [options.detail]) : null,
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

/** A right-anchored sheet: the page stays visible and mounted underneath, so opening one never
 * costs a terminal its stream. Closes on Escape, backdrop click, or `close()`. */
export function openSheet(options: {title: string; subtitle?: string; body: HTMLElement; footer?: HTMLElement; wide?: boolean; onClose?: () => void}): {close: () => void; dialog: HTMLDialogElement} {
  const close = h('button', {class: 'btn ghost icon-button', type: 'button', 'aria-label': 'close'}, [icon('x')]);
  const dialog = h('dialog', {class: `sheet${options.wide ? ' wide' : ''}`, 'aria-label': options.title}, [
    h('header', {class: 'sheet-head'}, [
      h('div', {}, [h('h2', {}, [options.title]), options.subtitle ? h('p', {class: 'muted'}, [options.subtitle]) : null]),
      close
    ]),
    h('div', {class: 'sheet-body'}, [options.body]),
    options.footer ? h('footer', {class: 'sheet-foot'}, [options.footer]) : null
  ]);
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { dialog.remove(); options.onClose?.(); });
  document.body.append(dialog);
  dialog.showModal();
  return {close: () => dialog.close(), dialog};
}

/** A small anchored menu of actions. Native `<dialog>` so it escapes any overflow container. */
export function openMenu(anchor: HTMLElement, items: Array<{label: string; onSelect: () => void; danger?: boolean; disabled?: boolean} | 'divider'>) {
  const dialog = h('dialog', {class: 'menu'});
  for (const item of items) {
    if (item === 'divider') { dialog.append(h('hr')); continue; }
    const entry = h('button', {type: 'button', class: `menu-item${item.danger ? ' danger' : ''}`}, [item.label]);
    entry.disabled = Boolean(item.disabled);
    entry.addEventListener('click', () => { dialog.close(); item.onSelect(); });
    dialog.append(entry);
  }
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  const rect = anchor.getBoundingClientRect();
  dialog.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 8)}px`;
  dialog.style.left = `${Math.max(8, Math.min(rect.right - 200, window.innerWidth - 208))}px`;
  dialog.showModal();
  (dialog.querySelector('button:not(:disabled)') as HTMLButtonElement | null)?.focus();
}

// --- Native pickers -------------------------------------------------------------

export function isNativePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(path);
}

/** Opens the OS folder chooser. Limited to one directory: Fluent passes that exact path to the
 * local daemon; it does not receive broad filesystem read access. */
export async function pickDirectory(title: string, defaultPath = ''): Promise<string | undefined> {
  const selected = await openDialog({title, directory: true, multiple: false, ...(isNativePath(defaultPath) ? {defaultPath} : {})});
  return typeof selected === 'string' ? selected : undefined;
}

/** A spec remains on the user's machine. Fluent only passes the chosen local path to the planner
 * lane; it does not upload or parse the document behind the user's back. */
export async function pickSpecFile(title: string, defaultPath = ''): Promise<string | undefined> {
  const selected = await openDialog({title, multiple: false, filters: [{name: 'Specification documents', extensions: ['md', 'mdx', 'txt', 'rst']}], ...(isNativePath(defaultPath) ? {defaultPath} : {})});
  return typeof selected === 'string' ? selected : undefined;
}

export function directoryField(input: HTMLInputElement, onPick?: (path: string) => void, title = 'Choose workspace folder'): HTMLElement {
  const browse = button('browse…', async () => {
    browse.disabled = true;
    try {
      const selected = await pickDirectory(title, input.value.trim());
      if (!selected) return;
      input.value = selected;
      onPick?.(selected);
      input.dispatchEvent(new Event('input', {bubbles: true}));
    } finally {
      browse.disabled = false;
    }
  }, {class: 'btn directory-browse'});
  return h('div', {class: 'directory-field'}, [input, browse]);
}

// --- Formatters -------------------------------------------------------------------

export const providerLabel: Record<ProviderId, string> = {
  claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', qwen: 'Qwen', glm: 'GLM', nvidia: 'NVIDIA NIM'
};
/** Short names for dense chrome: tile headers, the rail, the palette. */
export const providerShort: Record<ProviderId, string> = {
  claude: 'claude', codex: 'codex', gemini: 'gemini', qwen: 'qwen', glm: 'glm', nvidia: 'nvidia'
};
export const modelLinkDefaults: Record<'qwen' | 'glm' | 'nvidia', {model: string; endpoint: string; keyPlaceholder: string}> = {
  qwen: {model: 'qwen3-coder', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyPlaceholder: 'sk-…'},
  glm: {model: 'GLM-4.7', endpoint: 'https://api.z.ai/api/coding/paas/v4', keyPlaceholder: '…'},
  nvidia: {model: 'nvidia/nemotron-3-super', endpoint: 'https://integrate.api.nvidia.com/v1', keyPlaceholder: 'nvapi-…'}
};
// Muted, data-viz-safe series colors matching `.provider-dot` in styles.css — Coral stays reserved
// for actions/alerts/thresholds (AGENTS.md), never an ordinary provider series.
export const providerColor: Record<ProviderId, string> = {
  claude: '#b08968', codex: '#6b8fb0', gemini: '#8a9a6b', qwen: '#5d9990', glm: '#9a7bb3', nvidia: '#739e78'
};

export function workspaceFolderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

export function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatTokens(value: number | undefined) {
  if (value === undefined) return '—';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

export function bytes(value?: number): string {
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

export function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function accountLabel(accountId: string | undefined, chains: CredentialChainState[]): string {
  if (!accountId) return '—';
  for (const chain of chains) {
    const account = chain.accounts.find(candidate => candidate.id === accountId);
    if (account) return account.label;
  }
  return accountId;
}

/** One provider-reported quota window, labelled by its own duration rather than by either
 * vendor's name for it — Claude Code's 5h/7d and Codex's primary/secondary are the same windows. */
export function quotaLabel(window?: QuotaWindow) {
  if (!window || window.usedPercent === undefined) return '—';
  const minutes = window.windowMinutes;
  const name = minutes === undefined ? 'quota' : minutes % 1440 === 0 ? `${minutes / 1440}d` : `${Math.round(minutes / 60)}h`;
  return `${name} ${window.usedPercent.toFixed(0)}%`;
}

/** A lane's state against the project's own checks, kept visually distinct from its process
 * status: a lane can be running and green, or exited and red, and one pill cannot say both. */
export function verificationPill(status?: VerificationStatus) {
  if (!status) return h('span', {class: 'meta'}, ['—']);
  const label = {running: 'checking', passed: 'verified', failed: 'failing', unavailable: 'no checks'}[status];
  return h('span', {class: `pill verify-${status}`}, [label]);
}

/** Lane-ready latency, shown per session rather than averaged away. */
export function laneReady(session: {prepareMs?: number; warmedPaths?: string[]; includedPaths?: string[]; worktreePath?: string}) {
  if (session.prepareMs === undefined) return session.worktreePath ? '—' : 'shared checkout';
  const seconds = session.prepareMs / 1000;
  const duration = seconds < 1 ? `${session.prepareMs}ms` : `${seconds.toFixed(1)}s`;
  const warmed = session.warmedPaths ?? [];
  const included = session.includedPaths ?? [];
  const carried = [warmed.length > 0 ? `warmed ${warmed.join(', ')}` : 'cold'];
  if (included.length > 0) carried.push(`included ${included.join(', ')}`);
  return `${duration} · ${carried.join(' · ')}`;
}

/** The headline of the headroom advice — what the user needs before deciding, in one line. */
export function admissionLabel(verdict: {decision: 'clear' | 'tight' | 'over'; recommendedLanes: number}) {
  if (verdict.decision === 'over') return 'no headroom for another lane';
  if (verdict.decision === 'tight') return 'room for about one more lane';
  return `room for about ${verdict.recommendedLanes} more lanes`;
}

/** The first line of a lane's task, or its folder — what a tile header or rail row calls it. */
export function sessionName(session: {task?: string; directory: string}): string {
  return session.task?.split('\n').map(line => line.trim()).find(Boolean) || workspaceFolderName(session.directory);
}

export const isLive = (session: {status: string}) => session.status === 'running' || session.status === 'starting';

/** A segmented control: one active option, `onChange` when another is picked. */
export function segmented<T extends string>(options: ReadonlyArray<{id: T; label: string}>, active: T, onChange: (id: T) => void, attrs: Record<string, string> = {}): HTMLElement {
  const group = h('div', {class: 'segmented', role: 'group', ...attrs});
  for (const option of options) {
    const item = h('button', {type: 'button', class: `seg${option.id === active ? ' active' : ''}`, 'aria-pressed': option.id === active ? 'true' : 'false'}, [option.label]);
    item.addEventListener('click', () => {
      if (option.id === active) return;
      active = option.id;
      for (const sibling of group.children) { sibling.classList.remove('active'); sibling.setAttribute('aria-pressed', 'false'); }
      item.classList.add('active');
      item.setAttribute('aria-pressed', 'true');
      onChange(option.id);
    });
    group.append(item);
  }
  return group;
}

/** Keyboard shortcut label rendered as a `<kbd>` group. */
export function kbd(keys: string): HTMLElement {
  return h('kbd', {class: 'kbd'}, [keys.replace('mod', navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl')]);
}

export function isMod(event: KeyboardEvent) {
  return navigator.platform.startsWith('Mac') ? event.metaKey : event.ctrlKey;
}
