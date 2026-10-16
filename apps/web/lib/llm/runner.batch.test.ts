import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HAIKU, SONNET } from "./config";
import { MemoryLedger } from "./ledger";
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

let root: string;
const hour = 60 * 60 * 1000;
const start = new Date("2026-10-16T00:40:00Z");
const at = (hours: number) => new Date(start.getTime() + hours * hour);

const SLUGS = Array.from({ length: 10 }, (_, i) => `server-${i}`);

async function load() {
  vi.resetModules();
  process.env.DIRECTORY_DATA_ROOT = root;
  return import("./runner");
}

function evalFile(slug: string, file: string): any {
  return JSON.parse(readFileSync(path.join(root, "evals", slug, file), "utf8"));
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
      return fakeMessage([textBlock(JSON.stringify({ scenarios: SCENARIOS }))], "end_turn", { input: 2_000, output: 900 });
    }
    const prompt = String(params.messages[0]?.content);
    if (prompt === "Show hotel H-0") return fakeMessage([toolUseBlock("search_hotels", {})], "tool_use");
    if (prompt.startsWith("Hotels in")) return fakeMessage([toolUseBlock("search_hotels", {})], "tool_use");
    if (prompt.startsWith("Show hotel")) return fakeMessage([toolUseBlock("get_hotel", {})], "tool_use");
    return fakeMessage([textBlock("Not something I can do here.")], "end_turn");
  };
  return client;
}

const tools = [
  tool("search_hotels", "Search hotels by city.", { city: { type: "string" } }),
  tool("get_hotel", "Get one hotel by id.", { hotelId: { type: "string" } })
];

describe("the batch path", () => {
  beforeEach(() => {
    root = writeFixtureData(SLUGS.map((slug) => ({ slug, tier: "claimed" as const, tools })));
  });

  it("runs a weekly Sonnet batch end to end for ten servers", async () => {
    const client = scripted(new FakeClient());
    const ledger = new MemoryLedger();
    const run = async (hours: number) => (await load()).runEvals({ client, ledger, now: at(hours), log: () => {} });

    // Run 1: scenarios, review and summary for all ten servers go out as one
    // batch, reserved against the budget.
    const first = await run(0);
    expect(first.batches).toEqual([{ id: "msgbatch_001", outcome: "submitted", requests: 30, usd: expect.any(Number) }]);
    expect(first.jobs.filter((j) => j.outcome === "submitted")).toHaveLength(30);
    expect(first.budget?.pendingUsd).toBeGreaterThan(0);
    expect(ledger.usage).toHaveLength(0);

    // Run 2: the batch is still processing; nothing is resubmitted.
    const second = await run(1);
    expect(second.batches).toEqual([{ id: "msgbatch_001", outcome: "in-progress", requests: 30 }]);
    expect(second.jobs.map((j) => j.outcome)).toEqual(Array(30).fill("in-flight"));
    expect(client.batches.size).toBe(1);

    // Run 3: scenarios are collected at batch prices, and selection goes out as the next batch.
    client.endBatches();
    const third = await run(6);
    expect(third.batches.map((b) => [b.id, b.outcome, b.requests])).toEqual([
      ["msgbatch_001", "collected", 30],
      ["msgbatch_002", "submitted", 130]
    ]);
    expect(ledger.usage.filter((row) => row.job === "scenarios")).toHaveLength(10);
    expect(evalFile("server-3", "review.json")).toMatchObject({ model: HAIKU, findings: [] });
    expect(evalFile("server-3", "summary.json").text).toContain("well-described");
    expect(ledger.usage[0]).toMatchObject({ batch: true, batchId: "msgbatch_001", model: HAIKU });
    expect(ledger.usage[0]?.usd).toBe((2_000 * 0.05 + 900 * 0.25) / 1_000_000);
    expect(evalFile("server-3", "scenarios.json")).toMatchObject({ version: 1, model: HAIKU });

    // Run 4: selection is collected and published for every server.
    client.endBatches();
    const fourth = await run(12);
    expect(fourth.batches).toEqual([
      { id: "msgbatch_002", outcome: "collected", requests: 130, usd: expect.any(Number) }
    ]);
    const sonnetCalls = ledger.usage.filter((row) => row.job === "selection");
    expect(sonnetCalls).toHaveLength(130);
    expect(sonnetCalls[0]).toMatchObject({ model: SONNET, batch: true });
    expect(sonnetCalls[0]?.usd).toBe((1_000 * 1 + 50 * 5) / 1_000_000);
    for (const slug of SLUGS) {
      expect(evalFile(slug, "selection.json").runs).toMatchObject([
        { model: SONNET, mode: "batch", metrics: { selection_accuracy: 0.9, distractor_false_positive_rate: 0 } }
      ]);
    }
    expect(fourth.budget?.pendingUsd).toBe(0);

    // Run 5: everything is current; nothing is bought again.
    const fifth = await run(24);
    expect(fifth.batches).toEqual([]);
    expect(fifth.jobs.every((j) => j.outcome === "current")).toBe(true);
    expect(client.batches.size).toBe(2);
  });

  it("publishes a run with a few failed requests, and retries one with too many", async () => {
    const client = scripted(new FakeClient());
    const ledger = new MemoryLedger();
    const run = async (hours: number, only = new Set(["server-0", "server-1"])) =>
      (await load()).runEvals({ client, ledger, now: at(hours), only, log: () => {} });

    await run(0);
    client.endBatches();
    await run(6);
    // server-0 owns requests r00000–r00012, server-1 r00013–r00025.
    client.erroredRequests.add("r00000");
    for (let i = 13; i < 17; i++) client.erroredRequests.add(`r000${i}`);
    client.endBatches();
    const report = await run(12);

    expect(evalFile("server-0", "selection.json").runs[0].metrics.errored).toBe(1);
    expect(report.jobs).toContainEqual(
      expect.objectContaining({ slug: "server-1", job: "selection", outcome: "failed", detail: "4 of 13 calls failed." })
    );
    // The one retry goes out in the same run that collected the failure.
    expect(report.batches.map((b) => [b.id, b.outcome, b.requests])).toEqual([
      ["msgbatch_002", "collected", 26],
      ["msgbatch_003", "submitted", 13]
    ]);

    // The retry fails too: the key is left alone from then on.
    client.erroredRequests.clear();
    for (let i = 0; i < 4; i++) client.erroredRequests.add(`r0000${i}`);
    client.endBatches();
    const retried = await run(18);
    expect(retried.jobs).toContainEqual(expect.objectContaining({ slug: "server-1", outcome: "failed" }));
    const after = await run(24);
    expect(after.jobs).toContainEqual(
      expect.objectContaining({ slug: "server-1", job: "selection", outcome: "gave-up", detail: "4 of 13 calls failed." })
    );
    expect(after.batches).toEqual([]);
  });

  it("does not publish answers for a surface that changed while the batch ran", async () => {
    const client = scripted(new FakeClient());
    const ledger = new MemoryLedger();
    const only = new Set(["server-0"]);
    await (await load()).runEvals({ client, ledger, now: at(0), only, log: () => {} });

    const snapshot = path.join(root, "results/server-0/snapshot.json");
    writeFileSync(snapshot, JSON.stringify({ ...JSON.parse(readFileSync(snapshot, "utf8")), snapshot_hash: "sha256:moved" }));
    client.endBatches();
    const report = await (await load()).runEvals({ client, ledger, now: at(6), only, log: () => {} });

    expect(report.jobs).toContainEqual(
      expect.objectContaining({ job: "scenarios", outcome: "failed", detail: "the surface changed before the batch was collected" })
    );
    // The money was still spent: scenarios, review and summary.
    expect(ledger.usage).toHaveLength(3);
  });

  it("releases the reservation when the credit is gone at submission", async () => {
    const client = scripted(new FakeClient());
    client.batchError = new Anthropic.BadRequestError(400, undefined, "Your credit balance is too low to access the Anthropic API.", new Headers());
    const ledger = new MemoryLedger();
    const report = await (await load()).runEvals({ client, ledger, now: at(0), log: () => {} });

    expect(report.exhausted).toBe(true);
    expect(report.jobs.every((j) => j.outcome === "deferred")).toBe(true);
    expect(report.budget?.pendingUsd).toBe(0);
    expect(await ledger.openBatches()).toEqual([]);
    expect(ledger.jobRecords.size).toBe(0);
  });
});
