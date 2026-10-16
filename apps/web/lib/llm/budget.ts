import { BUDGET, PROTECTED_TIERS, type Tier } from "./config";
import { roundUsd } from "./pricing";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One credit cycle, in UTC. Credits refresh on the plan's billing day, not on the 1st. */
export interface CycleWindow {
  start: Date;
  /** Exclusive: the next cycle's start. */
  end: Date;
  /** 1-based day of the cycle that `now` falls on. */
  day: number;
  days: number;
}

function anchorIn(year: number, month: number, anchorDay: number): Date {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(anchorDay, lastDay)));
}

export function cycleWindow(now: Date, anchorDay: number = BUDGET.cycleStartDay): CycleWindow {
  let start = anchorIn(now.getUTCFullYear(), now.getUTCMonth(), anchorDay);
  if (now < start) start = anchorIn(now.getUTCFullYear(), now.getUTCMonth() - 1, anchorDay);
  const end = anchorIn(start.getUTCFullYear(), start.getUTCMonth() + 1, anchorDay);
  return {
    start,
    end,
    day: Math.floor((now.getTime() - start.getTime()) / DAY_MS) + 1,
    days: Math.round((end.getTime() - start.getTime()) / DAY_MS)
  };
}

/** "2026-10-01": scopes one-shot events (alerts, passes) to a single cycle. */
export function cycleId(window: CycleWindow): string {
  return window.start.toISOString().slice(0, 10);
}

/** Set when the API reports the credit gone; cleared by nothing but the next cycle. */
export function exhaustedEventKey(window: CycleWindow): string {
  return `credit-exhausted:${cycleId(window)}`;
}

export type BudgetLevel = "normal" | "soft-stop" | "hard-stop";

export function budgetLevel(committedUsd: number): BudgetLevel {
  const ratio = committedUsd / BUDGET.creditUsd;
  if (ratio >= BUDGET.hardStopRatio) return "hard-stop";
  if (ratio >= BUDGET.softStopRatio) return "soft-stop";
  return "normal";
}

export interface BudgetState {
  window: CycleWindow;
  /** Recorded this cycle, from the `usage` of calls that completed. */
  spentUsd: number;
  /** Reserved for batches submitted but not yet collected — an upper bound. */
  pendingUsd: number;
  /** Spent plus pending: what the stops are measured against. */
  committedUsd: number;
  level: BudgetLevel;
  /** The API reported the credit exhausted this cycle; nothing runs until it refreshes. */
  exhausted: boolean;
  /** Where spend lands at the end of the cycle if this cycle's run rate holds. */
  projectedUsd: number;
}

export function budgetState({
  now,
  spentUsd,
  pendingUsd,
  exhausted = false
}: {
  now: Date;
  spentUsd: number;
  pendingUsd: number;
  exhausted?: boolean;
}): BudgetState {
  const window = cycleWindow(now);
  const elapsedDays = Math.max((now.getTime() - window.start.getTime()) / DAY_MS, 1);
  const committedUsd = roundUsd(spentUsd + pendingUsd);
  return {
    window,
    spentUsd: roundUsd(spentUsd),
    pendingUsd: roundUsd(pendingUsd),
    committedUsd,
    level: budgetLevel(committedUsd),
    exhausted,
    projectedUsd: roundUsd((spentUsd / elapsedDays) * window.days)
  };
}

/** The state after a job's cost lands, so one run's later jobs see its earlier ones. */
export function charge(state: BudgetState, usd: number, pending = false): BudgetState {
  const spentUsd = pending ? state.spentUsd : roundUsd(state.spentUsd + usd);
  const pendingUsd = pending ? roundUsd(state.pendingUsd + usd) : state.pendingUsd;
  const committedUsd = roundUsd(spentUsd + pendingUsd);
  return { ...state, spentUsd, pendingUsd, committedUsd, level: budgetLevel(committedUsd) };
}

export interface GateDecision {
  allowed: boolean;
  /** The level the job would leave the budget at. */
  level: BudgetLevel;
  reason?: string;
}

/**
 * Asked before every LLM job, with the job's worst-case cost. Below the soft
 * stop everything runs as scheduled; between the soft and the hard stop only
 * protected tiers do; past the hard stop — or once the API has said the credit
 * is gone — every job is deferred to the next cycle. Structural probes never
 * pass through here: they do not spend credit.
 */
export function gate(state: BudgetState, tier: Tier, estimateUsd: number): GateDecision {
  if (state.exhausted) {
    return {
      allowed: false,
      level: "hard-stop",
      reason: "The API reported the credit exhausted; LLM jobs resume when it refreshes."
    };
  }
  const level = budgetLevel(state.committedUsd + estimateUsd);
  if (level === "hard-stop") {
    return {
      allowed: false,
      level,
      reason: `Would cross the hard stop (${BUDGET.hardStopRatio * 100}% of $${BUDGET.creditUsd}).`
    };
  }
  if (level === "soft-stop" && !PROTECTED_TIERS.includes(tier)) {
    return {
      allowed: false,
      level,
      reason: `Past the soft stop (${BUDGET.softStopRatio * 100}%): only ${PROTECTED_TIERS.join(" and ")} servers run.`
    };
  }
  return { allowed: true, level };
}
