import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { HAIKU, SONNET } from "./config";
import {
  MemoryLedger,
  PostgresLedger,
  type BatchRecord,
  type JobRecord,
  type LedgerDb,
  type LlmLedger,
  type UsageRecord
} from "./ledger";

const MIGRATIONS = path.resolve(process.cwd(), "drizzle");

/** Applies the checked-in migrations, in journal order, to a fresh in-process Postgres. */
async function migratedDb(): Promise<LedgerDb> {
  const client = new PGlite();
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  for (const { tag } of journal.entries) {
    const sql = readFileSync(path.join(MIGRATIONS, `${tag}.sql`), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.exec(statement);
    }
  }
  return drizzle(client, { schema }) as unknown as LedgerDb;
}

const tokens = {
  inputTokens: 1_000,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 500,
  outputTokens: 100
};

function batch(id: string, estimatedUsd: number): BatchRecord {
  return {
    id,
    submittedAt: new Date("2026-10-10T00:00:00Z"),
    status: "in_progress",
    requestCount: 2,
    estimatedUsd,
    requests: { r0: { jobKey: "k", scenarioId: "s01" }, r1: { jobKey: "k", scenarioId: "s02" } },
    collectedAt: null
  };
}

function job(key: string, overrides: Partial<JobRecord> = {}): JobRecord {
  const at = new Date("2026-10-10T00:00:00Z");
  return {
    key,
    job: "selection",
    serverId: "context7",
    model: SONNET,
    status: "submitted",
    mode: "batch",
    batchId: "msgbatch_1",
    attempts: 1,
    lastError: null,
    result: null,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    ...overrides
  };
}

const ledgers: [string, () => Promise<LlmLedger>][] = [
  ["memory", async () => new MemoryLedger()],
  ["postgres", async () => new PostgresLedger(await migratedDb())]
];

describe.each(ledgers)("%s ledger", (_name, create) => {
  let ledger: LlmLedger;
  beforeEach(async () => {
    ledger = await create();
  });

  it("sums usage from the cycle start and lists it newest first", async () => {
    const base = { job: "selection", serverId: "context7", usage: tokens, batch: false };
    await ledger.recordUsage({ ...base, model: SONNET, usd: 0.03, at: new Date("2026-09-30T23:59:59Z") });
    await ledger.recordUsage({ ...base, model: SONNET, usd: 0.000123, at: new Date("2026-10-02T00:00:00Z") });
    await ledger.recordUsage({ ...base, model: HAIKU, usd: 0.02, at: new Date("2026-10-03T00:00:00Z") });

    const since = new Date("2026-10-01T00:00:00Z");
    expect(await ledger.spentSince(since)).toBeCloseTo(0.020123, 6);
    const rows = await ledger.usageSince(since);
    expect(rows.map((row) => row.usd)).toEqual([0.02, 0.000123]);
    expect(rows[0]).toMatchObject({ model: HAIKU, cacheReadTokens: 500, batch: false, batchId: null });
  });

  it("records a collected batch once, however often it is collected", async () => {
    const row = (requestId: string): UsageRecord => ({
      job: "selection",
      serverId: "context7",
      model: SONNET,
      usage: tokens,
      usd: 0.001,
      batch: true,
      batchId: "msgbatch_1",
      requestId
    });
    await ledger.recordUsages([row("r00000"), row("r00001")]);
    await ledger.recordUsages([row("r00000"), row("r00001"), row("r00002")]);
    // Standard calls carry no request id and never collide.
    await ledger.recordUsage({ ...row("x"), batch: false, batchId: undefined, requestId: undefined });
    await ledger.recordUsage({ ...row("x"), batch: false, batchId: undefined, requestId: undefined });

    const rows = await ledger.usageSince(new Date(0));
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.batch).map((r) => r.requestId).sort()).toEqual(["r00000", "r00001", "r00002"]);
  });

  it("keeps open batches until they are collected", async () => {
    await ledger.saveBatch(batch("msgbatch_1", 0.5));
    await ledger.saveBatch(batch("msgbatch_2", 0.25));
    expect((await ledger.openBatches()).map((b) => b.estimatedUsd).sort()).toEqual([0.25, 0.5]);

    await ledger.saveBatch({
      ...batch("msgbatch_1", 0.5),
      status: "collected",
      collectedAt: new Date("2026-10-10T06:00:00Z")
    });
    const open = await ledger.openBatches();
    expect(open.map((b) => b.id)).toEqual(["msgbatch_2"]);
    expect(open[0]?.requests.r1).toEqual({ jobKey: "k", scenarioId: "s02" });
  });

  it("upserts jobs by key", async () => {
    await ledger.saveJob(job("a"));
    await ledger.saveJob(
      job("a", { status: "done", result: { accuracy: 0.9 }, completedAt: new Date("2026-10-10T06:00:00Z") })
    );
    const found = await ledger.jobs(["a", "missing"]);
    expect([...found.keys()]).toEqual(["a"]);
    expect(found.get("a")).toMatchObject({ status: "done", result: { accuracy: 0.9 }, attempts: 1 });
    expect((await ledger.jobs([])).size).toBe(0);
  });

  it("claims an event exactly once", async () => {
    expect(await ledger.hasEvent("hard-stop:2026-10-01")).toBe(false);
    expect(await ledger.claimEvent("hard-stop:2026-10-01", "hard-stop", { spent: 95 })).toBe(true);
    expect(await ledger.claimEvent("hard-stop:2026-10-01", "hard-stop")).toBe(false);
    expect(await ledger.hasEvent("hard-stop:2026-10-01")).toBe(true);
  });
});
