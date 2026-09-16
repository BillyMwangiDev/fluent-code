import type {CostSource} from './spend-tracker.js';

/** Whether a lane's cost has reached its cap, and whether that can even be answered right now. */
export type BudgetVerdict = {over: boolean; percent?: number; costUsd?: number; budgetUsd?: number; enforceable: boolean};

const maxBudgetUsd = 10_000;

/** enforceable=false when the lane has no budget or no cost figure (unpriced) — never stop on a guess of zero. */
export function budgetVerdict(usage: {costUsd?: number; costSource?: CostSource} | undefined, budgetUsd?: number): BudgetVerdict {
  if (budgetUsd === undefined || usage?.costUsd === undefined || usage.costSource === 'unpriced') {
    return {enforceable: false, over: false, costUsd: usage?.costUsd, budgetUsd};
  }
  return {enforceable: true, over: usage.costUsd >= budgetUsd, percent: Math.round((usage.costUsd / budgetUsd) * 100), costUsd: usage.costUsd, budgetUsd};
}

/** A subagent inherits its lead's cap; an explicit cap on the subagent wins. */
export function inheritedBudget(requested: number | undefined, parent: {budgetUsd?: number} | undefined): number | undefined {
  return requested ?? parent?.budgetUsd;
}

/** Valid cap: finite, > 0, ≤ 10_000; anything else throws a plain Error naming the rule. */
export function validBudgetUsd(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maxBudgetUsd) {
    throw new Error(`A lane budget must be a finite number greater than 0 and at most ${maxBudgetUsd}`);
  }
  return value;
}
