import { desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { getDb } from "../db/client";
import * as schema from "../db/schema";
import { llmBatches, llmEvents, llmJobs, llmUsage } from "../db/schema";
import type { Mode, ModelId } from "./config";
import { roundUsd, type TokenUsage } from "./pricing";
import { byJobAndModel, byServer, type ServerTotal, type UsageBucket } from "./usage-report";

export interface UsageRecord {
  job: string;
  serverId: string;
  model: ModelId;
  usage: TokenUsage;
  usd: number;
  batch: boolean;
  batchId?: string;
  /** The request's custom_id, for calls made through a batch. */
  requestId?: string;
  jobKey?: string;
  at?: Date;
}

export interface UsageRow {
  at: Date;
  job: string;
  serverId: string;
  model: string;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  usd: number;
  batch: boolean;
  batchId: string | null;
  requestId: string | null;
  jobKey: string | null;
}

/** What one request in a batch was for, so its result can be routed back on collection. */
export interface BatchRequestMeta {
  jobKey: string;
  /** Set on selection requests: one request per scenario. */
  scenarioId?: string;
}

export interface BatchRecord {
  id: string;
  submittedAt: Date;
  status: "in_progress" | "collected";
  requestCount: number;
  /** Worst-case cost, reserved against the budget until the batch is collected. */
  estimatedUsd: number;
  requests: Record<string, BatchRequestMeta>;
  collectedAt: Date | null;
}

export type JobStatus = "submitted" | "done" | "failed";

export interface JobRecord {
  key: string;
  job: string;
  serverId: string;
  model: string;
  status: JobStatus;
  mode: Mode;
  batchId: string | null;
  attempts: number;
  lastError: string | null;
  result: unknown;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

/**
 * Persistence for the LLM layer's money and state. Postgres in CI and
 * production; an in-memory stand-in for tests and local dry runs, mirroring
 * how lib/store.ts treats lint runs.
 */
export interface LlmLedger {
  readonly durable: boolean;
  recordUsage(record: UsageRecord): Promise<void>;
  /** Many at once. A batch request already recorded (same batch, same custom_id) is skipped. */
  recordUsages(records: readonly UsageRecord[]): Promise<void>;
  spentSince(since: Date): Promise<number>;
  /** Newest first, at most `limit` rows. */
  usageSince(since: Date, limit?: number): Promise<UsageRow[]>;
  /** Totals grouped where the rows live: a cycle can hold tens of thousands of calls. */
  usageByJobAndModel(since: Date): Promise<UsageBucket[]>;
  usageByServer(since: Date, limit: number): Promise<ServerTotal[]>;
  openBatches(): Promise<BatchRecord[]>;
  saveBatch(batch: BatchRecord): Promise<void>;
  jobs(keys: readonly string[]): Promise<Map<string, JobRecord>>;
  saveJob(job: JobRecord): Promise<void>;
  /** True when this call created the event; false when it had already happened. */
  claimEvent(key: string, kind: string, detail?: unknown): Promise<boolean>;
  hasEvent(key: string): Promise<boolean>;
}

export class MemoryLedger implements LlmLedger {
  readonly durable: boolean = false;
  readonly usage: UsageRow[] = [];
  readonly batches = new Map<string, BatchRecord>();
  readonly jobRecords = new Map<string, JobRecord>();
  readonly events = new Map<string, { kind: string; detail: unknown; at: Date }>();

  async recordUsage(record: UsageRecord): Promise<void> {
    this.usage.push(toRow(record));
  }

  async recordUsages(records: readonly UsageRecord[]): Promise<void> {
    for (const record of records) {
      const duplicate =
        record.batchId !== undefined &&
        record.requestId !== undefined &&
        this.usage.some((row) => row.batchId === record.batchId && row.requestId === record.requestId);
      if (!duplicate) this.usage.push(toRow(record));
    }
  }

  async spentSince(since: Date): Promise<number> {
    return this.usage.filter((row) => row.at >= since).reduce((sum, row) => sum + row.usd, 0);
  }

  async usageSince(since: Date, limit = Number.POSITIVE_INFINITY): Promise<UsageRow[]> {
    return this.usage
      .filter((row) => row.at >= since)
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, limit);
  }

  async usageByJobAndModel(since: Date): Promise<UsageBucket[]> {
    return byJobAndModel(await this.usageSince(since));
  }

  async usageByServer(since: Date, limit: number): Promise<ServerTotal[]> {
    return byServer(await this.usageSince(since)).slice(0, limit);
  }

  async openBatches(): Promise<BatchRecord[]> {
    return [...this.batches.values()].filter((batch) => batch.status === "in_progress");
  }

  async saveBatch(batch: BatchRecord): Promise<void> {
    this.batches.set(batch.id, structuredClone(batch));
  }

  async jobs(keys: readonly string[]): Promise<Map<string, JobRecord>> {
    const found = new Map<string, JobRecord>();
    for (const key of keys) {
      const job = this.jobRecords.get(key);
      if (job) found.set(key, structuredClone(job));
    }
    return found;
  }

  async saveJob(job: JobRecord): Promise<void> {
    this.jobRecords.set(job.key, structuredClone(job));
  }

  async claimEvent(key: string, kind: string, detail?: unknown): Promise<boolean> {
    if (this.events.has(key)) return false;
    this.events.set(key, { kind, detail, at: new Date() });
    return true;
  }

  async hasEvent(key: string): Promise<boolean> {
    return this.events.has(key);
  }
}

function toRow(record: UsageRecord): UsageRow {
  return {
    at: record.at ?? new Date(),
    job: record.job,
    serverId: record.serverId,
    model: record.model,
    inputTokens: record.usage.inputTokens,
    cacheWriteTokens: record.usage.cacheWriteTokens,
    cacheReadTokens: record.usage.cacheReadTokens,
    outputTokens: record.usage.outputTokens,
    usd: record.usd,
    batch: record.batch,
    batchId: record.batchId ?? null,
    requestId: record.requestId ?? null,
    jobKey: record.jobKey ?? null
  };
}

/** Rows per INSERT when recording a collected batch. */
const INSERT_CHUNK = 500;

/** Any Drizzle Postgres database: Neon over HTTP in production, PGlite in tests. */
export type LedgerDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export class PostgresLedger implements LlmLedger {
  readonly durable: boolean = true;

  constructor(private readonly injected?: LedgerDb) {}

  private get db(): LedgerDb {
    return this.injected ?? getDb();
  }

  async recordUsage(record: UsageRecord): Promise<void> {
    await this.recordUsages([record]);
  }

  async recordUsages(records: readonly UsageRecord[]): Promise<void> {
    for (let i = 0; i < records.length; i += INSERT_CHUNK) {
      const values = records.slice(i, i + INSERT_CHUNK).map((record) => {
        const { at, ...row } = toRow(record);
        return { ...row, createdAt: at, usd: row.usd.toFixed(6) };
      });
      await this.db.insert(llmUsage).values(values).onConflictDoNothing();
    }
  }

  async spentSince(since: Date): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`coalesce(sum(${llmUsage.usd}), 0)` })
      .from(llmUsage)
      .where(gte(llmUsage.createdAt, since));
    return Number(row?.total ?? 0);
  }

  async usageByJobAndModel(since: Date): Promise<UsageBucket[]> {
    const rows = await this.db
      .select({
        job: llmUsage.job,
        model: llmUsage.model,
        calls: sql<number>`count(*)::int`,
        batchCalls: sql<number>`count(*) filter (where ${llmUsage.batch})::int`,
        inputTokens: sql<number>`coalesce(sum(${llmUsage.inputTokens}), 0)::bigint`,
        cacheWriteTokens: sql<number>`coalesce(sum(${llmUsage.cacheWriteTokens}), 0)::bigint`,
        cacheReadTokens: sql<number>`coalesce(sum(${llmUsage.cacheReadTokens}), 0)::bigint`,
        outputTokens: sql<number>`coalesce(sum(${llmUsage.outputTokens}), 0)::bigint`,
        usd: sql<string>`coalesce(sum(${llmUsage.usd}), 0)`
      })
      .from(llmUsage)
      .where(gte(llmUsage.createdAt, since))
      .groupBy(llmUsage.job, llmUsage.model);
    return rows
      .map((row) => ({
        job: row.job,
        model: row.model,
        calls: Number(row.calls),
        batchCalls: Number(row.batchCalls),
        inputTokens: Number(row.inputTokens),
        cacheWriteTokens: Number(row.cacheWriteTokens),
        cacheReadTokens: Number(row.cacheReadTokens),
        outputTokens: Number(row.outputTokens),
        usd: roundUsd(Number(row.usd))
      }))
      .sort((a, b) => b.usd - a.usd || a.job.localeCompare(b.job) || a.model.localeCompare(b.model));
  }

  async usageByServer(since: Date, limit: number): Promise<ServerTotal[]> {
    const usd = sql<string>`coalesce(sum(${llmUsage.usd}), 0)`;
    const rows = await this.db
      .select({ serverId: llmUsage.serverId, calls: sql<number>`count(*)::int`, usd })
      .from(llmUsage)
      .where(gte(llmUsage.createdAt, since))
      .groupBy(llmUsage.serverId)
      .orderBy(desc(usd), llmUsage.serverId)
      .limit(limit);
    return rows.map((row) => ({ serverId: row.serverId, calls: Number(row.calls), usd: roundUsd(Number(row.usd)) }));
  }

  async usageSince(since: Date, limit?: number): Promise<UsageRow[]> {
    const query = this.db
      .select()
      .from(llmUsage)
      .where(gte(llmUsage.createdAt, since))
      .orderBy(desc(llmUsage.createdAt));
    const rows = await (limit === undefined ? query : query.limit(limit));
    return rows.map((row) => ({
      at: row.createdAt,
      job: row.job,
      serverId: row.serverId,
      model: row.model,
      inputTokens: row.inputTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      cacheReadTokens: row.cacheReadTokens,
      outputTokens: row.outputTokens,
      usd: Number(row.usd),
      batch: row.batch,
      batchId: row.batchId,
      requestId: row.requestId,
      jobKey: row.jobKey
    }));
  }

  async openBatches(): Promise<BatchRecord[]> {
    const rows = await this.db
      .select()
      .from(llmBatches)
      .where(eq(llmBatches.status, "in_progress"))
      .orderBy(llmBatches.submittedAt);
    return rows.map((row) => ({
      id: row.id,
      submittedAt: row.submittedAt,
      status: row.status as BatchRecord["status"],
      requestCount: row.requestCount,
      estimatedUsd: Number(row.estimatedUsd),
      requests: row.requests as BatchRecord["requests"],
      collectedAt: row.collectedAt
    }));
  }

  async saveBatch(batch: BatchRecord): Promise<void> {
    const values = { ...batch, estimatedUsd: batch.estimatedUsd.toFixed(6) };
    await this.db
      .insert(llmBatches)
      .values(values)
      .onConflictDoUpdate({
        target: llmBatches.id,
        set: { status: values.status, collectedAt: values.collectedAt }
      });
  }

  async jobs(keys: readonly string[]): Promise<Map<string, JobRecord>> {
    const found = new Map<string, JobRecord>();
    if (keys.length === 0) return found;
    const rows = await this.db
      .select()
      .from(llmJobs)
      .where(inArray(llmJobs.key, [...keys]));
    for (const row of rows) {
      found.set(row.key, {
        ...row,
        status: row.status as JobStatus,
        mode: row.mode as Mode
      });
    }
    return found;
  }

  async saveJob(job: JobRecord): Promise<void> {
    const values = { ...job, result: job.result ?? null };
    const { key: _key, createdAt: _createdAt, ...updates } = values;
    await this.db
      .insert(llmJobs)
      .values(values)
      .onConflictDoUpdate({ target: llmJobs.key, set: updates });
  }

  async claimEvent(key: string, kind: string, detail?: unknown): Promise<boolean> {
    const inserted = await this.db
      .insert(llmEvents)
      .values({ key, kind, detail: detail ?? null })
      .onConflictDoNothing()
      .returning({ key: llmEvents.key });
    return inserted.length > 0;
  }

  async hasEvent(key: string): Promise<boolean> {
    const rows = await this.db
      .select({ key: llmEvents.key })
      .from(llmEvents)
      .where(eq(llmEvents.key, key))
      .limit(1);
    return rows.length > 0;
  }
}

let cached: LlmLedger | undefined;

export function getLedger(): LlmLedger {
  if (!cached) cached = process.env.DATABASE_URL ? new PostgresLedger() : new MemoryLedger();
  return cached;
}
