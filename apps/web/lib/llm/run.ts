import type Anthropic from "@anthropic-ai/sdk";
import type { ToolDef } from "mcp-surface-lint";
import { loadResult, loadSeeds } from "../directory/data";
import type { ScanResult, Seed } from "../directory/types";
import { cycleWindow, exhaustedEventKey, type BudgetState } from "./budget";
import type { EvalClient } from "./client";
import {
  PROMPT_VERSIONS,
  SELECTION_SETTINGS,
  SONNET,
  SURFACE_LIMITS,
  TIER_PRIORITY,
  type Mode,
  type ModelId
} from "./config";
import { summariseSelection, type ScenarioOutcome } from "./jobs/selection";
import type { JobKind } from "./keys";
import type { BatchRequestMeta, JobRecord, LlmLedger } from "./ledger";
import { roundUsd } from "./pricing";
import {
  readEvalFile,
  withRun,
  writeEvalFile,
  type Footprint,
  type ScenarioSet,
  type SelectionRun
} from "./results";
import { loadSurface, sampleTools, type Surface } from "./surface";

/** Shared by the standard-API path (runner.ts) and the batch path (batch.ts). */

export interface RunOptions {
  /** Absent in a dry run: nothing is sent to the API. */
  client?: EvalClient;
  ledger: LlmLedger;
  now: Date;
  /** Limit the run to these slugs. */
  only?: ReadonlySet<string>;
  log: (line: string) => void;
}

/** A directory server the layer can work on: it has a captured surface. */
export interface EvalTarget {
  seed: Seed;
  surface: Surface;
  scan?: ScanResult;
}

/** Every target, the tiers that matter most first: when the budget is tight, they go first. */
export function evalTargets(only?: ReadonlySet<string>): EvalTarget[] {
  const targets = loadSeeds().flatMap((seed) => {
    if (only && !only.has(seed.slug)) return [];
    const surface = loadSurface(seed.slug);
    return surface ? [{ seed, surface, scan: loadResult(seed.slug) }] : [];
  });
  return targets.sort(
    (a, b) =>
      TIER_PRIORITY.indexOf(a.seed.tier) - TIER_PRIORITY.indexOf(b.seed.tier) ||
      a.seed.slug.localeCompare(b.seed.slug)
  );
}

export type FootprintOutcome = "counted" | "current" | "rejected" | "failed" | "planned";

export type JobOutcome =
  | "done"
  | "submitted"
  | "current"
  | "planned"
  | "deferred"
  | "throttled"
  | "in-flight"
  | "gave-up"
  | "failed"
  | "skipped";

export interface JobReport {
  slug: string;
  job: JobKind;
  model: ModelId;
  outcome: JobOutcome;
  detail?: string;
  usd?: number;
}

export interface BatchReport {
  id: string;
  outcome: "submitted" | "in-progress" | "collected" | "failed";
  requests: number;
  detail?: string;
  usd?: number;
}

export interface RunReport {
  footprints: { slug: string; outcome: FootprintOutcome; detail?: string }[];
  jobs: JobReport[];
  batches: BatchReport[];
  /** Paths under data/evals that this run rewrote. */
  written: string[];
  /** The API said the credit is gone; the run stopped spending. */
  exhausted: boolean;
  budget?: BudgetState;
}

/** A transient failure gets one retry, in the next run; after that the key is left alone. */
export const MAX_ATTEMPTS = 2;

/** A run with more failed calls than this share is not published. */
export const MAX_ERRORED_SHARE = 0.2;

/** Requests waiting to go out as one or more message batches at the end of the run. */
export interface BatchDraft {
  chunks: {
    requests: Anthropic.Messages.BatchCreateParams.Request[];
    meta: Record<string, BatchRequestMeta>;
    jobs: { record: JobRecord; estimate: number }[];
    bytes: number;
  }[];
}

export interface Run extends RunOptions {
  report: RunReport;
  state: BudgetState;
  draft: BatchDraft;
}

/** Thrown when the credit runs out mid-run: everything still queued waits for the next cycle. */
export class CreditExhausted extends Error {}

export async function markExhausted(run: Run): Promise<void> {
  run.report.exhausted = true;
  run.state = { ...run.state, exhausted: true };
  await run.ledger.claimEvent(exhaustedEventKey(cycleWindow(run.now)), "credit-exhausted", {
    at: run.now.toISOString()
  });
}

export function written(run: Run, slug: string, file: string, changed: boolean): void {
  if (changed) run.report.written.push(`data/evals/${slug}/${file}`);
}

/** What the models are shown: the whole surface, or a stable sample of an oversized one. */
export interface EvalSurface {
  tools: ToolDef[];
  sampled: { tools: number; of: number } | null;
  footprint: Footprint;
}

export function evalSurface(target: EvalTarget): EvalSurface | string {
  const footprint = readEvalFile(target.seed.slug, "footprint");
  if (!footprint || footprint.tools_hash !== target.surface.toolsHash) {
    return "waiting for this surface's token count";
  }
  if (footprint.error) return "the API rejects this surface";
  const size = footprint.models[SONNET] ?? 0;
  const { tools, toolsHash } = target.surface;
  if (size <= SURFACE_LIMITS.maxTokens) return { tools, sampled: null, footprint };
  return {
    tools: sampleTools(tools, toolsHash, SURFACE_LIMITS.sampleSize),
    sampled: { tools: Math.min(SURFACE_LIMITS.sampleSize, tools.length), of: tools.length },
    footprint
  };
}

export function jobRecord(
  run: Run,
  key: string,
  job: JobKind,
  slug: string,
  model: ModelId,
  attempts: number,
  mode: Mode
): JobRecord {
  return {
    key,
    job,
    serverId: slug,
    model,
    status: "submitted",
    mode,
    batchId: null,
    attempts,
    lastError: null,
    result: null,
    createdAt: run.now,
    updatedAt: run.now,
    completedAt: null
  };
}

export function publishScenarios(run: Run, set: ScenarioSet): void {
  written(run, set.slug, "scenarios.json", writeEvalFile(set.slug, "scenarios", set));
}

export function publishSelection(run: Run, slug: string, result: SelectionRun): void {
  const selection = withRun(readEvalFile(slug, "selection"), slug, result);
  written(run, slug, "selection.json", writeEvalFile(slug, "selection", selection));
}

export function erroredOutcome(id: string): ScenarioOutcome {
  return { id, called: [], stop: "error", correct: null, args_valid: null, args_match: null };
}

/**
 * The published form of a finished selection run, or an error when too many
 * of its calls failed for the numbers to mean anything.
 */
export function selectionRun(fields: {
  key: string;
  model: ModelId;
  toolsHash: string;
  set: ScenarioSet;
  mode: Mode;
  now: Date;
  sampled: EvalSurface["sampled"];
  outcomes: ScenarioOutcome[];
  usd: number;
}): SelectionRun {
  const errored = fields.outcomes.filter((outcome) => outcome.stop === "error").length;
  if (errored > fields.outcomes.length * MAX_ERRORED_SHARE) {
    throw new Error(`${errored} of ${fields.outcomes.length} calls failed.`);
  }
  const settings = SELECTION_SETTINGS[fields.model];
  const { metrics, confused_pairs } = summariseSelection(fields.set.scenarios, fields.outcomes);
  return {
    key: fields.key,
    model: fields.model,
    tools_hash: fields.toolsHash,
    scenario_set: fields.set.version,
    prompt_version: PROMPT_VERSIONS.selection,
    mode: fields.mode,
    settings: { max_tokens: settings.maxTokens, thinking: settings.thinking, effort: settings.effort },
    completed_at: fields.now.toISOString(),
    sampled: fields.sampled,
    metrics,
    confused_pairs,
    outcomes: [...fields.outcomes].sort((a, b) => a.id.localeCompare(b.id)),
    usd: roundUsd(fields.usd)
  };
}
