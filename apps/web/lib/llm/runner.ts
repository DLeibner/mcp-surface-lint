import Anthropic from "@anthropic-ai/sdk";
import type { ToolDef } from "mcp-surface-lint";
import { loadResult, loadSeeds } from "../directory/data";
import type { ScanResult, Seed } from "../directory/types";
import { budgetState, charge, cycleWindow, exhaustedEventKey, gate, type BudgetState } from "./budget";
import { errorMessage, isCreditExhausted, type EvalClient } from "./client";
import {
  GENERATION_SETTINGS,
  PROMPT_VERSIONS,
  SCENARIO_MODEL,
  SELECTION_SETTINGS,
  SONNET,
  SURFACE_LIMITS,
  TIER_POLICY,
  TIER_PRIORITY,
  type ModelId,
  type SelectionPlan,
  type Tier
} from "./config";
import { countFootprint } from "./footprint";
import { parseScenarios, scenarioRequest } from "./jobs/scenarios";
import {
  ArgumentChecker,
  gradeSelection,
  selectionRequest,
  summariseSelection,
  type ScenarioOutcome
} from "./jobs/selection";
import { scenariosKey, selectionKey } from "./keys";
import type { JobRecord, LlmLedger } from "./ledger";
import { costUsd, estimateUsd, roundUsd, usageFromApi } from "./pricing";
import {
  readEvalFile,
  withRun,
  writeEvalFile,
  type Footprint,
  type ScenarioSet,
  type SelectionRun
} from "./results";
import { loadSurface, sampleTools, toApiSurface, type Surface } from "./surface";

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

export function evalTargets(only?: ReadonlySet<string>): EvalTarget[] {
  const targets = loadSeeds().flatMap((seed) => {
    if (only && !only.has(seed.slug)) return [];
    const surface = loadSurface(seed.slug);
    return surface ? [{ seed, surface, scan: loadResult(seed.slug) }] : [];
  });
  // When the budget is tight, the tiers that matter most go first.
  return targets.sort(
    (a, b) =>
      TIER_PRIORITY.indexOf(a.seed.tier) - TIER_PRIORITY.indexOf(b.seed.tier) ||
      a.seed.slug.localeCompare(b.seed.slug)
  );
}

export type FootprintOutcome = "counted" | "current" | "rejected" | "failed" | "planned";

export type JobOutcome =
  | "done"
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
  job: "scenarios" | "selection";
  model: ModelId;
  outcome: JobOutcome;
  detail?: string;
  usd?: number;
}

export interface RunReport {
  footprints: { slug: string; outcome: FootprintOutcome; detail?: string }[];
  jobs: JobReport[];
  /** Paths under data/evals that this run rewrote. */
  written: string[];
  /** The API said the credit is gone; the run stopped spending. */
  exhausted: boolean;
  budget?: BudgetState;
}

/** A transient failure gets one retry, in the next run; after that the key is left alone. */
export const MAX_ATTEMPTS = 2;

/** A run with more failed calls than this share is not published. */
const MAX_ERRORED_SHARE = 0.2;

/** Standard-API calls in flight at once, after the first has warmed the cache. */
const CONCURRENCY = 4;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Thrown when the credit runs out mid-run: everything still queued waits for the next cycle. */
class CreditExhausted extends Error {}

interface Run extends RunOptions {
  report: RunReport;
  state: BudgetState;
}

async function markExhausted(run: Run): Promise<void> {
  run.report.exhausted = true;
  run.state = { ...run.state, exhausted: true };
  await run.ledger.claimEvent(exhaustedEventKey(cycleWindow(run.now)), "credit-exhausted", {
    at: run.now.toISOString()
  });
}

function written(run: Run, slug: string, file: string, changed: boolean): void {
  if (changed) run.report.written.push(`data/evals/${slug}/${file}`);
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    })
  );
  return out;
}

/**
 * Per-model token counts through `count_tokens`, refreshed whenever the
 * surface changed since the last count. The endpoint is free, so it is not
 * budget-gated; a surface the API rejects is recorded as such rather than
 * retried forever.
 */
async function refreshFootprints(targets: EvalTarget[], run: Run): Promise<void> {
  const baselines = new Map<ModelId, number>();
  let blocked = false;
  for (const { seed, surface } of targets) {
    const slug = seed.slug;
    if (readEvalFile(slug, "footprint")?.tools_hash === surface.toolsHash) {
      run.report.footprints.push({ slug, outcome: "current" });
      continue;
    }
    if (!run.client || blocked) {
      run.report.footprints.push({ slug, outcome: "planned" });
      continue;
    }

    let models: Record<string, number> = {};
    let error: string | null = null;
    try {
      models = await countFootprint(run.client, toApiSurface(surface.tools).tools, baselines);
    } catch (caught) {
      if (isCreditExhausted(caught)) {
        blocked = true;
        await markExhausted(run);
        run.report.footprints.push({ slug, outcome: "planned", detail: "credit exhausted" });
        continue;
      }
      if (!(caught instanceof Anthropic.BadRequestError)) {
        // Transient: try again next run rather than publish an error.
        run.report.footprints.push({ slug, outcome: "failed", detail: errorMessage(caught) });
        continue;
      }
      error = errorMessage(caught);
    }

    written(
      run,
      slug,
      "footprint.json",
      writeEvalFile(slug, "footprint", {
        slug,
        tools_hash: surface.toolsHash,
        counted_at: run.now.toISOString(),
        models,
        error
      })
    );
    run.report.footprints.push(error ? { slug, outcome: "rejected", detail: error } : { slug, outcome: "counted" });
  }
}

/** What the models are shown: the whole surface, or a stable sample of an oversized one. */
interface EvalSurface {
  tools: ToolDef[];
  sampled: { tools: number; of: number } | null;
  footprint: Footprint;
}

function evalSurface(target: EvalTarget): EvalSurface | string {
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

/** What a finished job left behind, or why it should not run now. */
type Prior =
  | { state: "none"; attempts: number }
  | { state: "done"; result: unknown }
  | { state: "in-flight" }
  | { state: "gave-up"; detail: string };

async function prior(run: Run, key: string): Promise<Prior> {
  const job = (await run.ledger.jobs([key])).get(key);
  if (!job) return { state: "none", attempts: 0 };
  if (job.status === "done") return { state: "done", result: job.result };
  if (job.status === "submitted") return { state: "in-flight" };
  if (job.attempts >= MAX_ATTEMPTS) return { state: "gave-up", detail: job.lastError ?? "failed twice" };
  return { state: "none", attempts: job.attempts };
}

function jobRecord(
  run: Run,
  key: string,
  job: JobReport["job"],
  slug: string,
  model: ModelId,
  attempts: number
): JobRecord {
  return {
    key,
    job,
    serverId: slug,
    model,
    status: "submitted",
    mode: "standard",
    batchId: null,
    attempts,
    lastError: null,
    result: null,
    createdAt: run.now,
    updatedAt: run.now,
    completedAt: null
  };
}

/**
 * One standard-API call, recorded in the ledger before anything else happens
 * with it. Credit exhaustion is converted into a stop for the whole run.
 */
async function call(
  run: Run,
  job: JobReport["job"],
  slug: string,
  model: ModelId,
  key: string,
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<{ message: Anthropic.Message; usd: number }> {
  // Calls already in flight finish and are billed; none starts once the credit is known to be gone.
  if (run.state.exhausted) throw new CreditExhausted();
  let message: Anthropic.Message;
  try {
    message = await run.client!.createMessage(params);
  } catch (caught) {
    if (isCreditExhausted(caught)) {
      await markExhausted(run);
      throw new CreditExhausted();
    }
    throw caught;
  }
  const usage = usageFromApi(message.usage);
  const usd = costUsd(model, usage, false);
  await run.ledger.recordUsage({ job, serverId: slug, model, usage, usd, batch: false, jobKey: key });
  run.state = charge(run.state, usd);
  return { message, usd };
}

/** Re-publishes an answer the ledger holds but the repository lost, without paying for it again. */
function restore(run: Run, slug: string, kind: "scenarios" | "selection", result: unknown): void {
  if (kind === "scenarios") {
    written(run, slug, "scenarios.json", writeEvalFile(slug, "scenarios", result as ScenarioSet));
  } else {
    const selection = withRun(readEvalFile(slug, "selection"), slug, result as SelectionRun);
    written(run, slug, "selection.json", writeEvalFile(slug, "selection", selection));
  }
}

/**
 * J1. Returns the scenario set for the current surface, generating one if
 * needed and allowed. Without it the selection jobs cannot run.
 */
async function ensureScenarios(run: Run, target: EvalTarget, surface: EvalSurface): Promise<ScenarioSet | undefined> {
  const slug = target.seed.slug;
  const tier = target.seed.tier;
  const current = readEvalFile(slug, "scenarios");
  if (current?.tools_hash === target.surface.toolsHash && current.prompt_version === PROMPT_VERSIONS.scenarios) {
    return current;
  }

  const key = scenariosKey(slug, target.surface.toolsHash, SCENARIO_MODEL, PROMPT_VERSIONS.scenarios);
  const report = (outcome: JobOutcome, detail?: string, usd?: number): void => {
    run.report.jobs.push({ slug, job: "scenarios", model: SCENARIO_MODEL, outcome, detail, usd });
  };

  const before = await prior(run, key);
  if (before.state === "done") {
    restore(run, slug, "scenarios", before.result);
    return before.result as ScenarioSet;
  }
  if (before.state === "in-flight") {
    report("in-flight");
    return undefined;
  }
  if (before.state === "gave-up") {
    report("gave-up", before.detail);
    return undefined;
  }
  if (TIER_POLICY[tier].scenarios === "batch") {
    report("skipped", "batch mode arrives with the batch runner");
    return undefined;
  }
  if (!run.client) {
    report("planned");
    return undefined;
  }

  const settings = GENERATION_SETTINGS[SCENARIO_MODEL];
  const inputEstimate = Math.round((surface.footprint.models[SCENARIO_MODEL] ?? 0) * 1.2) + 800;
  const decision = gate(run.state, tier, estimateUsd(SCENARIO_MODEL, inputEstimate, settings.maxTokens, false));
  if (!decision.allowed) {
    report("deferred", decision.reason);
    return undefined;
  }

  const job = jobRecord(run, key, "scenarios", slug, SCENARIO_MODEL, before.attempts + 1);
  await run.ledger.saveJob(job);
  try {
    const { message, usd } = await call(run, "scenarios", slug, SCENARIO_MODEL, key, scenarioRequest(surface.tools));
    const set: ScenarioSet = {
      slug,
      version: (current?.version ?? 0) + 1,
      tools_hash: target.surface.toolsHash,
      generated_at: run.now.toISOString(),
      model: SCENARIO_MODEL,
      prompt_version: PROMPT_VERSIONS.scenarios,
      sampled: surface.sampled,
      scenarios: parseScenarios(message, surface.tools)
    };
    written(run, slug, "scenarios.json", writeEvalFile(slug, "scenarios", set));
    await run.ledger.saveJob({ ...job, status: "done", result: set, completedAt: run.now, updatedAt: run.now });
    report("done", `${set.scenarios.length} scenarios, set v${set.version}`, usd);
    return set;
  } catch (caught) {
    const exhausted = caught instanceof CreditExhausted;
    await run.ledger.saveJob({
      ...job,
      status: "failed",
      // Running out of credit is not the job's fault: it keeps its retry.
      attempts: exhausted ? before.attempts : job.attempts,
      lastError: exhausted ? "credit exhausted" : errorMessage(caught),
      updatedAt: run.now
    });
    if (exhausted) throw caught;
    report("failed", errorMessage(caught));
    return undefined;
  }
}

/** When this server last got a run from this model, on any surface. */
function lastRunAt(slug: string, model: ModelId): Date | undefined {
  const runs = readEvalFile(slug, "selection")?.runs.filter((existing) => existing.model === model) ?? [];
  const latest = runs.map((existing) => existing.completed_at).sort().at(-1);
  return latest ? new Date(latest) : undefined;
}

/** J2 for one model, on the standard API. */
async function runSelection(
  run: Run,
  target: EvalTarget,
  surface: EvalSurface,
  set: ScenarioSet,
  plan: SelectionPlan
): Promise<void> {
  const slug = target.seed.slug;
  const tier = target.seed.tier;
  const model = plan.model;
  const key = selectionKey(slug, target.surface.toolsHash, model, set.version, PROMPT_VERSIONS.selection);
  const report = (outcome: JobOutcome, detail?: string, usd?: number): void => {
    run.report.jobs.push({ slug, job: "selection", model, outcome, detail, usd });
  };

  if (readEvalFile(slug, "selection")?.runs.some((existing) => existing.key === key)) return report("current");
  const before = await prior(run, key);
  if (before.state === "done") {
    restore(run, slug, "selection", before.result);
    return report("current", "restored from the ledger");
  }
  if (before.state === "in-flight") return report("in-flight");
  if (before.state === "gave-up") return report("gave-up", before.detail);

  const last = lastRunAt(slug, model);
  if (last && run.now.getTime() - last.getTime() < plan.everyDays * DAY_MS) {
    return report("throttled", `last run ${last.toISOString().slice(0, 10)}, every ${plan.everyDays} day(s)`);
  }
  if (plan.mode === "batch") return report("skipped", "batch mode arrives with the batch runner");
  if (!run.client) return report("planned");

  const settings = SELECTION_SETTINGS[model];
  const perCallInput = (surface.footprint.models[model] ?? surface.footprint.models[SONNET] ?? 0) + 300;
  const estimate = set.scenarios.length * estimateUsd(model, perCallInput, settings.maxTokens, false);
  const decision = gate(run.state, tier, estimate);
  if (!decision.allowed) return report("deferred", decision.reason);

  const job = jobRecord(run, key, "selection", slug, model, before.attempts + 1);
  await run.ledger.saveJob(job);
  const api = toApiSurface(surface.tools);
  const checker = new ArgumentChecker(api.schemas);
  let usd = 0;

  const ask = async (scenario: ScenarioSet["scenarios"][number]): Promise<ScenarioOutcome> => {
    try {
      const response = await call(run, "selection", slug, model, key, selectionRequest(api, scenario, model, "standard"));
      usd += response.usd;
      return gradeSelection(scenario, response.message, api, checker);
    } catch (caught) {
      if (caught instanceof CreditExhausted) throw caught;
      return { id: scenario.id, called: [], stop: "error", correct: null, args_valid: null, args_match: null };
    }
  };

  try {
    // The first call writes the cache entry for tools + system; it is only
    // readable once that response has started, so the rest wait for it.
    const [first, ...rest] = set.scenarios;
    const outcomes = first ? [await ask(first), ...(await mapWithConcurrency(rest, CONCURRENCY, ask))] : [];
    const errored = outcomes.filter((outcome) => outcome.stop === "error").length;
    if (errored > outcomes.length * MAX_ERRORED_SHARE) {
      throw new Error(`${errored} of ${outcomes.length} calls failed.`);
    }

    const { metrics, confused_pairs } = summariseSelection(set.scenarios, outcomes);
    const result: SelectionRun = {
      key,
      model,
      tools_hash: target.surface.toolsHash,
      scenario_set: set.version,
      prompt_version: PROMPT_VERSIONS.selection,
      mode: "standard",
      settings: { max_tokens: settings.maxTokens, thinking: settings.thinking, effort: settings.effort },
      completed_at: run.now.toISOString(),
      sampled: surface.sampled,
      metrics,
      confused_pairs,
      outcomes,
      usd: roundUsd(usd)
    };
    const selection = withRun(readEvalFile(slug, "selection"), slug, result);
    written(run, slug, "selection.json", writeEvalFile(slug, "selection", selection));
    await run.ledger.saveJob({ ...job, status: "done", result, completedAt: run.now, updatedAt: run.now });
    report("done", `accuracy ${metrics.selection_accuracy ?? "n/a"}`, result.usd);
  } catch (caught) {
    const exhausted = caught instanceof CreditExhausted;
    await run.ledger.saveJob({
      ...job,
      status: "failed",
      attempts: exhausted ? before.attempts : job.attempts,
      lastError: exhausted ? "credit exhausted" : errorMessage(caught),
      updatedAt: run.now
    });
    if (exhausted) throw caught;
    report("failed", errorMessage(caught), roundUsd(usd));
  }
}

async function runModelJobs(targets: EvalTarget[], run: Run): Promise<void> {
  for (const target of targets) {
    const plans = TIER_POLICY[target.seed.tier as Tier].selection;
    if (plans.length === 0) continue;
    const surface = evalSurface(target);
    if (typeof surface === "string") {
      for (const plan of plans) {
        run.report.jobs.push({ slug: target.seed.slug, job: "selection", model: plan.model, outcome: "skipped", detail: surface });
      }
      continue;
    }
    const set = await ensureScenarios(run, target, surface);
    if (!set) continue;
    for (const plan of plans) await runSelection(run, target, surface, set, plan);
  }
}

export async function runEvals(options: RunOptions): Promise<RunReport> {
  const window = cycleWindow(options.now);
  const [spentUsd, batches, exhausted] = await Promise.all([
    options.ledger.spentSince(window.start),
    options.ledger.openBatches(),
    options.ledger.hasEvent(exhaustedEventKey(window))
  ]);
  const run: Run = {
    ...options,
    report: { footprints: [], jobs: [], written: [], exhausted },
    state: budgetState({
      now: options.now,
      spentUsd,
      pendingUsd: batches.reduce((sum, batch) => sum + batch.estimatedUsd, 0),
      exhausted
    })
  };

  const targets = evalTargets(options.only);
  options.log(`${targets.length} server(s) with a captured surface.`);
  await refreshFootprints(targets, run);
  try {
    await runModelJobs(targets, run);
  } catch (caught) {
    if (!(caught instanceof CreditExhausted)) throw caught;
    options.log("The API reported the credit exhausted; the rest waits for the next cycle.");
  }
  run.report.budget = run.state;
  return run.report;
}
