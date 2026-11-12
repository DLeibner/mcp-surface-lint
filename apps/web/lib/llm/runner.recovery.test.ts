import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OPUS, SONNET } from "./config";
import { MemoryLedger, type BatchRecord } from "./ledger";
import {
  FakeClient,
  answerReviewOrSummary,
  fakeMessage,
  structuredKind,
  textBlock,
  tool,
  toolUseBlock,
  writeFixtureData
} from "./testing";

/** The failure paths an unattended, money-spending runner has to survive. */

let root: string;
const hour = 60 * 60 * 1000;
const start = new Date("2026-10-16T00:40:00Z");
const at = (hours: number) => new Date(start.getTime() + hours * hour);

async function load() {
  vi.resetModules();
  process.env.DIRECTORY_DATA_ROOT = root;
  return import("./runner");
}

const SCENARIOS = [
  ...Array.from({ length: 5 }, (_, i) => ({ prompt: `Hotels in City ${i}`, expected_tool: "search_hotels", expected_args: [] })),
  ...Array.from({ length: 5 }, (_, i) => ({ prompt: `Show hotel H-${i}`, expected_tool: "get_hotel", expected_args: [] })),
  { prompt: "Book me a flight", expected_tool: null, expected_args: [] },
  { prompt: "What's the weather?", expected_tool: null, expected_args: [] },
  { prompt: "Rent a car", expected_tool: null, expected_args: [] }
];

function scripted(client: FakeClient): FakeClient {
  client.respond = (params) => {
    const other = answerReviewOrSummary(params);
    if (other) return other;
    if (structuredKind(params) === "scenarios") {
      return fakeMessage([textBlock(JSON.stringify({ scenarios: SCENARIOS }))], "end_turn");
    }
    const prompt = String(params.messages[0]?.content);
    if (prompt.startsWith("Hotels in")) return fakeMessage([toolUseBlock("search_hotels", {})], "tool_use");
    if (prompt.startsWith("Show hotel")) return fakeMessage([toolUseBlock("get_hotel", {})], "tool_use");
    return fakeMessage([textBlock("Not here.")], "end_turn");
  };
  return client;
}

const tools = [
  tool("search_hotels", "Search hotels by city.", { city: { type: "string" } }),
  tool("get_hotel", "Get one hotel by id.", { hotelId: { type: "string" } })
];

async function runAt(hours: number, client: FakeClient, ledger: MemoryLedger, only?: Set<string>) {
  return (await load()).runEvals({ client, ledger, now: at(hours), only, log: () => {} });
}

describe("recovery", () => {
  beforeEach(() => {
    root = writeFixtureData([{ slug: "alpha", tier: "claimed", tools }]);
  });

  it("does not buy a batch twice when the run dies right after the API accepts it, and bills it anyway", async () => {
    const client = scripted(new FakeClient());
    class FlakyLedger extends MemoryLedger {
      failNextSaveBatch = true;
      override async saveBatch(batch: BatchRecord): Promise<void> {
        if (this.failNextSaveBatch) {
          this.failNextSaveBatch = false;
          throw new Error("connection reset");
        }
        return super.saveBatch(batch);
      }
    }
    const ledger = new FlakyLedger();

    // Each run loads fresh modules, so the error is matched by name, with its partial report.
    await expect(runAt(0, client, ledger)).rejects.toMatchObject({
      name: "RunFailed",
      message: "connection reset",
      report: { jobs: [] }
    });
    expect(client.batches.size).toBe(1);
    expect([...ledger.jobRecords.values()].every((j) => j.status === "submitted" && j.batchId === null)).toBe(true);

    // An hour later the jobs are still in flight: nothing is bought again.
    const soon = await runAt(1, client, ledger);
    expect(soon.jobs.every((j) => j.outcome === "in-flight")).toBe(true);
    expect(client.batches.size).toBe(1);

    // Once the orphan ends, its cost reaches the ledger, and the stale jobs get their retry.
    client.endBatches();
    const later = await runAt(3, client, ledger);
    expect(later.batches[0]).toMatchObject({ id: "msgbatch_001", outcome: "reconciled", requests: 3 });
    expect(ledger.usage.filter((row) => row.job === "orphan")).toHaveLength(3);
    expect(later.batches[1]).toMatchObject({ outcome: "submitted", requests: 3 });
  });

  it("releases an interrupted standard job after a while instead of leaving it in flight forever", async () => {
    root = writeFixtureData([{ slug: "alpha", tier: "showcase", tools }]);
    const ledger = new MemoryLedger();
    const key = "scenarios|alpha|sha256:alpha-v1|claude-haiku-5-5|p1";
    await ledger.saveJob({
      key,
      job: "scenarios",
      serverId: "alpha",
      model: "claude-haiku-5-5",
      status: "submitted",
      mode: "standard",
      batchId: null,
      attempts: 1,
      lastError: null,
      result: null,
      createdAt: at(0),
      updatedAt: at(0),
      completedAt: null
    });
    const blocked = await runAt(1, scripted(new FakeClient()), ledger);
    expect(blocked.jobs.find((j) => j.job === "scenarios")).toMatchObject({ outcome: "in-flight" });

    const released = await runAt(3, scripted(new FakeClient()), ledger);
    expect(released.jobs.find((j) => j.job === "scenarios")).toMatchObject({ outcome: "done" });
    expect(ledger.jobRecords.get(key)).toMatchObject({ status: "done", attempts: 2 });
  });

  it("abandons a batch that cannot be read after three days, releasing its reservation and its jobs", async () => {
    const client = scripted(new FakeClient());
    const ledger = new MemoryLedger();
    await runAt(0, client, ledger);
    client.batches.clear(); // The API no longer knows it (another workspace, or past retention).

    const early = await runAt(24, client, ledger);
    expect(early.batches[0]).toMatchObject({ outcome: "failed" });
    expect(early.budget?.pendingUsd).toBeGreaterThan(0);

    const late = await runAt(80, client, ledger);
    expect(late.batches[0]).toMatchObject({ id: "msgbatch_001", outcome: "abandoned" });
    // Released with their retry intact, and queued again in the same run.
    expect(late.batches[1]).toMatchObject({ outcome: "submitted" });
    expect(late.jobs.filter((j) => j.outcome === "submitted")).toHaveLength(3);
  });

  it("does not let last cycle's billing errors freeze the new cycle, and keeps the jobs' retry", async () => {
    const client = scripted(new FakeClient());
    const ledger = new MemoryLedger();
    const cycleEnd = new Date("2026-10-31T18:40:00Z");
    await (await load()).runEvals({ client, ledger, now: cycleEnd, log: () => {} });
    for (const id of ["r00000", "r00001", "r00002"]) client.billingErrors.add(id);
    client.endBatches();

    const report = await (await load()).runEvals({ client, ledger, now: new Date("2026-11-01T00:40:00Z"), log: () => {} });
    expect(report.exhausted).toBe(false);
    expect(await ledger.hasEvent("credit-exhausted:2026-11-01")).toBe(false);
    expect(report.jobs.filter((j) => j.outcome === "failed").map((j) => j.detail)).toEqual(Array(3).fill("credit exhausted"));
    expect([...ledger.jobRecords.values()].every((j) => j.attempts <= 1)).toBe(true);
  });

  it("restores a lost scenario set from the ledger instead of discarding the paid selection answers", async () => {
    const client = scripted(new FakeClient());
    const ledger = new MemoryLedger();
    await runAt(0, client, ledger);
    client.endBatches();
    await runAt(6, client, ledger); // collects scenarios, submits selection
    rmSync(path.join(root, "evals/alpha/scenarios.json")); // that run's commit never landed

    client.endBatches();
    const report = await runAt(12, client, ledger);
    expect(report.jobs).toContainEqual(expect.objectContaining({ job: "selection", model: SONNET, outcome: "done" }));
    expect(JSON.parse(readFileSync(path.join(root, "evals/alpha/scenarios.json"), "utf8"))).toMatchObject({ version: 1 });
    expect(report.batches.filter((b) => b.outcome === "submitted")).toEqual([]);
  });

  it("still bills a batch whose job key no longer parses, at the dearest price, and settles the job", async () => {
    const client = scripted(new FakeClient());
    const ledger = new MemoryLedger();
    await runAt(0, client, ledger);
    // Pretend a model was retired while the batch ran.
    const batch = (await ledger.openBatches())[0]!;
    const retired = "review|alpha|sha256:alpha-v1|claude-retired-1|p1";
    const original = Object.values(batch.requests).find((meta) => meta.jobKey.startsWith("review|"))!.jobKey;
    for (const meta of Object.values(batch.requests)) if (meta.jobKey === original) meta.jobKey = retired;
    await ledger.saveBatch(batch);
    await ledger.saveJob({ ...ledger.jobRecords.get(original)!, key: retired, model: "claude-retired-1" });
    // The API answers in the name of the model that was asked for.
    for (const request of client.batches.get(batch.id)!.requests) {
      if (batch.requests[request.custom_id]?.jobKey === retired) request.params.model = "claude-retired-1";
    }

    client.endBatches();
    const report = await runAt(6, client, ledger);
    const row = ledger.usage.find((r) => r.jobKey === retired);
    // Default fake usage is 1,000 in and 50 out; billed on Opus's batch card.
    expect(row).toMatchObject({ job: "review", serverId: "alpha", model: OPUS, usd: (1_000 * 2 + 50 * 10) / 1_000_000 });
    expect(ledger.jobRecords.get(retired)).toMatchObject({ status: "failed" });
    expect(report.jobs).toContainEqual(expect.objectContaining({ outcome: "failed", detail: expect.stringContaining("no longer understood") }));
  });

  it("keeps a finished run when its regression alert cannot be recorded", async () => {
    root = writeFixtureData([{ slug: "alpha", tier: "showcase", tools }]);
    class NoEvents extends MemoryLedger {
      override async claimEvent(key: string, kind: string, detail?: unknown): Promise<boolean> {
        if (key.startsWith("regression:")) throw new Error("events table locked");
        return super.claimEvent(key, kind, detail);
      }
    }
    const ledger = new NoEvents();
    const client = scripted(new FakeClient());
    await runAt(0, client, ledger);
    // A worse second surface would raise an alert; recording it fails.
    const snapshot = path.join(root, "results/alpha/snapshot.json");
    const moved = JSON.parse(readFileSync(snapshot, "utf8"));
    moved.snapshot_hash = "sha256:alpha-v2";
    (await import("node:fs")).writeFileSync(snapshot, JSON.stringify(moved));
    client.respond = ((respond) => (params: Parameters<typeof respond>[0]) =>
      String(params.messages[0]?.content).startsWith("Show hotel") && !params.output_config
        ? fakeMessage([toolUseBlock("search_hotels", {})], "tool_use")
        : respond(params))(client.respond!);

    const report = await runAt(48, client, ledger);
    const selection = report.jobs.filter((j) => j.job === "selection");
    expect(selection.map((j) => j.outcome)).toEqual(["done", "done", "done"]);
    expect([...ledger.jobRecords.values()].filter((j) => j.job === "selection" && j.status === "done")).toHaveLength(6);
  });
});

describe("the end-of-cycle Opus pass", () => {
  beforeEach(() => {
    root = writeFixtureData(["one", "two"].map((slug) => ({ slug, tier: "claimed" as const, tools })));
  });

  async function ready(ledger: MemoryLedger, client: FakeClient) {
    // Scenarios and the regular Sonnet run, so the pass has sets to work on.
    await (await load()).runEvals({ client, ledger, now: new Date("2026-10-20T00:00:00Z"), log: () => {} });
    client.endBatches();
    await (await load()).runEvals({ client, ledger, now: new Date("2026-10-20T06:00:00Z"), log: () => {} });
    client.endBatches();
    await (await load()).runEvals({ client, ledger, now: new Date("2026-10-20T12:00:00Z"), log: () => {} });
  }

  it("is not spent by a run limited to one server", async () => {
    const client = scripted(new FakeClient());
    const ledger = new MemoryLedger();
    await ready(ledger, client);
    const single = await (await load()).runEvals({ client, ledger, now: new Date("2026-10-26T00:00:00Z"), only: new Set(["one"]), log: () => {} });
    expect(single.jobs.some((j) => j.model === OPUS)).toBe(false);

    const full = await (await load()).runEvals({ client, ledger, now: new Date("2026-10-26T06:00:00Z"), log: () => {} });
    expect(full.jobs.filter((j) => j.model === OPUS).map((j) => j.outcome)).toEqual(["submitted", "submitted"]);
    expect(await ledger.hasEvent("use-it:2026-10-01")).toBe(true);
  });

  it("is not spent when its batch could not be submitted", async () => {
    const client = scripted(new FakeClient());
    const ledger = new MemoryLedger();
    await ready(ledger, client);
    client.batchError = new Error("socket hang up");
    await (await load()).runEvals({ client, ledger, now: new Date("2026-10-26T00:00:00Z"), log: () => {} });
    expect(await ledger.hasEvent("use-it:2026-10-01")).toBe(false);

    client.batchError = undefined;
    const retry = await (await load()).runEvals({ client, ledger, now: new Date("2026-10-26T06:00:00Z"), log: () => {} });
    expect(retry.jobs.filter((j) => j.model === OPUS).map((j) => j.outcome)).toEqual(["submitted", "submitted"]);
  });
});
