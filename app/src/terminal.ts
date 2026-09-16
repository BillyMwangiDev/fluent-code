import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {api, subscribeSession, type SessionSnapshot, type SessionSummary} from './api';
import {actionErrorText, showActionError} from './ui';

export function terminalTheme() {
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
    blue: token('--ansi-blue'),
    brightBlue: token('--ansi-blue'),
    magenta: token('--ansi-magenta'),
    brightMagenta: token('--ansi-magenta'),
    cyan: token('--ansi-cyan'),
    brightCyan: token('--ansi-cyan')
  };
}

export function terminalFontSize() {
  const size = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--terminal-font-size'), 10);
  return Number.isFinite(size) ? size : 13;
}

export type LaneTerminal = {
  snapshot: SessionSnapshot;
  terminal: Terminal;
  /** Re-measures the container and resizes the PTY to match. Safe to call while hidden. */
  fit: () => void;
  focus: () => void;
  dispose: () => void;
};

/**
 * Mounts one lane's live terminal: xterm.js on the lane's PTY stream, keystrokes back to the lane.
 *
 * Output pushed before the snapshot arrives is held and written after it, or the screen is drawn
 * out of order. Replaying the snapshot re-runs every terminal query the CLI sent while nobody was
 * watching — cursor position, colours, device attributes — which xterm.js answers again; those
 * stale answers would be typed into the lane as if the user had typed them, so input is muted
 * until the replay is done.
 */
/** Tile type steps down with the tile: 12px above 520px wide, 11px above 400px, 10px below, so a
 * lane in a dense grid keeps close to eighty columns instead of wrapping every line. */
export function fontSizeForWidth(width: number, base: number): number {
  if (width >= 520) return base;
  if (width >= 400) return Math.max(10, base - 1);
  return Math.max(9, base - 2);
}

export async function attachLaneTerminal(sessionId: string, container: HTMLElement, options: {fontSize?: number; scaleWithWidth?: boolean; onStatus?: (summary: SessionSummary) => void; onOutput?: () => void} = {}): Promise<LaneTerminal> {
  const terminal = new Terminal({
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
    fontSize: options.fontSize ?? terminalFontSize(),
    lineHeight: 1.2,
    cursorBlink: false,
    scrollback: 4000,
    theme: terminalTheme(),
    allowProposedApi: true
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  // Re-read the palette once the terminal's own DOM exists, in case opening it raced the
  // stylesheet — cheap, and it makes the constructor's `theme` option provably redundant rather
  // than load-bearing.
  terminal.options.theme = terminalTheme();
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
      else { terminal.write(chunk); options.onOutput?.(); }
    },
    onStatus: summary => options.onStatus?.(summary)
  });
  let disposed = false;
  let lastSize = '';
  // The daemon spawns the PTY at a fixed default size before any view has measured itself, and a
  // grid tile is much smaller than the single-lane view — keep the PTY at whatever is rendered, or
  // the CLI draws (and wraps) for a grid that doesn't match the screen. A hidden container has no
  // size; fitting it would collapse the PTY to nothing, so those calls are skipped.
  const baseFontSize = options.fontSize ?? terminalFontSize();
  const fit = () => {
    if (disposed || !container.isConnected || container.clientWidth < 40 || container.clientHeight < 20) return;
    if (options.scaleWithWidth) {
      const next = fontSizeForWidth(container.clientWidth, baseFontSize);
      if (terminal.options.fontSize !== next) terminal.options.fontSize = next;
    }
    fitAddon.fit();
    const size = `${terminal.cols}x${terminal.rows}`;
    if (size === lastSize) return;
    lastSize = size;
    void api.resize(sessionId, terminal.cols, terminal.rows).catch(() => undefined);
  };
  const resizeObserver = new ResizeObserver(() => fit());
  // Appearance mode can change while this lane's pane stays mounted — the OS-preference listener
  // in main.ts flips `data-theme` for a 'system' user with no navigation in between, and a theme
  // bundle switch on the themes page does the same for `data-bundle`. xterm.js only reads `theme`
  // once, so without this the pane keeps rendering the palette it was opened with.
  const themeObserver = new MutationObserver(() => { terminal.options.theme = terminalTheme(); });
  themeObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme', 'data-bundle']});
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    resizeObserver.disconnect();
    themeObserver.disconnect();
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
    return {snapshot, terminal, fit, focus: () => terminal.focus(), dispose};
  }
  resizeObserver.observe(container);
  fit();
  return {snapshot, terminal, fit, focus: () => terminal.focus(), dispose};
}
