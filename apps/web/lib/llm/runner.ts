import Anthropic from "@anthropic-ai/sdk";
import { collectBatches, enqueue, reconcileOrphans, submitDraft } from "./batch";
import { budgetState, charge, cycleId, cycleWindow, exhaustedEventKey, gate, type GateDecision } from "./budget";
import { errorMessage, isCreditExhausted } from "./client";
import {
  BUDGET,
  GENERATION_SETTINGS,
  PROMPT_VERSIONS,
  SCENARIO_MODEL,
  SELECTION_SETTINGS,
  SONNET,
  SUMMARY_SETTINGS,
  TIER_POLICY,
  USE_IT_OR_LOSE_IT,
  type Mode,
  type ModelId,
  type SelectionPlan
} from "./config";
import { countFootprint } from "./footprint";
import { reviewRequest } from "./jobs/review";
import { scenarioRequest } from "./jobs/scenarios";
import { ArgumentChecker, gradeSelection, selectionRequest, type ScenarioOutcome } from "./jobs/selection";
import { summaryFacts, summaryRequest } from "./jobs/summary";
import { parseKey, reviewKey, scenariosKey, selectionKey, summaryKey, type JobKind } from "./keys";
import { costUsd, estimateUsd, usageFromApi } from "./pricing";
import { readEvalFile, writeEvalFile, type ScenarioSet, type SelectionRun } from "./results";
import {
  CreditExhausted,
  MAX_ATTEMPTS,
  buildSingle,
  checkRegression,
  describeSingle,
  erroredOutcome,
  evalSurface,
  evalTargets,
  jobRecord,
  markExhausted,
  publishScenarios,
  publishSelection,
  publishSingle,
  raiseHardStop,
  RunFailed,
  selectionRun,
  written,
  type SingleKind,
  type SingleResult,
  type EvalSurface,
  type EvalTarget,
  type JobOutcome,
  type Run,
  type RunOptions,
  type RunReport
} from "./run";
import { toApiSurface } from "./surface";
import { rankByViews } from "./views";

export { evalTargets, MAX_ATTEMPTS, RunFailed };
export type { EvalTarget, JobOutcome, RunOptions, RunReport };

/** Standard-API calls in flight at once, after the first has warmed the cache. */
const CONCURRENCY = 4;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A job still marked submitted this long after its last update, with no batch
 * to wait for, was interrupted (a killed or timed-out run): it is released for
 * its retry instead of waiting forever. Batches have their own clock in batch.ts.
 */
const STALE_SUBMISSION_MS = 2 * 60 * 60 * 1000;

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
  if (job.status === "submitted") {
    const waiting = job.mode === "batch" && job.batchId !== null;
    if (waiting || run.now.getTime() - job.updatedAt.getTime() < STALE_SUBMISSION_MS) return { state: "in-flight" };
    // Interrupted: that counts as the attempt it was.
    if (job.attempts >= MAX_ATTEMPTS) return { state: "gave-up", detail: "interrupted twice" };
    return { state: "none", attempts: job.attempts };
  }
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

/** A refused job is deferred; a refusal at the hard stop also tells the admin, once per cycle. */
async function deferred(run: Run, decision: GateDecision): Promise<string | undefined> {
  if (decision.level === "hard-stop" && !run.state.exhausted) await raiseHardStop(run);
  return decision.reason;
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

interface SingleSpec {
  kind: SingleKind;
  key: string;
  model: ModelId;
  mode: Mode;
  maxTokens: number;
  inputEstimate: number;
  params: () => Anthropic.MessageCreateParamsNonStreaming;
}

/**
 * A job answered by one request (J1, J3, J4): run now on the standard API, or
 * queue it for the batch. Returns the published answer when there is one.
 */
async function runSingle(
  run: Run,
  target: EvalTarget,
  surface: EvalSurface,
  spec: SingleSpec
): Promise<SingleResult | undefined> {
  const slug = target.seed.slug;
  const report = (outcome: JobOutcome, detail?: string, usd?: number): void => {
    run.report.jobs.push({ slug, job: spec.kind, model: spec.model, outcome, detail, usd });
  };

  const before = await prior(run, spec.key);
  if (before.state === "done") {
    publishSingle(run, spec.kind, before.result as SingleResult);
    return before.result as SingleResult;
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

  const estimate = estimateUsd(spec.model, spec.inputEstimate, spec.maxTokens, spec.mode === "batch");
  const decision = gate(run.state, target.seed.tier, estimate);
  if (!decision.allowed) {
    report("deferred", await deferred(run, decision));
    return undefined;
  }

  const job = jobRecord(run, spec.key, spec.kind, slug, spec.model, before.attempts + 1, spec.mode);
  if (spec.mode === "batch") {
    enqueue(run, job, [{ params: spec.params() }], estimate, surface.sampled);
    return undefined;
  }

  await run.ledger.saveJob(job);
  try {
    const { message, usd } = await call(run, spec.kind, slug, spec.model, spec.key, spec.params());
    const parsed = parseKey(spec.key) as Parameters<typeof buildSingle>[1];
    const result = buildSingle(spec.key, parsed, target, surface, message, run.now, usd);
    publishSingle(run, spec.kind, result);
    await run.ledger.saveJob({ ...job, status: "done", result, completedAt: run.now, updatedAt: run.now });
    report("done", describeSingle(spec.kind, result), usd);
    return result;
  } catch (caught) {
    await failStandard(run, job, before.attempts, caught, report);
    return undefined;
  }
}

/** Rough input size of a job that shows the model the surface as text. */
function surfaceInput(surface: EvalSurface, model: ModelId): number {
  return Math.round((surface.footprint.models[model] ?? surface.footprint.models[SONNET] ?? 0) * 1.2) + 800;
}

/**
 * J1. Returns the scenario set for the current surface — generating it on the
 * standard API when the tier wants it now, or queuing it for the batch when
 * it can wait. Without a current set the selection jobs cannot run.
 */
async function ensureScenarios(run: Run, target: EvalTarget, surface: EvalSurface): Promise<ScenarioSet | undefined> {
  const current = readEvalFile(target.seed.slug, "scenarios");
  if (current?.tools_hash === target.surface.toolsHash && current.prompt_version === PROMPT_VERSIONS.scenarios) {
    return current;
  }
  const result = await runSingle(run, target, surface, {
    kind: "scenarios",
    key: scenariosKey(target.seed.slug, target.surface.toolsHash, SCENARIO_MODEL, PROMPT_VERSIONS.scenarios),
    model: SCENARIO_MODEL,
    mode: TIER_POLICY[target.seed.tier].scenarios,
    maxTokens: GENERATION_SETTINGS[SCENARIO_MODEL].maxTokens,
    inputEstimate: surfaceInput(surface, SCENARIO_MODEL),
    params: () => scenarioRequest(surface.tools)
  });
  return result as ScenarioSet | undefined;
}

/** J3, once per surface (and prompt version). */
async function runReview(run: Run, target: EvalTarget, surface: EvalSurface): Promise<void> {
  const { model, mode } = TIER_POLICY[target.seed.tier].review;
  const key = reviewKey(target.seed.slug, target.surface.toolsHash, model, PROMPT_VERSIONS.review);
  if (readEvalFile(target.seed.slug, "review")?.key === key) return;
  await runSingle(run, target, surface, {
    kind: "review",
    key,
    model,
    mode,
    maxTokens: GENERATION_SETTINGS[model].maxTokens,
    inputEstimate: surfaceInput(surface, model),
    params: () => reviewRequest(surface.tools, model)
  });
}

/** J4, once per surface and score (and prompt version). */
async function runSummary(run: Run, target: EvalTarget, surface: EvalSurface): Promise<void> {
  const composite = target.scan?.score?.composite;
  const facts = target.scan ? summaryFacts(target.seed.name, target.scan, surface.footprint) : undefined;
  if (composite === undefined || !facts) return;
  const { model, mode } = TIER_POLICY[target.seed.tier].summary;
  const key = summaryKey(target.seed.slug, target.surface.toolsHash, model, composite, PROMPT_VERSIONS.summary);
  if (readEvalFile(target.seed.slug, "summary")?.key === key) return;
  await runSingle(run, target, surface, {
    kind: "summary",
    key,
    model,
    mode,
    maxTokens: SUMMARY_SETTINGS[model].maxTokens,
    inputEstimate: 1_200,
    params: () => summaryRequest(facts, model)
  });
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

  if (run.planned.has(key)) return;
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
  // Each request marks tools + system for caching; at worst every one of them pays to write it.
  const batch = plan.mode === "batch";
  const estimate = set.scenarios.length * estimateUsd(model, perCallInput, settings.maxTokens, batch, batch ? "1h" : "5m");
  const decision = gate(run.state, tier, estimate);
  if (!decision.allowed) return report("deferred", await deferred(run, decision));

  run.planned.add(key);
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
      estimate,
      surface.sampled
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

  let result: SelectionRun;
  let previous: SelectionRun | undefined;
  try {
    // The first call writes the cache entry for tools + system; it is only
    // readable once that response has started, so the rest wait for it.
    const [first, ...rest] = set.scenarios;
    const outcomes = first ? [await ask(first), ...(await mapWithConcurrency(rest, CONCURRENCY, ask))] : [];
    result = selectionRun({
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
    previous = publishSelection(run, slug, result);
    await run.ledger.saveJob({ ...job, status: "done", result, completedAt: run.now, updatedAt: run.now });
    report("done", `accuracy ${result.metrics.selection_accuracy ?? "n/a"}`, result.usd);
  } catch (caught) {
    await failStandard(run, job, before.attempts, caught, report);
    return;
  }
  await checkRegression(run, slug, previous, result);
}

async function runModelJobs(targets: EvalTarget[], run: Run): Promise<void> {
  for (const target of targets) {
    const plans = TIER_POLICY[target.seed.tier].selection;
    const surface = evalSurface(target);
    if (typeof surface === "string") {
      for (const plan of plans) {
        run.report.jobs.push({ slug: target.seed.slug, job: "selection", model: plan.model, outcome: "skipped", detail: surface });
      }
      continue;
    }
    if (plans.length > 0) {
      const set = await ensureScenarios(run, target, surface);
      if (set) for (const plan of plans) await runSelection(run, target, surface, set, plan);
    }
    await runReview(run, target, surface);
    await runSummary(run, target, surface);
  }
}

/**
 * Unused credit expires at the end of the cycle. From USE_IT_OR_LOSE_IT.cycleDay,
 * if less than USE_IT_OR_LOSE_IT.belowRatio of it is spent, queue one Opus 5.5
 * batch over the most-viewed scorecards — once per cycle, and only where the
 * current surface has no Opus answer yet.
 */
async function useItOrLoseIt(run: Run, targets: EvalTarget[]): Promise<{ event: string; keys: string[] } | undefined> {
  // A run limited to some servers must not spend the cycle's one pass on them.
  if (run.only) return undefined;
  const window = run.state.window;
  if (window.day < USE_IT_OR_LOSE_IT.cycleDay || run.state.exhausted || !run.client) return undefined;
  if (run.state.spentUsd >= BUDGET.creditUsd * USE_IT_OR_LOSE_IT.belowRatio) return undefined;
  const event = `use-it:${cycleId(window)}`;
  if (await run.ledger.hasEvent(event)) return undefined;

  const ranked = await rankByViews(targets.map((target) => target.seed.slug), run.log);
  const chosen = ranked.slice(0, USE_IT_OR_LOSE_IT.servers);
  const plan: SelectionPlan = { model: USE_IT_OR_LOSE_IT.model, mode: USE_IT_OR_LOSE_IT.mode, everyDays: 0 };
  const before = new Set(run.planned);
  for (const slug of chosen) {
    const target = targets.find((candidate) => candidate.seed.slug === slug);
    const set = readEvalFile(slug, "scenarios");
    if (!target || !set || set.tools_hash !== target.surface.toolsHash || set.prompt_version !== PROMPT_VERSIONS.scenarios) {
      continue;
    }
    const surface = evalSurface(target);
    if (typeof surface !== "string") await runSelection(run, target, surface, set, plan);
  }
  const keys = [...run.planned].filter((key) => !before.has(key));
  if (keys.length > 0) {
    run.log(`Day ${window.day}, ${run.state.spentUsd.toFixed(2)} USD spent: an Opus pass over ${keys.length} scorecard(s).`);
  }
  return { event, keys };
}

/**
 * One wake-up of the eval layer: record any batch a dead run left behind,
 * collect the batches that ended, recount any surface that changed, run what
 * is due on the standard API, and submit the rest as batches. Every paid step
 * passes the budget gate first.
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
    report: { footprints: [], jobs: [], batches: [], written: [], exhausted, alerts: [] },
    state: budgetState({
      now: options.now,
      spentUsd,
      pendingUsd: batches.reduce((sum, batch) => sum + batch.estimatedUsd, 0),
      exhausted
    }),
    draft: { chunks: [] },
    planned: new Set()
  };

  try {
    await reconcileOrphans(run);
    await collectBatches(run);
    const targets = evalTargets(options.only);
    options.log(`${targets.length} server(s) with a captured surface.`);
    await refreshFootprints(targets, run);
    let pass: Awaited<ReturnType<typeof useItOrLoseIt>>;
    try {
      await runModelJobs(targets, run);
      pass = await useItOrLoseIt(run, targets);
    } catch (caught) {
      if (!(caught instanceof CreditExhausted)) throw caught;
      options.log("The API reported the credit exhausted; the rest waits for the next cycle.");
    }
    if (run.client) await submitDraft(run);
    // The cycle's pass is spent only once something it queued actually went out.
    if (pass && pass.keys.length > 0) {
      const jobs = await run.ledger.jobs(pass.keys);
      if ([...jobs.values()].some((job) => job.batchId !== null)) {
        await run.ledger.claimEvent(pass.event, "use-it", { keys: pass.keys.length });
      }
    }
  } catch (caught) {
    run.report.budget = run.state;
    throw new RunFailed(run.report, caught);
  }
  run.report.budget = run.state;
  return run.report;
}
