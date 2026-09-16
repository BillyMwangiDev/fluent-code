// Presentation preferences stay on this machine. Project coordination remains in fluentd and is
// never changed by a user's preferred view. Every read tolerates a blocked storage.
import type {ExplorerScope} from './coordination-explorer';
import {isExplorerScope} from './coordination-explorer';

export type Appearance = 'system' | 'dark' | 'light';
export type ThemeMode = 'dark' | 'light';
export type LaneLayout = 'grid' | 'rows' | 'focus';

const keys = {
  appearance: 'fluent.appearance',
  bundles: 'fluent.theme-bundles',
  workspacePath: 'fluent.workspace-path',
  explorerScope: 'fluent.orchestration-explorer.scope.v1',
  sidebar: 'fluent.workspace.sidebar.v1',
  laneLayout: 'fluent.workspace.layout.v1',
  launchCounts: 'fluent.launch.counts.v1',
  launchOptions: 'fluent.launch.options.v1',
  recentWorkspaces: 'fluent.recent-workspaces.v1',
  launchMode: 'fluent.launch.mode.v1',
  leadProvider: 'fluent.launch.lead.v1',
  previewUrl: 'fluent.preview-url',
  rail: 'fluent.rail.v1'
} as const;

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private-browsing or blocked storage never blocks the app */ }
}
function readJson<T>(key: string, fallback: T): T {
  const raw = read(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** Keeps the last five distinct workspace paths, most recent first — called by the workspacePath
 * setter below, so every place that picks a workspace feeds the empty state's "recent" chips. */
function rememberWorkspace(path: string) {
  const trimmed = path.trim();
  if (!trimmed) return;
  const current = readJson<string[]>(keys.recentWorkspaces, []);
  write(keys.recentWorkspaces, JSON.stringify([trimmed, ...current.filter(candidate => candidate !== trimmed)].slice(0, 5)));
}

// Fluent Dark is the first-run bundle. System remains available as an explicit preference, but
// letting a light OS silently choose the initial product surface contradicts the desktop design
// contract and makes first impressions vary by machine.
export const prefs = {
  get appearance(): Appearance { return (read(keys.appearance) as Appearance | null) ?? 'dark'; },
  set appearance(value: Appearance) { write(keys.appearance, value); },
  get bundles(): Record<ThemeMode, string> { return readJson(keys.bundles, {dark: 'Fluent Dark', light: 'Fluent Light'}); },
  set bundles(value: Record<ThemeMode, string>) { write(keys.bundles, JSON.stringify(value)); },
  // A workspace is a local path chosen by the user, never a path from the machine that built the
  // app. It is an input default only; each session still records its own working directory.
  get workspacePath(): string { return read(keys.workspacePath) ?? ''; },
  set workspacePath(value: string) { write(keys.workspacePath, value); rememberWorkspace(value); },
  /** Last five workspace folders, most recent first — for the empty state's "recent" chips. */
  get recentWorkspaces(): string[] { return readJson(keys.recentWorkspaces, []); },
  get explorerScope(): ExplorerScope { const saved = read(keys.explorerScope); return isExplorerScope(saved) ? saved : 'overview'; },
  set explorerScope(value: ExplorerScope) { write(keys.explorerScope, value); },
  get railCollapsed(): boolean { return read(keys.rail) === 'collapsed'; },
  set railCollapsed(value: boolean) { write(keys.rail, value ? 'collapsed' : 'expanded'); },
  get sidebarOpen(): boolean { return read(keys.sidebar) !== 'closed'; },
  set sidebarOpen(value: boolean) { write(keys.sidebar, value ? 'open' : 'closed'); },
  get laneLayout(): LaneLayout { const saved = read(keys.laneLayout); return saved === 'focus' || saved === 'rows' ? saved : 'grid'; },
  set laneLayout(value: LaneLayout) { write(keys.laneLayout, value); },
  get launchCounts(): Record<string, number> { return readJson(keys.launchCounts, {}); },
  set launchCounts(value: Record<string, number>) { write(keys.launchCounts, JSON.stringify(value)); },
  get launchOptions(): {isolate?: boolean; budgetUsd?: number} { return readJson(keys.launchOptions, {}); },
  set launchOptions(value: {isolate?: boolean; budgetUsd?: number}) { write(keys.launchOptions, JSON.stringify(value)); },
  get launchMode(): 'orchestrate' | 'parallel' { return read(keys.launchMode) === 'parallel' ? 'parallel' : 'orchestrate'; },
  set launchMode(value: 'orchestrate' | 'parallel') { write(keys.launchMode, value); },
  get leadProvider(): string | undefined { return read(keys.leadProvider) ?? undefined; },
  set leadProvider(value: string) { write(keys.leadProvider, value); },
  get previewUrl(): string | null { return read(keys.previewUrl); },
  set previewUrl(value: string) { write(keys.previewUrl, value); }
};

export function resolvedMode(): ThemeMode {
  const appearance = prefs.appearance;
  return appearance === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : appearance;
}

export function applyAppearance() {
  document.documentElement.dataset.theme = resolvedMode();
  document.documentElement.dataset.bundle = prefs.bundles[resolvedMode()];
}
