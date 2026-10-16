import type { UsageRow } from "./ledger";
import { roundUsd } from "./pricing";

export interface UsageBucket {
  job: string;
  model: string;
  calls: number;
  batchCalls: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  usd: number;
}

/** Cycle spend grouped by job and model, most expensive first. */
export function byJobAndModel(rows: readonly UsageRow[]): UsageBucket[] {
  const buckets = new Map<string, UsageBucket>();
  for (const row of rows) {
    const key = `${row.job}\u0000${row.model}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        job: row.job,
        model: row.model,
        calls: 0,
        batchCalls: 0,
        inputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        usd: 0
      };
      buckets.set(key, bucket);
    }
    bucket.calls += 1;
    if (row.batch) bucket.batchCalls += 1;
    bucket.inputTokens += row.inputTokens;
    bucket.cacheWriteTokens += row.cacheWriteTokens;
    bucket.cacheReadTokens += row.cacheReadTokens;
    bucket.outputTokens += row.outputTokens;
    bucket.usd = roundUsd(bucket.usd + row.usd);
  }
  return [...buckets.values()].sort(
    (a, b) => b.usd - a.usd || a.job.localeCompare(b.job) || a.model.localeCompare(b.model)
  );
}

/** Cycle spend per server, most expensive first. */
export function byServer(rows: readonly UsageRow[]): { serverId: string; calls: number; usd: number }[] {
  const totals = new Map<string, { serverId: string; calls: number; usd: number }>();
  for (const row of rows) {
    const total = totals.get(row.serverId) ?? { serverId: row.serverId, calls: 0, usd: 0 };
    total.calls += 1;
    total.usd = roundUsd(total.usd + row.usd);
    totals.set(row.serverId, total);
  }
  return [...totals.values()].sort((a, b) => b.usd - a.usd || a.serverId.localeCompare(b.serverId));
}
