import Anthropic from "@anthropic-ai/sdk";
import { collectBatches, enqueue, submitDraft } from "./batch";
import { budgetState, charge, cycleWindow, exhaustedEventKey, gate } from "./budget";
import { errorMessage, isCreditExhausted } from "./client";
import {
  GENERATION_SETTINGS,
  PROMPT_VERSIONS,
  SCENARIO_MODEL,
  SELECTION_SETTINGS,
  SONNET,
  TIER_POLICY,
  type Mode,
  type ModelId,
  type SelectionPlan
} from "./config";
import { countFootprint } from "./footprint";
import { parseScenarios, scenarioRequest } from "./jobs/scenarios";
import { ArgumentChecker, gradeSelection, selectionRequest, type ScenarioOutcome } from "./jobs/selection";
import { scenariosKey, selectionKey, type JobKind } from "./keys";
import { costUsd, estimateUsd, usageFromApi } from "./pricing";
import { readEvalFile, writeEvalFile, type ScenarioSet, type SelectionRun } from "./results";
import {
  CreditExhausted,
  MAX_ATTEMPTS,
  erroredOutcome,
  evalSurface,
  evalTargets,
  jobRecord,
  markExhausted,
  publishScenarios,
  publishSelection,
  selectionRun,
  written,
  type EvalSurface,
  type EvalTarget,
  type JobOutcome,
  type Run,
  type RunOptions,
  type RunReport
} from "./run";
import { toApiSurface } from "./surface";

export { evalTargets, MAX_ATTEMPTS };
export type { EvalTarget, JobOutcome, RunOptions, RunReport };

/** Standard-API calls in flight at once, after the first has warmed the cache. */
const CONCURRENCY = 4;

const DAY_MS = 24 * 60 * 60 * 1000;

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

/**
 * One standard-API call, recorded in the ledger before anything else happens
 * with it. Credit exhaustion is converted into a stop for the whole run.
 */
async function call(
  run: Run,
  job: JobKind,
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

/** Settles a standard job that threw. Running out of credit is not the job's fault: it keeps its retry. */
async function failStandard(
  run: Run,
  job: ReturnType<typeof jobRecord>,
  previousAttempts: number,
  caught: unknown,
  report: (outcome: JobOutcome, detail?: string) => void
): Promise<void> {
  const exhausted = caught instanceof CreditExhausted;
  await run.ledger.saveJob({
    ...job,
    status: "failed",
    attempts: exhausted ? previousAttempts : job.attempts,
    lastError: exhausted ? "credit exhausted" : errorMessage(caught),
    updatedAt: run.now
  });
  if (exhausted) throw caught;
  report("failed", errorMessage(caught));
}

/**
 * J1. Returns the scenario set for the current surface — generating it on the
 * standard API when the tier wants it now, or queuing it for the batch when
 * it can wait. Without a current set the selection jobs cannot run.
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
    publishScenarios(run, before.result as ScenarioSet);
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
  if (!run.client) {
    report("planned");
    return undefined;
  }

  const mode: Mode = TIER_POLICY[tier].scenarios;
  const settings = GENERATION_SETTINGS[SCENARIO_MODEL];
  const inputEstimate = Math.round((surface.footprint.models[SCENARIO_MODEL] ?? 0) * 1.2) + 800;
  const estimate = estimateUsd(SCENARIO_MODEL, inputEstimate, settings.maxTokens, mode === "batch");
  const decision = gate(run.state, tier, estimate);
  if (!decision.allowed) {
    report("deferred", decision.reason);
    return undefined;
  }

  const job = jobRecord(run, key, "scenarios", slug, SCENARIO_MODEL, before.attempts + 1, mode);
  if (mode === "batch") {
    enqueue(run, job, [{ params: scenarioRequest(surface.tools) }], estimate);
    return undefined;
  }

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
    publishScenarios(run, set);
    await run.ledger.saveJob({ ...job, status: "done", result: set, completedAt: run.now, updatedAt: run.now });
    report("done", `${set.scenarios.length} scenarios, set v${set.version}`, usd);
    return set;
  } catch (caught) {
    await failStandard(run, job, before.attempts, caught, report);
    return undefined;
  }
}

/** When this server last got a run from this model, on any surface. */
function lastRunAt(slug: string, model: ModelId): Date | undefined {
  const runs = readEvalFile(slug, "selection")?.runs.filter((existing) => existing.model === model) ?? [];
  const latest = runs.map((existing) => existing.completed_at).sort().at(-1);
  return latest ? new Date(latest) : undefined;
}

/** J2 for one model: run now on the standard API, or queue for the batch. */
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
    publishSelection(run, slug, before.result as SelectionRun);
    return report("current", "restored from the ledger");
  }
  if (before.state === "in-flight") return report("in-flight");
  if (before.state === "gave-up") return report("gave-up", before.detail);

  const last = lastRunAt(slug, model);
  if (last && run.now.getTime() - last.getTime() < plan.everyDays * DAY_MS) {
    return report("throttled", `last run ${last.toISOString().slice(0, 10)}, every ${plan.everyDays} day(s)`);
  }
  if (!run.client) return report("planned");

  const settings = SELECTION_SETTINGS[model];
  const perCallInput = (surface.footprint.models[model] ?? surface.footprint.models[SONNET] ?? 0) + 300;
  const estimate = set.scenarios.length * estimateUsd(model, perCallInput, settings.maxTokens, plan.mode === "batch");
  const decision = gate(run.state, tier, estimate);
  if (!decision.allowed) return report("deferred", decision.reason);

  const job = jobRecord(run, key, "selection", slug, model, before.attempts + 1, plan.mode);
  const api = toApiSurface(surface.tools);
  if (plan.mode === "batch") {
    enqueue(
      run,
      job,
      set.scenarios.map((scenario) => ({
        params: selectionRequest(api, scenario, model, "batch"),
        scenarioId: scenario.id
      })),
      estimate
    );
    return;
  }

  await run.ledger.saveJob(job);
  const checker = new ArgumentChecker(api.schemas);
  let usd = 0;
  const ask = async (scenario: ScenarioSet["scenarios"][number]): Promise<ScenarioOutcome> => {
    try {
      const response = await call(run, "selection", slug, model, key, selectionRequest(api, scenario, model, "standard"));
      usd += response.usd;
      return gradeSelection(scenario, response.message, api, checker);
    } catch (caught) {
      if (caught instanceof CreditExhausted) throw caught;
      return erroredOutcome(scenario.id);
    }
  };

  try {
    // The first call writes the cache entry for tools + system; it is only
    // readable once that response has started, so the rest wait for it.
    const [first, ...rest] = set.scenarios;
    const outcomes = first ? [await ask(first), ...(await mapWithConcurrency(rest, CONCURRENCY, ask))] : [];
    const result = selectionRun({
      key,
      model,
      toolsHash: target.surface.toolsHash,
      set,
      mode: "standard",
      now: run.now,
      sampled: surface.sampled,
      outcomes,
      usd
    });
    publishSelection(run, slug, result);
    await run.ledger.saveJob({ ...job, status: "done", result, completedAt: run.now, updatedAt: run.now });
    report("done", `accuracy ${result.metrics.selection_accuracy ?? "n/a"}`, result.usd);
  } catch (caught) {
    await failStandard(run, job, before.attempts, caught, report);
  }
}

async function runModelJobs(targets: EvalTarget[], run: Run): Promise<void> {
  for (const target of targets) {
    const plans = TIER_POLICY[target.seed.tier].selection;
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

/**
 * One wake-up of the eval layer: collect the batches that ended, recount any
 * surface that changed, run what is due on the standard API, and submit the
 * rest as batches. Every paid step passes the budget gate first.
 */
export async function runEvals(options: RunOptions): Promise<RunReport> {
  const window = cycleWindow(options.now);
  const [spentUsd, batches, exhausted] = await Promise.all([
    options.ledger.spentSince(window.start),
    options.ledger.openBatches(),
    options.ledger.hasEvent(exhaustedEventKey(window))
  ]);
  const run: Run = {
    ...options,
    report: { footprints: [], jobs: [], batches: [], written: [], exhausted },
    state: budgetState({
      now: options.now,
      spentUsd,
      pendingUsd: batches.reduce((sum, batch) => sum + batch.estimatedUsd, 0),
      exhausted
    }),
    draft: { chunks: [] }
  };

  await collectBatches(run);
  const targets = evalTargets(options.only);
  options.log(`${targets.length} server(s) with a captured surface.`);
  await refreshFootprints(targets, run);
  try {
    await runModelJobs(targets, run);
  } catch (caught) {
    if (!(caught instanceof CreditExhausted)) throw caught;
    options.log("The API reported the credit exhausted; the rest waits for the next cycle.");
  }
  if (run.client) await submitDraft(run);
  run.report.budget = run.state;
  return run.report;
}
