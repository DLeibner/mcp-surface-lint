import type Anthropic from "@anthropic-ai/sdk";
import { charge, cycleWindow } from "./budget";
import { errorMessage, isCreditExhausted, isCreditExhaustedResponse } from "./client";
import { PROMPT_VERSIONS, SCENARIO_MODEL, SURFACE_LIMITS, type ModelId } from "./config";
import { ArgumentChecker, gradeSelection } from "./jobs/selection";
import { parseKey, scenariosKey, type JobKind, type ParsedKey } from "./keys";
import type { BatchRecord, BatchRequestMeta, JobRecord, UsageRecord } from "./ledger";
import { costUsd, pricedModel, roundUsd, usageFromApi } from "./pricing";
import { readEvalFile, type ScenarioSet } from "./results";
import {
  CreditExhausted,
  buildSingle,
  checkRegression,
  describeSingle,
  erroredOutcome,
  evalTargets,
  markExhausted,
  publishScenarios,
  publishSelection,
  publishSingle,
  selectionRun,
  type EvalSurface,
  type EvalTarget,
  type JobOutcome,
  type Run
} from "./run";
import { sampleTools, toApiSurface } from "./surface";

/**
 * The batch path: one run submits, a later run collects. Batches cost half,
 * and they sidestep any time limit on the runner — nothing waits for a model.
 */

/** The Message Batches API takes at most 100,000 requests or 256 MB per batch; stay well inside. */
const MAX_REQUESTS = 50_000;
const MAX_BYTES = 200 * 1024 * 1024;

/** The API ends every batch within 24 hours; one still open, or unreadable, after this is given up. */
const ABANDON_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/** How far back to look for batches the API accepted but the ledger never recorded. */
const ORPHAN_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Queues one job's requests for the batch submitted at the end of the run. A
 * job never straddles two batches: its requests share a cached prefix, and
 * the cache can only help inside one batch.
 */
export function enqueue(
  run: Run,
  record: JobRecord,
  requests: { params: Anthropic.MessageCreateParamsNonStreaming; scenarioId?: string }[],
  estimate: number,
  sampled: EvalSurface["sampled"]
): void {
  const bytes = requests.reduce((sum, request) => sum + JSON.stringify(request.params).length, 0);
  let chunk = run.draft.chunks.at(-1);
  if (!chunk || chunk.requests.length + requests.length > MAX_REQUESTS || chunk.bytes + bytes > MAX_BYTES) {
    chunk = { requests: [], meta: {}, jobs: [], bytes: 0 };
    run.draft.chunks.push(chunk);
  }
  for (const request of requests) {
    const customId = `r${String(chunk.requests.length).padStart(5, "0")}`;
    chunk.requests.push({ custom_id: customId, params: request.params });
    chunk.meta[customId] = {
      jobKey: record.key,
      ...(request.scenarioId ? { scenarioId: request.scenarioId } : {}),
      ...(sampled ? { sampled } : {})
    };
  }
  chunk.jobs.push({ record, estimate });
  chunk.bytes += bytes;
  // Reserved now, so the rest of this run sees it; the ledger holds it until collection.
  run.state = charge(run.state, estimate, true);
}

function reportJob(run: Run, record: JobRecord, outcome: JobOutcome, detail?: string, usd?: number): void {
  run.report.jobs.push({
    slug: record.serverId,
    job: record.job as JobKind,
    model: record.model as ModelId,
    outcome,
    detail,
    usd
  });
}

/** Settles a job that will not finish. Credit and infrastructure trouble are not its fault: it keeps its retry. */
function failed(run: Run, job: JobRecord, detail: string, keepRetry: boolean): JobRecord {
  return {
    ...job,
    status: "failed",
    attempts: keepRetry ? Math.max(job.attempts - 1, 0) : job.attempts,
    lastError: detail,
    updatedAt: run.now
  };
}

/**
 * Sends what the run queued. The jobs are recorded as submitted before the
 * batch is created, so a run that dies right after the API accepts a batch
 * leaves them in flight rather than queued to be bought again; the ledger
 * releases them after a while if their batch never shows up (see runner.ts).
 */
export async function submitDraft(run: Run): Promise<void> {
  for (const chunk of run.draft.chunks) {
    const estimate = roundUsd(chunk.jobs.reduce((sum, job) => sum + job.estimate, 0));
    const release = () => {
      run.state = charge(run.state, -estimate, true);
    };
    if (run.state.exhausted) {
      for (const { record } of chunk.jobs) reportJob(run, record, "deferred", "credit exhausted");
      release();
      continue;
    }

    for (const { record } of chunk.jobs) await run.ledger.saveJob(record);
    let id: string;
    try {
      id = await run.client!.createBatch(chunk.requests);
    } catch (caught) {
      const exhausted = isCreditExhausted(caught);
      if (exhausted && !run.state.exhausted) await markExhausted(run);
      const detail = exhausted ? "credit exhausted" : errorMessage(caught);
      for (const { record } of chunk.jobs) {
        await run.ledger.saveJob(failed(run, record, detail, true));
        reportJob(run, record, exhausted ? "deferred" : "failed", detail);
      }
      release();
      continue;
    }

    await run.ledger.saveBatch({
      id,
      submittedAt: run.now,
      status: "in_progress",
      requestCount: chunk.requests.length,
      estimatedUsd: estimate,
      requests: chunk.meta,
      collectedAt: null
    });
    for (const { record, estimate: jobEstimate } of chunk.jobs) {
      await run.ledger.saveJob({ ...record, batchId: id });
      reportJob(run, record, "submitted", `batch ${id}`, roundUsd(jobEstimate));
    }
    run.report.batches.push({ id, outcome: "submitted", requests: chunk.requests.length, usd: estimate });
  }
  run.draft.chunks = [];
}

function describe(result: Anthropic.Messages.MessageBatchResult | undefined): string {
  if (!result) return "the batch returned no result for this request";
  if (result.type === "errored") return result.error.error.message;
  if (result.type === "expired") return "the batch expired before this request ran";
  return `the request was ${result.type}`;
}

/** The tools a job was asked about, rebuilt from what its requests recorded rather than from today's files. */
function askedSurface(target: EvalTarget, sampled: BatchRequestMeta["sampled"]): Pick<EvalSurface, "tools" | "sampled"> {
  const { tools, toolsHash } = target.surface;
  return sampled
    ? { tools: sampleTools(tools, toolsHash, SURFACE_LIMITS.sampleSize), sampled }
    : { tools, sampled: null };
}

/**
 * The scenario set a selection job was built on. The file can lag the ledger
 * when a run's commit was lost; the set itself is still in the ledger, so it
 * is restored rather than the paid answers being thrown away.
 */
async function scenarioSetFor(run: Run, parsed: ParsedKey): Promise<ScenarioSet | undefined> {
  const matches = (set: ScenarioSet | undefined) =>
    set && set.version === parsed.scenarioSet && set.tools_hash === parsed.toolsHash ? set : undefined;
  const file = matches(readEvalFile(parsed.slug, "scenarios"));
  if (file) return file;
  const key = scenariosKey(parsed.slug, parsed.toolsHash, SCENARIO_MODEL, PROMPT_VERSIONS.scenarios);
  const job = (await run.ledger.jobs([key])).get(key);
  const stored = matches(job?.status === "done" ? (job.result as ScenarioSet) : undefined);
  if (stored) publishScenarios(run, stored);
  return stored;
}

/** Grades and publishes one job's results; a job the surface has moved past is not published. */
async function finalize(
  run: Run,
  batch: BatchRecord,
  jobKey: string,
  job: JobRecord | undefined,
  results: Map<string, Anthropic.Messages.MessageBatchResult>,
  context: { usd: number; billingError: boolean; sampled: BatchRequestMeta["sampled"] }
): Promise<void> {
  // A job whose record points at another batch was resubmitted; that batch settles it.
  if (!job || job.status !== "submitted" || (job.batchId !== null && job.batchId !== batch.id)) return;
  const usd = roundUsd(context.usd);
  const fail = async (detail: string, keepRetry = false) => {
    await run.ledger.saveJob(failed(run, job, detail, keepRetry));
    reportJob(run, job, "failed", detail, usd);
  };

  const parsed = parseKey(jobKey);
  if (!parsed) return fail("the job's key is no longer understood; a model changed while its batch ran");
  if (context.billingError) return fail("credit exhausted", true);
  const target = evalTargets(new Set([parsed.slug]))[0];
  if (!target || target.surface.toolsHash !== parsed.toolsHash) {
    return fail("the surface changed before the batch was collected");
  }
  const surface = askedSurface(target, context.sampled);

  let previous;
  let published;
  try {
    if (parsed.job !== "selection") {
      const answer = results.get("");
      if (answer?.type !== "succeeded") return fail(describe(answer));
      const single = { ...parsed, job: parsed.job };
      const result = buildSingle(jobKey, single, target, surface, answer.message, run.now, usd);
      publishSingle(run, single.job, result);
      await run.ledger.saveJob({ ...job, status: "done", result, completedAt: run.now, updatedAt: run.now });
      reportJob(run, job, "done", describeSingle(single.job, result), usd);
      return;
    }

    const set = await scenarioSetFor(run, parsed);
    if (!set) return fail("the scenario set changed before the batch was collected");
    const api = toApiSurface(surface.tools);
    const checker = new ArgumentChecker(api.schemas);
    const outcomes = set.scenarios.map((scenario) => {
      const result = results.get(scenario.id);
      return result?.type === "succeeded"
        ? gradeSelection(scenario, result.message, api, checker)
        : erroredOutcome(scenario.id);
    });
    published = selectionRun({
      key: jobKey,
      model: parsed.model,
      toolsHash: parsed.toolsHash,
      set,
      mode: "batch",
      now: run.now,
      sampled: surface.sampled,
      outcomes,
      usd
    });
    previous = publishSelection(run, parsed.slug, published);
    await run.ledger.saveJob({ ...job, status: "done", result: published, completedAt: run.now, updatedAt: run.now });
    reportJob(run, job, "done", `accuracy ${published.metrics.selection_accuracy ?? "n/a"}`, published.usd);
  } catch (caught) {
    return fail(errorMessage(caught));
  }
  await checkRegression(run, parsed.slug, previous, published);
}

/** Gives up on a batch that will never be readable, releasing its reservation and its jobs. */
async function abandon(run: Run, batch: BatchRecord, reason: string): Promise<void> {
  const keys = [...new Set(Object.values(batch.requests).map((meta) => meta.jobKey))];
  for (const job of (await run.ledger.jobs(keys)).values()) {
    if (job.status === "submitted" && (job.batchId === batch.id || job.batchId === null)) {
      await run.ledger.saveJob(failed(run, job, `batch abandoned: ${reason}`, true));
    }
  }
  await run.ledger.saveBatch({ ...batch, status: "abandoned", collectedAt: run.now });
  run.state = charge(run.state, -batch.estimatedUsd, true);
  run.report.batches.push({ id: batch.id, outcome: "abandoned", requests: batch.requestCount, detail: reason });
}

/** Batches that ended since the last run: their cost goes on the ledger, their answers get graded. */
export async function collectBatches(run: Run): Promise<void> {
  const window = cycleWindow(run.now);
  for (const batch of await run.ledger.openBatches()) {
    if (!run.client) {
      run.report.batches.push({ id: batch.id, outcome: "in-progress", requests: batch.requestCount, detail: "not checked in a dry run" });
      continue;
    }
    const stale = run.now.getTime() - batch.submittedAt.getTime() > ABANDON_AFTER_MS;

    try {
      const status = await run.client.batchStatus(batch.id);
      if (status !== "ended") {
        if (stale) await abandon(run, batch, `still ${status} after three days`);
        else run.report.batches.push({ id: batch.id, outcome: "in-progress", requests: batch.requestCount });
        continue;
      }

      const jobKeys = [...new Set(Object.values(batch.requests).map((meta) => meta.jobKey))];
      const jobs = await run.ledger.jobs(jobKeys);
      const results = new Map<string, Map<string, Anthropic.Messages.MessageBatchResult>>();
      const usdByJob = new Map<string, number>();
      const billing = new Set<string>();
      const usage: UsageRecord[] = [];

      for await (const item of run.client.batchResults(batch.id)) {
        const meta = batch.requests[item.custom_id];
        if (!meta) continue;
        const [kind = "unknown", slug = "unknown"] = meta.jobKey.split("|");
        if (item.result.type === "succeeded") {
          // Priced from the response itself, so a key that no longer parses is still billed.
          const model = pricedModel(item.result.message.model);
          const tokens = usageFromApi(item.result.message.usage);
          const cost = costUsd(model, tokens, true);
          usdByJob.set(meta.jobKey, (usdByJob.get(meta.jobKey) ?? 0) + cost);
          usage.push({
            job: kind,
            serverId: slug,
            model,
            usage: tokens,
            usd: cost,
            batch: true,
            batchId: batch.id,
            requestId: item.custom_id,
            jobKey: meta.jobKey
          });
        } else if (item.result.type === "errored" && isCreditExhaustedResponse(item.result.error)) {
          billing.add(meta.jobKey);
          // Only a batch from this cycle says anything about this cycle's credit.
          if (batch.submittedAt >= window.start && !run.state.exhausted) await markExhausted(run);
        }
        const byScenario = results.get(meta.jobKey) ?? new Map();
        byScenario.set(meta.scenarioId ?? "", item.result);
        results.set(meta.jobKey, byScenario);
      }

      // Bill first: whatever happens to the answers, the money was spent.
      await run.ledger.recordUsages(usage);
      const spent = usage.reduce((sum, record) => sum + record.usd, 0);
      for (const jobKey of jobKeys) {
        const sampled = Object.values(batch.requests).find((meta) => meta.jobKey === jobKey)?.sampled;
        await finalize(run, batch, jobKey, jobs.get(jobKey), results.get(jobKey) ?? new Map(), {
          usd: usdByJob.get(jobKey) ?? 0,
          billingError: billing.has(jobKey),
          sampled
        });
      }
      await run.ledger.saveBatch({ ...batch, status: "collected", collectedAt: run.now });
      run.state = charge(charge(run.state, spent), -batch.estimatedUsd, true);
      run.report.batches.push({ id: batch.id, outcome: "collected", requests: batch.requestCount, usd: roundUsd(spent) });
    } catch (caught) {
      if (stale) await abandon(run, batch, errorMessage(caught));
      else run.report.batches.push({ id: batch.id, outcome: "failed", requests: batch.requestCount, detail: errorMessage(caught) });
    }
  }
}

/**
 * A batch the API accepted but the ledger never recorded: the run died between
 * the two. Its answers can no longer be routed to jobs, but its cost is real,
 * so it is recorded and the budget gate sees what was spent.
 */
export async function reconcileOrphans(run: Run): Promise<void> {
  if (!run.client) return;
  let recent: { id: string; createdAt: Date; ended: boolean }[];
  try {
    recent = await run.client.recentBatches(new Date(run.now.getTime() - ORPHAN_WINDOW_MS));
  } catch (caught) {
    run.log(`Could not list recent batches to reconcile: ${errorMessage(caught)}`);
    return;
  }
  const known = await run.ledger.knownBatches(recent.map((batch) => batch.id));
  for (const batch of recent) {
    if (known.has(batch.id) || !batch.ended) continue;
    const usage: UsageRecord[] = [];
    for await (const item of run.client.batchResults(batch.id)) {
      if (item.result.type !== "succeeded") continue;
      const model = pricedModel(item.result.message.model);
      const tokens = usageFromApi(item.result.message.usage);
      usage.push({
        job: "orphan",
        serverId: "unknown",
        model,
        usage: tokens,
        usd: costUsd(model, tokens, true),
        batch: true,
        batchId: batch.id,
        requestId: item.custom_id
      });
    }
    await run.ledger.recordUsages(usage);
    await run.ledger.saveBatch({
      id: batch.id,
      submittedAt: batch.createdAt,
      status: "collected",
      requestCount: usage.length,
      estimatedUsd: 0,
      requests: {},
      collectedAt: run.now
    });
    const spent = usage.reduce((sum, record) => sum + record.usd, 0);
    run.state = charge(run.state, spent);
    run.report.batches.push({
      id: batch.id,
      outcome: "reconciled",
      requests: usage.length,
      usd: roundUsd(spent),
      detail: "submitted by a run that died before recording it"
    });
  }
}
