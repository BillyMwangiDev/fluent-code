import type {AdmissionVerdict, ProviderId, QuotaWindow} from './daemon-protocol.js';
import type {ProcessSample} from './resource-monitor-client.js';

/**
 * What one lane is assumed to cost before this machine has said otherwise. Deliberately a starting
 * point, not a claim: spec §14 flagged that "safe concurrent-agent count" needed a real heuristic
 * and real-world tuning, and the honest version of that is a default that observation replaces as
 * soon as there is any to go on.
 */
const defaultLaneBytes = Number(process.env.FLUENT_LANE_BYTES ?? 800 * 1024 * 1024);

/** Memory left for the operating system, the user's editor, and everything else that is not a lane. */
export function reserveBytes(memoryTotalBytes: number) {
  return Math.max(2 * 1024 * 1024 * 1024, memoryTotalBytes * 0.12);
}

/** Below this many observations, the machine has not said enough for its own number to beat the default. */
const minimumSamples = 3;

/** Quota use at which a lane is worth warning about, and at which it is spent. */
const quotaTightPercent = 90;
const quotaSpentPercent = 100;

export type AdmissionInput = {
  provider: ProviderId;
  runningLanes: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  /** Resident bytes previously observed for whole lane process trees of this provider. */
  observedLaneBytes: readonly number[];
  quota?: {window?: QuotaWindow; accountId?: string};
};

/** The value below which `fraction` of the samples fall — p90 rather than a mean, because the
 * lane that matters is the heavy one, not the average one. */
export function percentile(values: readonly number[], fraction: number) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

/** Resident bytes of a process and everything it spawned — an agent CLI's children are its cost
 * too, and attributing only the PTY's own process would understate a lane several times over. */
export function processTreeBytes(processes: readonly ProcessSample[], rootPid: number) {
  const children = new Map<number, number[]>();
  const resident = new Map<number, number>();
  for (const process of processes) {
    resident.set(process.pid, process.residentBytes);
    children.set(process.ppid, [...(children.get(process.ppid) ?? []), process.pid]);
  }
  if (!resident.has(rootPid)) return undefined;

  let total = 0;
  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += resident.get(pid) ?? 0;
    for (const child of children.get(pid) ?? []) queue.push(child);
  }
  return total;
}

/**
 * Whether this machine and this credential have room for another lane.
 *
 * This advises and never refuses. Spec §2 principle 4 and §13 are explicit that resource
 * intelligence is advisory in v1 and that a hard scheduler is not a commitment — so the verdict is
 * something to show a user before they open a lane, not a gate the daemon enforces. Per-agent
 * resource use varies too much to gate on reliably, which is exactly why the estimate here is
 * replaced by observation the moment observation exists.
 *
 * Two inputs, because they fail differently. Running out of memory degrades every lane at once;
 * running out of quota fails one lane *after* the user has already invested attention in it, which
 * is the worse surprise.
 */
export function assessAdmission(input: AdmissionInput): AdmissionVerdict {
  const observed = percentile(input.observedLaneBytes, 0.9);
  const useObserved = input.observedLaneBytes.length >= minimumSamples && observed !== undefined;
  const perLaneBytes = useObserved ? observed! : defaultLaneBytes;
  const reserve = reserveBytes(input.memoryTotalBytes);
  const freeBytes = Math.max(0, input.memoryTotalBytes - input.memoryUsedBytes);
  const headroom = Math.max(0, freeBytes - reserve);
  const recommendedLanes = Math.floor(headroom / Math.max(perLaneBytes, 1));

  const reasons: string[] = [];
  let decision: AdmissionVerdict['decision'] = 'clear';
  const atLeast = (next: AdmissionVerdict['decision']) => {
    const rank = {clear: 0, tight: 1, over: 2};
    if (rank[next] > rank[decision]) decision = next;
  };

  if (recommendedLanes === 0) {
    atLeast('over');
    reasons.push(`Not enough free memory for another lane: ${gb(headroom)} usable after keeping ${gb(reserve)} for the rest of the machine, against about ${gb(perLaneBytes)} per lane.`);
  } else if (recommendedLanes === 1) {
    atLeast('tight');
    reasons.push(`Room for about one more lane: ${gb(headroom)} usable against about ${gb(perLaneBytes)} per lane.`);
  } else {
    reasons.push(`Room for about ${recommendedLanes} more lanes: ${gb(headroom)} usable against about ${gb(perLaneBytes)} per lane.`);
  }
  reasons.push(useObserved
    ? `Per-lane estimate is the 90th percentile of ${input.observedLaneBytes.length} lanes measured on this machine.`
    : 'Per-lane estimate is a default; it will be replaced once this machine has run a few lanes.');

  const used = input.quota?.window?.usedPercent;
  if (used !== undefined && used >= quotaSpentPercent) {
    atLeast('over');
    reasons.push(`This credential's quota is spent${resetPhrase(input.quota?.window)} — a lane started now will fail after you have invested attention in it.`);
  } else if (used !== undefined && used >= quotaTightPercent) {
    atLeast('tight');
    reasons.push(`This credential is at ${Math.round(used)}% of its window${resetPhrase(input.quota?.window)}.`);
  }

  return {
    provider: input.provider,
    decision,
    recommendedLanes,
    runningLanes: input.runningLanes,
    freeBytes,
    reserveBytes: reserve,
    perLaneBytes,
    estimateSource: useObserved ? 'observed' : 'default',
    quotaUsedPercent: used,
    quotaResetsAt: input.quota?.window?.resetsAt,
    accountId: input.quota?.accountId,
    reasons
  };
}

function gb(bytes: number) {
  const gigabytes = bytes / (1024 * 1024 * 1024);
  return gigabytes >= 10 ? `${Math.round(gigabytes)} GB` : `${gigabytes.toFixed(1)} GB`;
}

function resetPhrase(window?: QuotaWindow) {
  if (!window?.resetsAt) return '';
  const minutes = Math.round((new Date(window.resetsAt).getTime() - Date.now()) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  return minutes < 60 ? `, resetting in about ${minutes} minutes` : `, resetting in about ${Math.round(minutes / 60)} hours`;
}

/**
 * Learns what a lane costs on this machine.
 *
 * The alternative was a constant, and a constant is wrong everywhere: a Rust project's agent and a
 * small Node project's agent do not cost remotely the same, and neither does the same agent on a
 * laptop and on a workstation. Samples are kept per provider and bounded, so the estimate tracks
 * what the machine is doing lately rather than what it did last month.
 */
export class AdmissionAdvisor {
  private readonly samples = new Map<ProviderId, number[]>();
  private static readonly maxSamples = 40;

  /** Records the current cost of each running lane. Lanes whose process cannot be found in the
   * snapshot are skipped rather than recorded as zero, which would drag the estimate down. */
  sample(lanes: readonly {provider: ProviderId; pid?: number}[], processes: readonly ProcessSample[]) {
    for (const lane of lanes) {
      if (lane.pid === undefined) continue;
      const bytes = processTreeBytes(processes, lane.pid);
      if (bytes === undefined || bytes <= 0) continue;
      const existing = this.samples.get(lane.provider) ?? [];
      this.samples.set(lane.provider, [...existing, bytes].slice(-AdmissionAdvisor.maxSamples));
    }
  }

  observed(provider: ProviderId) {
    return this.samples.get(provider) ?? [];
  }

  assess(input: Omit<AdmissionInput, 'observedLaneBytes'>) {
    return assessAdmission({...input, observedLaneBytes: this.observed(input.provider)});
  }
}
