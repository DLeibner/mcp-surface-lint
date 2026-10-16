import type Anthropic from "@anthropic-ai/sdk";
import { charge } from "./budget";
import { errorMessage, isCreditExhausted, isCreditExhaustedResponse } from "./client";
import type { ModelId } from "./config";
import { parseScenarios } from "./jobs/scenarios";
import { ArgumentChecker, gradeSelection } from "./jobs/selection";
import { parseKey, type JobKind } from "./keys";
import type { JobRecord, UsageRecord } from "./ledger";
import { costUsd, roundUsd, usageFromApi } from "./pricing";
import { readEvalFile, type ScenarioSet } from "./results";
import {
  CreditExhausted,
  erroredOutcome,
  evalSurface,
  evalTargets,
  markExhausted,
  publishScenarios,
  publishSelection,
  selectionRun,
  type JobOutcome,
  type Run
} from "./run";
import { toApiSurface } from "./surface";

/**
 * The batch path: one run submits, a later run collects. Batches cost half,
 * and they sidestep any time limit on the runner — nothing waits for a model.
 */

/** The Message Batches API takes at most 100,000 requests or 256 MB per batch; stay well inside. */
const MAX_REQUESTS = 50_000;
const MAX_BYTES = 200 * 1024 * 1024;

/**
 * Queues one job's requests for the batch submitted at the end of the run. A
 * job never straddles two batches: its requests share a cached prefix, and
 * the cache can only help inside one batch.
 */
export function enqueue(
  run: Run,
  record: JobRecord,
  requests: { params: Anthropic.MessageCreateParamsNonStreaming; scenarioId?: string }[],
  estimate: number
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
      ...(request.scenarioId ? { scenarioId: request.scenarioId } : {})
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

/** Sends what the run queued. A job is recorded only once its batch exists. */
export async function submitDraft(run: Run): Promise<void> {
  for (const chunk of run.draft.chunks) {
    const estimate = roundUsd(chunk.jobs.reduce((sum, job) => sum + job.estimate, 0));
    let id: string;
    try {
      if (run.state.exhausted) throw new CreditExhausted();
      id = await run.client!.createBatch(chunk.requests);
    } catch (caught) {
      const exhausted = caught instanceof CreditExhausted || isCreditExhausted(caught);
      if (exhausted && !run.state.exhausted) await markExhausted(run);
      for (const { record } of chunk.jobs) {
        reportJob(run, record, exhausted ? "deferred" : "failed", exhausted ? "credit exhausted" : errorMessage(caught));
      }
      run.state = charge(run.state, -estimate, true);
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

/** Grades and publishes one job's results; a job the surface has moved past is not published. */
async function finalize(
  run: Run,
  jobKey: string,
  job: JobRecord | undefined,
  results: Map<string, Anthropic.Messages.MessageBatchResult>,
  usd: number
): Promise<void> {
  const parsed = parseKey(jobKey);
  if (!job || !parsed || job.status !== "submitted") return;
  const fail = async (detail: string) => {
    await run.ledger.saveJob({ ...job, status: "failed", lastError: detail, updatedAt: run.now });
    reportJob(run, job, "failed", detail, roundUsd(usd));
  };

  const target = evalTargets(new Set([parsed.slug]))[0];
  if (!target || target.surface.toolsHash !== parsed.toolsHash) {
    return fail("the surface changed before the batch was collected");
  }
  const surface = evalSurface(target);
  if (typeof surface === "string") return fail(surface);

  try {
    if (parsed.job === "scenarios") {
      const result = results.get("");
      if (result?.type !== "succeeded") return fail(describe(result));
      const current = readEvalFile(parsed.slug, "scenarios");
      const set: ScenarioSet = {
        slug: parsed.slug,
        version: (current?.version ?? 0) + 1,
        tools_hash: parsed.toolsHash,
        generated_at: run.now.toISOString(),
        model: parsed.model,
        prompt_version: parsed.promptVersion,
        sampled: surface.sampled,
        scenarios: parseScenarios(result.message, surface.tools)
      };
      publishScenarios(run, set);
      await run.ledger.saveJob({ ...job, status: "done", result: set, completedAt: run.now, updatedAt: run.now });
      reportJob(run, job, "done", `${set.scenarios.length} scenarios, set v${set.version}`, roundUsd(usd));
      return;
    }

    const set = readEvalFile(parsed.slug, "scenarios");
    if (!set || set.version !== parsed.scenarioSet || set.tools_hash !== parsed.toolsHash) {
      return fail("the scenario set changed before the batch was collected");
    }
    const api = toApiSurface(surface.tools);
    const checker = new ArgumentChecker(api.schemas);
    const outcomes = set.scenarios.map((scenario) => {
      const result = results.get(scenario.id);
      return result?.type === "succeeded"
        ? gradeSelection(scenario, result.message, api, checker)
        : erroredOutcome(scenario.id);
    });
    const result = selectionRun({
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
    publishSelection(run, parsed.slug, result);
    await run.ledger.saveJob({ ...job, status: "done", result, completedAt: run.now, updatedAt: run.now });
    reportJob(run, job, "done", `accuracy ${result.metrics.selection_accuracy ?? "n/a"}`, result.usd);
  } catch (caught) {
    await fail(errorMessage(caught));
  }
}

/** Batches that ended since the last run: their cost goes on the ledger, their answers get graded. */
export async function collectBatches(run: Run): Promise<void> {
  for (const batch of await run.ledger.openBatches()) {
    if (!run.client) {
      run.report.batches.push({ id: batch.id, outcome: "in-progress", requests: batch.requestCount, detail: "not checked in a dry run" });
      continue;
    }

    try {
      const status = await run.client.batchStatus(batch.id);
      if (status !== "ended") {
        run.report.batches.push({ id: batch.id, outcome: "in-progress", requests: batch.requestCount });
        continue;
      }

      const jobKeys = [...new Set(Object.values(batch.requests).map((meta) => meta.jobKey))];
      const jobs = await run.ledger.jobs(jobKeys);
      const results = new Map<string, Map<string, Anthropic.Messages.MessageBatchResult>>();
      const usdByJob = new Map<string, number>();
      const usage: UsageRecord[] = [];

      for await (const item of run.client.batchResults(batch.id)) {
        const meta = batch.requests[item.custom_id];
        const parsed = meta ? parseKey(meta.jobKey) : undefined;
        if (!meta || !parsed) continue;
        if (item.result.type === "succeeded") {
          const tokens = usageFromApi(item.result.message.usage);
          const cost = costUsd(parsed.model, tokens, true);
          usdByJob.set(meta.jobKey, (usdByJob.get(meta.jobKey) ?? 0) + cost);
          usage.push({
            job: parsed.job,
            serverId: parsed.slug,
            model: parsed.model,
            usage: tokens,
            usd: cost,
            batch: true,
            batchId: batch.id,
            requestId: item.custom_id,
            jobKey: meta.jobKey
          });
        } else if (item.result.type === "errored" && isCreditExhaustedResponse(item.result.error)) {
          if (!run.state.exhausted) await markExhausted(run);
        }
        const byScenario = results.get(meta.jobKey) ?? new Map();
        byScenario.set(meta.scenarioId ?? "", item.result);
        results.set(meta.jobKey, byScenario);
      }

      // Bill first: whatever happens to the answers, the money was spent.
      await run.ledger.recordUsages(usage);
      const spent = usage.reduce((sum, record) => sum + record.usd, 0);
      for (const jobKey of jobKeys) {
        await finalize(run, jobKey, jobs.get(jobKey), results.get(jobKey) ?? new Map(), usdByJob.get(jobKey) ?? 0);
      }
      await run.ledger.saveBatch({ ...batch, status: "collected", collectedAt: run.now });
      run.state = charge(charge(run.state, spent), -batch.estimatedUsd, true);
      run.report.batches.push({ id: batch.id, outcome: "collected", requests: batch.requestCount, usd: roundUsd(spent) });
    } catch (caught) {
      run.report.batches.push({ id: batch.id, outcome: "failed", requests: batch.requestCount, detail: errorMessage(caught) });
    }
  }
}
