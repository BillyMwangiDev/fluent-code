// Pure helpers for provider usage windows, lane cost, and budgets — no DOM, no RPC. `Window`
// mirrors src/daemon-protocol.ts's QuotaWindow; kept as its own type here rather than imported
// since app/ stays a dependency-free build from src/ (see api.ts's own header comment).
export type Window = {usedPercent?: number; windowMinutes?: number; resetsAt?: string};

function windowUnitLabel(windowMinutes: number | undefined): string {
  if (windowMinutes === undefined) return '';
  return windowMinutes % 1440 === 0 ? `${windowMinutes / 1440}d` : `${Math.round(windowMinutes / 60)}h`;
}

function resetsCountdown(resetsAt: string | undefined, now: Date): string | undefined {
  if (!resetsAt) return undefined;
  const diffMs = new Date(resetsAt).getTime() - now.getTime();
  if (diffMs <= 0) return undefined;
  const totalMinutes = Math.round(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  // A weekly or monthly window resets days out; "614h53m" reads as a bug, "25d 14h" as a date.
  if (hours >= 48) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`;
}

/** "5h 41% · resets 2h12m" / "7d 12%"; undefined when nothing is reported. */
export function windowLabel(window: Window | undefined, now: Date = new Date()): string | undefined {
  if (!window || window.usedPercent === undefined) return undefined;
  const unit = windowUnitLabel(window.windowMinutes);
  const percent = `${unit ? `${unit} ` : ''}${Math.round(window.usedPercent)}%`;
  const countdown = resetsCountdown(window.resetsAt, now);
  return countdown ? `${percent} · resets ${countdown}` : percent;
}

/** 'ok' | 'warn' (≥70%) | 'critical' (≥90%) */
export function windowLevel(window: Window | undefined): 'ok' | 'warn' | 'critical' | undefined {
  if (!window || window.usedPercent === undefined) return undefined;
  if (window.usedPercent >= 90) return 'critical';
  if (window.usedPercent >= 70) return 'warn';
  return 'ok';
}

/** "$0.42" for reported, "≈$0.42" for modelPriced, "cost unknown" for unpriced, undefined when no figure */
export function laneCostText(usage: {costUsd?: number; costSource?: string} | undefined): string | undefined {
  if (!usage) return undefined;
  if (usage.costSource === 'unpriced') return 'cost unknown';
  if (usage.costUsd === undefined) return undefined;
  return usage.costSource === 'modelPriced' ? `≈$${usage.costUsd.toFixed(2)}` : `$${usage.costUsd.toFixed(2)}`;
}

/** whole-number percent of budget used, undefined when not applicable */
export function budgetPercent(costUsd: number | undefined, budgetUsd: number | undefined): number | undefined {
  if (costUsd === undefined || budgetUsd === undefined || budgetUsd <= 0) return undefined;
  return Math.round((costUsd / budgetUsd) * 100);
}

/** Merge per-session quota reports into one window pair per provider (latest observedAt wins). */
export function windowsByProvider(sessions: Array<{provider: string; quota?: {primary?: Window; secondary?: Window; observedAt: string}}>): Map<string, {primary?: Window; secondary?: Window; observedAt: string}> {
  const map = new Map<string, {primary?: Window; secondary?: Window; observedAt: string}>();
  for (const session of sessions) {
    if (!session.quota) continue;
    const existing = map.get(session.provider);
    if (!existing || session.quota.observedAt > existing.observedAt) map.set(session.provider, session.quota);
  }
  return map;
}
