import type Anthropic from "@anthropic-ai/sdk";
import type { ToolDef } from "mcp-surface-lint";
import { loadResult, loadSeeds } from "../directory/data";
import type { ScanResult, Seed } from "../directory/types";
import { raise, type Alert, type Notifier } from "./alerts";
import { cycleId, cycleWindow, exhaustedEventKey, type BudgetState } from "./budget";
import type { EvalClient } from "./client";
import {
  ALERTS,
  BUDGET,
  MODEL_LABELS,
  PROMPT_VERSIONS,
  SELECTION_SETTINGS,
  SONNET,
  SURFACE_LIMITS,
  TIER_PRIORITY,
  type Mode,
  type ModelId
} from "./config";
import { parseReview } from "./jobs/review";
import { parseScenarios } from "./jobs/scenarios";
import { summariseSelection, type ScenarioOutcome } from "./jobs/selection";
import { parseSummary } from "./jobs/summary";
import type { JobKind, ParsedKey } from "./keys";
import type { BatchRequestMeta, JobRecord, LlmLedger } from "./ledger";
import { roundUsd } from "./pricing";
import {
  readEvalFile,
  withRun,
  writeEvalFile,
  type Footprint,
  type Review,
  type ScenarioSet,
  type SelectionRun,
  type Summary
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
  /** Where alerts go besides the report; see alerts.ts. */
  notify?: Notifier;
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
  /** Alerts raised for the first time by this run. */
  alerts: Alert[];
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
  /** Result keys this run already ran or queued, so no pass queues one twice. */
  planned: Set<string>;
}

/** Thrown when the credit runs out mid-run: everything still queued waits for the next cycle. */
export class CreditExhausted extends Error {}

function raiseFor(run: Run, alert: Alert): Promise<void> {
  return raise(
    {
      claimEvent: (key, kind, detail) => run.ledger.claimEvent(key, kind, detail),
      notify: run.notify,
      log: run.log,
      raised: run.report.alerts
    },
    alert
  );
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * The API said the credit is gone: an expected state, not a failure. Nothing
 * else spends until the cycle refreshes, and the admin hears about it once.
 */
export async function markExhausted(run: Run): Promise<void> {
  run.report.exhausted = true;
  run.state = { ...run.state, exhausted: true };
  const window = cycleWindow(run.now);
  await raiseFor(run, {
    key: exhaustedEventKey(window),
    kind: "credit-exhausted",
    subject: "LLM evals paused: the API credit is exhausted",
    body:
      `The Anthropic API reported the credit balance exhausted on ${run.now.toISOString().slice(0, 10)}, ` +
      `with ${usd(run.state.spentUsd)} recorded this cycle. Every LLM job is deferred until the credit ` +
      `refreshes on ${window.end.toISOString().slice(0, 10)}. Structural scans are unaffected.`
  });
}

/** The gate refused a job at the hard stop: one email per cycle. */
export async function raiseHardStop(run: Run): Promise<void> {
  const window = cycleWindow(run.now);
  await raiseFor(run, {
    key: `hard-stop:${cycleId(window)}`,
    kind: "hard-stop",
    subject: "LLM evals paused: budget hard stop reached",
    body:
      `Spent ${usd(run.state.spentUsd)} and reserved ${usd(run.state.pendingUsd)} of the ${usd(BUDGET.creditUsd)} ` +
      `credit this cycle, past the hard stop at ${BUDGET.hardStopRatio * 100}%. Every LLM job is deferred until ` +
      `${window.end.toISOString().slice(0, 10)}. Structural scans are unaffected. Details: /admin/budget.`
  });
}

/**
 * Selection accuracy fell by at least ALERTS.regressionPoints against the
 * previous run on the same model and prompt version. The two runs usually
 * differ in surface and scenario set too; the email says so.
 */
export async function checkRegression(
  run: Run,
  slug: string,
  previous: SelectionRun | undefined,
  current: SelectionRun
): Promise<void> {
  const before = previous?.metrics.selection_accuracy;
  const after = current.metrics.selection_accuracy;
  if (!previous || before === null || before === undefined || after === null) return;
  const drop = Math.round((before - after) * 100);
  if (drop < ALERTS.regressionPoints) return;
  const model = MODEL_LABELS[current.model as ModelId] ?? current.model;
  await raiseFor(run, {
    key: `regression:${current.key}`,
    kind: "regression",
    subject: `${slug}: ${model} picked the right tool ${drop} points less often`,
    body:
      `Selection accuracy for ${slug} on ${model} fell from ${Math.round(before * 100)}% ` +
      `(${previous.completed_at.slice(0, 10)}, scenario set v${previous.scenario_set}) to ` +
      `${Math.round(after * 100)}% (${current.completed_at.slice(0, 10)}, scenario set v${current.scenario_set}). ` +
      (previous.tools_hash === current.tools_hash
        ? "The surface did not change between the runs."
        : "The surface changed between the runs.") +
      ` Confused pairs now: ${current.confused_pairs.map((p) => `${p.expected} → ${p.actual}`).join(", ") || "none"}.`
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

/** Jobs answered by a single request: scenarios (J1), review (J3) and summary (J4). */
export type SingleKind = "scenarios" | "review" | "summary";
export type SingleResult = ScenarioSet | Review | Summary;

/**
 * Turns the answer to a single-request job into what gets published, the same
 * way whether it came from the standard API or a batch. Throws when the answer
 * is unusable or the world moved on since the request was made.
 */
export function buildSingle(
  key: string,
  parsed: ParsedKey & { job: SingleKind },
  target: EvalTarget,
  surface: EvalSurface,
  message: Anthropic.Message,
  now: Date,
  usd: number
): SingleResult {
  const slug = parsed.slug;
  const at = now.toISOString();
  if (parsed.job === "scenarios") {
    return {
      slug,
      version: (readEvalFile(slug, "scenarios")?.version ?? 0) + 1,
      tools_hash: parsed.toolsHash,
      generated_at: at,
      model: parsed.model,
      prompt_version: parsed.promptVersion,
      sampled: surface.sampled,
      scenarios: parseScenarios(message, surface.tools)
    };
  }
  if (parsed.job === "review") {
    return {
      slug,
      key,
      tools_hash: parsed.toolsHash,
      model: parsed.model,
      prompt_version: parsed.promptVersion,
      reviewed_at: at,
      sampled: surface.sampled,
      findings: parseReview(message, surface.tools),
      usd: roundUsd(usd)
    };
  }
  if (target.scan?.score?.composite !== parsed.composite) {
    throw new Error("the score changed before the summary was collected");
  }
  return {
    slug,
    key,
    tools_hash: parsed.toolsHash,
    composite: parsed.composite!,
    model: parsed.model,
    prompt_version: parsed.promptVersion,
    generated_at: at,
    text: parseSummary(message),
    usd: roundUsd(usd)
  };
}

export function publishSingle(run: Run, kind: SingleKind, result: SingleResult): void {
  if (kind === "scenarios") return publishScenarios(run, result as ScenarioSet);
  const file = kind === "review" ? "review.json" : "summary.json";
  const changed =
    kind === "review"
      ? writeEvalFile(result.slug, "review", result as Review)
      : writeEvalFile(result.slug, "summary", result as Summary);
  written(run, result.slug, file, changed);
}

export function describeSingle(kind: SingleKind, result: SingleResult): string {
  if (kind === "scenarios") {
    const set = result as ScenarioSet;
    return `${set.scenarios.length} scenarios, set v${set.version}`;
  }
  if (kind === "review") return `${(result as Review).findings.length} finding(s)`;
  return `${(result as Summary).text.length} characters`;
}

/** Publishes a run and returns the one it should be compared with, if any. */
export function publishSelection(run: Run, slug: string, result: SelectionRun): SelectionRun | undefined {
  const existing = readEvalFile(slug, "selection");
  const previous = existing?.runs
    .filter(
      (other) =>
        other.model === result.model && other.prompt_version === result.prompt_version && other.key !== result.key
    )
    .sort((a, b) => b.completed_at.localeCompare(a.completed_at))[0];
  written(run, slug, "selection.json", writeEvalFile(slug, "selection", withRun(existing, slug, result)));
  return previous;
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
