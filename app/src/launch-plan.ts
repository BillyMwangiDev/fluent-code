// The launch sheet's model, kept free of DOM so it can be tested: which providers can start a
// lane right now, how many of each the user asked for, and the ordered list of lanes to create.
import type {CredentialChainState, ProviderHealth, ProviderId} from './api';

export const providerOrder: readonly ProviderId[] = ['claude', 'codex', 'gemini', 'glm', 'qwen', 'nvidia'];

/** Providers that run through OpenCode need a connected API-key account with a model; the CLI
 * has nothing of its own to log in to. */
export const modelLinkedProviders: ReadonlySet<ProviderId> = new Set<ProviderId>(['qwen', 'glm', 'nvidia']);

export type ProviderReadiness = {
  id: ProviderId;
  label: string;
  installed: boolean;
  version?: string;
  /** Whether a lane can start now. */
  ready: boolean;
  /** Why it cannot, in one line the sheet can show under the stepper. */
  blocker?: 'not installed' | 'needs an API key';
  /** The account a lane would use, when Fluent manages one. */
  accountLabel?: string;
  model?: string;
};

export function providerReadiness(providers: readonly ProviderHealth[], chains: readonly CredentialChainState[]): ProviderReadiness[] {
  return providerOrder.map(id => {
    const health = providers.find(provider => provider.id === id);
    const chain = chains.find(candidate => candidate.provider === id);
    const active = chain?.accounts.find(account => account.id === chain.activeAccountId) ?? chain?.accounts[0];
    const installed = Boolean(health?.installed);
    const linked = modelLinkedProviders.has(id);
    const hasKeyedAccount = Boolean(active && active.mode === 'api-key' && (active.model || !linked));
    const ready = installed && (!linked || hasKeyedAccount);
    return {
      id,
      label: health?.label ?? id,
      installed,
      version: health?.version,
      ready,
      blocker: !installed ? 'not installed' : linked && !hasKeyedAccount ? 'needs an API key' : undefined,
      accountLabel: active?.label,
      model: active?.model
    };
  });
}

export const maxLanesPerProvider = 10;
export const maxLanesPerLaunch = 20;

export function clampCount(value: unknown): number {
  const count = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.min(maxLanesPerProvider, Math.round(count)));
}

export type LaunchCounts = Partial<Record<ProviderId, number>>;

/** Counts a first-time user sees: one lane on the first ready provider, so the sheet is never a
 * wall of zeros; a returning user gets their last counts, minus providers that stopped being ready. */
export function defaultCounts(readiness: readonly ProviderReadiness[], remembered: Record<string, number>): LaunchCounts {
  const counts: LaunchCounts = {};
  let any = false;
  for (const provider of readiness) {
    const value = clampCount(remembered[provider.id]);
    if (provider.ready && value > 0) { counts[provider.id] = value; any = true; }
  }
  if (!any) {
    const first = readiness.find(provider => provider.ready);
    if (first) counts[first.id] = 1;
  }
  return counts;
}

/** The ordered lanes a launch creates: providers in display order, interleaved so a mixed launch
 * gets its first lane of every provider early rather than all Claude lanes before any Codex. */
export function launchPlan(counts: LaunchCounts, readiness: readonly ProviderReadiness[]): ProviderId[] {
  const remaining = readiness
    .filter(provider => provider.ready)
    .map(provider => ({id: provider.id, left: clampCount(counts[provider.id])}))
    .filter(entry => entry.left > 0);
  const plan: ProviderId[] = [];
  while (remaining.some(entry => entry.left > 0) && plan.length < maxLanesPerLaunch) {
    for (const entry of remaining) {
      if (entry.left === 0 || plan.length >= maxLanesPerLaunch) continue;
      plan.push(entry.id);
      entry.left -= 1;
    }
  }
  return plan;
}

export function describePlan(plan: readonly ProviderId[], shortLabel: (id: ProviderId) => string): string {
  if (plan.length === 0) return 'no lanes';
  const counts = new Map<ProviderId, number>();
  for (const id of plan) counts.set(id, (counts.get(id) ?? 0) + 1);
  const parts = [...counts].map(([id, count]) => `${count} ${shortLabel(id)}`);
  return `${plan.length} lane${plan.length === 1 ? '' : 's'} · ${parts.join(' · ')}`;
}
