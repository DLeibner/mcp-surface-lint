import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HAIKU } from "./config";
import { MemoryLedger } from "./ledger";
import { FakeClient, fakeMessage, textBlock, tool, toolUseBlock, writeFixtureData } from "./testing";

let root: string;
const day = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-16T12:00:00Z");

async function load() {
  vi.resetModules();
  process.env.DIRECTORY_DATA_ROOT = root;
  return import("./runner");
}

function evalFile(file: string): unknown {
  return JSON.parse(readFileSync(path.join(root, "evals/alpha", file), "utf8"));
}

const SCENARIOS = [
  ...Array.from({ length: 5 }, (_, i) => ({
    prompt: `Hotels in City ${i}`,
    expected_tool: "search_hotels",
    expected_args: [{ name: "city", value_json: JSON.stringify(`City ${i}`) }]
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    prompt: `Show hotel H-${i}`,
    expected_tool: "get_hotel",
    expected_args: [{ name: "hotelId", value_json: JSON.stringify(`H-${i}`) }]
  })),
  { prompt: "Book me a flight", expected_tool: null, expected_args: [] },
  { prompt: "What's the weather?", expected_tool: null, expected_args: [] },
  { prompt: "Rent a car", expected_tool: null, expected_args: [] }
];

/**
 * A model that gets everything right except one hotel lookup (it searches
 * instead) and one distractor (it searches for a flight).
 */
function scripted(client: FakeClient): FakeClient {
  client.respond = (params) => {
    if (params.output_config?.format) {
      return fakeMessage([textBlock(JSON.stringify({ scenarios: SCENARIOS }))], "end_turn", { input: 2_000, output: 900 });
    }
    const prompt = String(params.messages[0]?.content);
    if (prompt === "Show hotel H-0" || prompt === "Book me a flight") {
      return fakeMessage([toolUseBlock("search_hotels", { city: "?" })], "tool_use");
    }
    const city = /^Hotels in (.+)$/.exec(prompt);
    if (city) return fakeMessage([toolUseBlock("search_hotels", { city: city[1] })], "tool_use");
    const hotel = /^Show hotel (.+)$/.exec(prompt);
    if (hotel) return fakeMessage([toolUseBlock("get_hotel", { hotelId: hotel[1] })], "tool_use");
    return fakeMessage([textBlock("I can't help with that here.")], "end_turn");
  };
  return client;
}

const tools = [
  tool("search_hotels", "Search hotels by city.", { city: { type: "string" } }),
  tool("get_hotel", "Get one hotel by id.", { hotelId: { type: "string" } })
];

describe("scenarios and selection on the standard API", () => {
  beforeEach(() => {
    root = writeFixtureData([
      { slug: "alpha", tier: "showcase", tools },
      { slug: "beta", tier: "directory", tools }
    ]);
  });

  it("generates scenarios, measures selection, and prices every call", async () => {
    const { runEvals } = await load();
    const client = scripted(new FakeClient());
    const ledger = new MemoryLedger();
    const report = await runEvals({ client, ledger, now, log: () => {} });

    expect(report.jobs.map((j) => [j.slug, j.job, j.model, j.outcome])).toEqual([
      ["alpha", "scenarios", HAIKU, "done"],
      ["alpha", "selection", HAIKU, "done"],
      // The directory server's scenarios can wait for a batch.
      ["beta", "scenarios", HAIKU, "submitted"]
    ]);
    expect(evalFile("scenarios.json")).toMatchObject({ version: 1, tools_hash: "sha256:alpha-v1", sampled: null });

    const selection = evalFile("selection.json") as { runs: { metrics: Record<string, unknown>; confused_pairs: unknown }[] };
    expect(selection.runs).toHaveLength(1);
    expect(selection.runs[0]?.metrics).toMatchObject({
      scenarios: 13,
      graded: 13,
      selection_accuracy: 0.9,
      distractor_false_positive_rate: 0.333,
      no_call_rate: 0,
      argument_validity: 1,
      expected_args_match: 1
    });
    expect(selection.runs[0]?.confused_pairs).toEqual([{ expected: "get_hotel", actual: "search_hotels", count: 1 }]);

    // One J1 call and thirteen J2 calls on the standard API, each in the ledger at Haiku's price.
    expect(ledger.usage.map((row) => row.job)).toEqual(["scenarios", ...Array(13).fill("selection")]);
    expect(ledger.usage[0]?.usd).toBe((2_000 * 0.1 + 900 * 0.5) / 1_000_000);
    expect(ledger.usage[1]?.usd).toBe((1_000 * 0.1 + 50 * 0.5) / 1_000_000);
    // The directory tier gets no Haiku runs.
    expect(existsSync(path.join(root, "evals/beta/selection.json"))).toBe(false);
  });

  it("never pays twice: a second run calls nothing, and a lost file is restored from the ledger", async () => {
    let { runEvals } = await load();
    const ledger = new MemoryLedger();
    await runEvals({ client: scripted(new FakeClient()), ledger, now, log: () => {} });

    const again = scripted(new FakeClient());
    ({ runEvals } = await load());
    const second = await runEvals({ client: again, ledger, now, log: () => {} });
    expect(again.messages).toHaveLength(0);
    expect(second.jobs.filter((j) => j.slug === "alpha").map((j) => j.outcome)).toEqual(["current"]);

    rmSync(path.join(root, "evals/alpha/selection.json"));
    ({ runEvals } = await load());
    const third = await runEvals({ client: again, ledger, now, log: () => {} });
    expect(again.messages).toHaveLength(0);
    expect(third.jobs.find((j) => j.slug === "alpha")).toMatchObject({
      outcome: "current",
      detail: "restored from the ledger"
    });
    expect(evalFile("selection.json")).toMatchObject({ runs: [{ metrics: { selection_accuracy: 0.9 } }] });
  });

  it("defers paid jobs when the budget gate says no", async () => {
    const { runEvals } = await load();
    const ledger = new MemoryLedger();
    await ledger.recordUsage({
      job: "selection",
      serverId: "other",
      model: HAIKU,
      usage: { inputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      usd: 95.5,
      batch: false,
      at: new Date("2026-10-10T00:00:00Z")
    });
    const client = scripted(new FakeClient());
    const report = await runEvals({ client, ledger, now, log: () => {} });
    expect(report.jobs[0]).toMatchObject({ job: "scenarios", outcome: "deferred" });
    expect(client.messages).toHaveLength(0);
  });

  it("stops when the credit runs out, without burning the job's retry", async () => {
    const { runEvals } = await load();
    const client = scripted(new FakeClient());
    const respond = client.respond!;
    let calls = 0;
    client.respond = (params) => {
      if (++calls === 4) {
        throw new Anthropic.BadRequestError(400, undefined, "Your credit balance is too low to access the Anthropic API.", new Headers());
      }
      return respond(params);
    };
    const ledger = new MemoryLedger();
    const report = await runEvals({ client, ledger, now, log: () => {} });

    expect(report.exhausted).toBe(true);
    expect(await ledger.hasEvent("credit-exhausted:2026-10-01")).toBe(true);
    expect(existsSync(path.join(root, "evals/alpha/selection.json"))).toBe(false);
    const job = [...ledger.jobRecords.values()].find((j) => j.job === "selection");
    expect(job).toMatchObject({ status: "failed", attempts: 0, lastError: "credit exhausted" });
    // Calls already in flight finish and are billed; nothing new starts afterwards.
    expect(client.messages.length).toBeLessThanOrEqual(2 + 4);
    expect(ledger.usage).toHaveLength(client.messages.length - 1);
  });

  it("measures a changed surface no more often than the tier's cadence allows", async () => {
    let { runEvals } = await load();
    const ledger = new MemoryLedger();
    await runEvals({ client: scripted(new FakeClient()), ledger, now, log: () => {} });

    const snapshot = path.join(root, "results/alpha/snapshot.json");
    const changed = JSON.parse(readFileSync(snapshot, "utf8"));
    changed.snapshot_hash = "sha256:alpha-v2";
    writeFileSync(snapshot, JSON.stringify(changed));

    ({ runEvals } = await load());
    const soon = await runEvals({ client: scripted(new FakeClient()), ledger, now: new Date(now.getTime() + day / 2), log: () => {} });
    const alphaJobs = (report: { jobs: { slug: string; job: string; outcome: string }[] }) =>
      report.jobs.filter((j) => j.slug === "alpha").map((j) => [j.job, j.outcome]);
    expect(alphaJobs(soon)).toEqual([
      ["scenarios", "done"],
      ["selection", "throttled"]
    ]);
    expect(evalFile("scenarios.json")).toMatchObject({ version: 2, tools_hash: "sha256:alpha-v2" });

    ({ runEvals } = await load());
    const later = await runEvals({ client: scripted(new FakeClient()), ledger, now: new Date(now.getTime() + 2 * day), log: () => {} });
    expect(alphaJobs(later)).toEqual([["selection", "done"]]);
    expect((evalFile("selection.json") as { runs: unknown[] }).runs).toHaveLength(2);
  });
});
