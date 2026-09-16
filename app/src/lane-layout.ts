// How many columns a lane grid gets for a given number of lanes and plane size. A TUI wants width
// more than height, so the grid picks the column count whose cells come closest to a wide, readable
// terminal cell, and adds rows before it squeezes columns below that.

export type GridShape = {columns: number; rows: number};

/** Columns and rows for `count` lanes in a plane `width`×`height` px. `cellWidth`×`cellHeight` is
 * the cell every lane would ideally get; the shape chosen is the one whose cells fit that target
 * best on their tighter axis. Ties go to fewer columns, which keeps terminals wide. */
export function gridShape(count: number, width: number, height: number, cellWidth = 460, cellHeight = 320): GridShape {
  if (count <= 0) return {columns: 1, rows: 1};
  let best: GridShape = {columns: 1, rows: count};
  let bestScore = -Infinity;
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const score = Math.min((width / columns) / cellWidth, (height / rows) / cellHeight);
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = {columns, rows};
    }
  }
  return best;
}

export type Diff<T> = {added: T[]; removed: string[]; kept: T[]};

/** What changed between two lists of records with ids, so a view can patch instead of rebuild. */
export function diffById<T extends {id: string}>(previous: readonly T[], next: readonly T[]): Diff<T> {
  const before = new Set(previous.map(item => item.id));
  const after = new Set(next.map(item => item.id));
  return {
    added: next.filter(item => !before.has(item.id)),
    removed: previous.filter(item => !after.has(item.id)).map(item => item.id),
    kept: next.filter(item => before.has(item.id))
  };
}

/** The lane to focus after the focused one disappears: its neighbour, or nothing. */
export function nextFocus(order: readonly string[], focused: string | undefined, removed: readonly string[]): string | undefined {
  if (!focused || !removed.includes(focused)) return focused && order.includes(focused) ? focused : order[0];
  const index = order.indexOf(focused);
  const remaining = order.filter(id => !removed.includes(id));
  if (remaining.length === 0) return undefined;
  return remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
}
