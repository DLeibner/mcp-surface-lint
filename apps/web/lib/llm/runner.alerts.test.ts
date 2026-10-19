import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Alert } from "./alerts";
import { HAIKU, OPUS, SONNET } from "./config";
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
const day = 24 * 60 * 60 * 1000;

async function load() {
  vi.resetModules();
  process.env.DIRECTORY_DATA_ROOT = root;
  return import("./runner");
}

const tools = [
  tool("search_hotels", "Search hotels by city.", { city: { type: "string" } }),
  tool("get_hotel", "Get one hotel by id.", { hotelId: { type: "string" } })
];

const SCENARIOS = [
  ...Array.from({ length: 5 }, (_, i) => ({ prompt: `Hotels in City ${i}`, expected_tool: "search_hotels", expected_args: [] })),
  ...Array.from({ length: 5 }, (_, i) => ({ prompt: `Show hotel H-${i}`, expected_tool: "get_hotel", expected_args: [] })),
  { prompt: "Book me a flight", expected_tool: null, expected_args: [] },
  { prompt: "What's the weather?", expected_tool: null, expected_args: [] },
  { prompt: "Rent a car", expected_tool: null, expected_args: [] }
];

/** A model that searches whenever the prompt is in `mistakes`, and is otherwise right. */
function scripted(client: FakeClient, mistakes: Set<string>): FakeClient {
  client.respond = (params) => {
    const other = answerReviewOrSummary(params);
    if (other) return other;
    if (structuredKind(params) === "scenarios") {
      return fakeMessage([textBlock(JSON.stringify({ scenarios: SCENARIOS }))], "end_turn");
    }
    const prompt = String(params.messages[0]?.content);
    if (mistakes.has(prompt) || prompt.startsWith("Hotels in")) return fakeMessage([toolUseBlock("search_hotels", {})], "tool_use");
    if (prompt.startsWith("Show hotel")) return fakeMessage([toolUseBlock("get_hotel", {})], "tool_use");
    return fakeMessage([textBlock("Not here.")], "end_turn");
  };
  return client;
}

function moveSurface(slug: string, hash: string): void {
  const file = path.join(root, "results", slug, "snapshot.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), snapshot_hash: hash }));
}

describe("alerts", () => {
  beforeEach(() => {
    root = writeFixtureData([{ slug: "alpha", tier: "showcase", tools }]);
  });

  it("emails once when a model's accuracy drops ten points or more", async () => {
    const sent: Alert[] = [];
    const notify = async (alert: Alert) => void sent.push(alert);
    const ledger = new MemoryLedger();
    const mistakes = new Set<string>();
    const now = new Date("2026-10-10T12:00:00Z");

    await (await load()).runEvals({ client: scripted(new FakeClient(), mistakes), ledger, now, notify, log: () => {} });
    expect(sent).toEqual([]);

    // A new surface on which every model gets two of ten hotel lookups wrong.
    moveSurface("alpha", "sha256:alpha-v2");
    mistakes.add("Show hotel H-1").add("Show hotel H-2");
    const later = new Date(now.getTime() + 2 * day);
    const report = await (await load()).runEvals({ client: scripted(new FakeClient(), mistakes), ledger, now: later, notify, log: () => {} });

    expect(report.alerts.map((a) => a.kind)).toEqual(["regression", "regression", "regression"]);
    expect(sent.map((a) => a.subject)).toEqual([
      "alpha: Claude Haiku 5.5 picked the right tool 20 points less often",
      "alpha: Claude Sonnet 5.5 picked the right tool 20 points less often",
      "alpha: Claude Opus 5.5 picked the right tool 20 points less often"
    ]);
    expect(sent[0]?.body).toContain("from 100% (2026-10-10, scenario set v1) to 80% (2026-10-12, scenario set v2)");
    expect(sent[0]?.body).toContain("get_hotel → search_hotels");

    // Nothing new to measure, nothing new to say.
    await (await load()).runEvals({ client: scripted(new FakeClient(), mistakes), ledger, now: later, notify, log: () => {} });
    expect(sent).toHaveLength(3);
  });

  it("emails once per cycle at the hard stop", async () => {
    const sent: Alert[] = [];
    const ledger = new MemoryLedger();
    await ledger.recordUsage({
      job: "selection",
      serverId: "elsewhere",
      model: SONNET,
      usage: { inputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      usd: 95.2,
      batch: false,
      at: new Date("2026-10-05T00:00:00Z")
    });
    const options = {
      ledger,
      notify: async (alert: Alert) => void sent.push(alert),
      log: () => {}
    };
    await (await load()).runEvals({ ...options, client: scripted(new FakeClient(), new Set()), now: new Date("2026-10-10T00:00:00Z") });
    await (await load()).runEvals({ ...options, client: scripted(new FakeClient(), new Set()), now: new Date("2026-10-11T00:00:00Z") });
    expect(sent.map((a) => a.kind)).toEqual(["hard-stop"]);
    expect(sent[0]?.body).toContain("Spent $95.20");
  });

  it("emails once when the credit runs out", async () => {
    const sent: Alert[] = [];
    const client = scripted(new FakeClient(), new Set());
    client.respond = () => {
      throw new Anthropic.BadRequestError(400, undefined, "Your credit balance is too low to access the Anthropic API.", new Headers());
    };
    const ledger = new MemoryLedger();
    const notify = async (alert: Alert) => void sent.push(alert);
    const now = new Date("2026-10-10T00:00:00Z");
    await (await load()).runEvals({ client, ledger, now, notify, log: () => {} });
    await (await load()).runEvals({ client, ledger, now, notify, log: () => {} });
    expect(sent.map((a) => a.kind)).toEqual(["credit-exhausted"]);
  });
});

describe("use it or lose it", () => {
  const SLUGS = ["one", "two", "three"];

  beforeEach(() => {
    root = writeFixtureData(SLUGS.map((slug) => ({ slug, tier: "directory" as const, tools })));
    // Each server already has a scenario set and a Sonnet run for its surface.
    for (const slug of SLUGS) {
      const dir = path.join(root, "evals", slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "scenarios.json"),
        JSON.stringify({
          slug,
          version: 1,
          tools_hash: `sha256:${slug}-v1`,
          generated_at: "2026-10-01T00:00:00.000Z",
          model: HAIKU,
          prompt_version: 1,
          sampled: null,
          scenarios: SCENARIOS.map((s, i) => ({
            id: `s${String(i + 1).padStart(2, "0")}`,
            prompt: s.prompt,
            expected_tool: s.expected_tool,
            expected_args: {}
          }))
        })
      );
    }
  });

  async function runOn(date: string, ledger: MemoryLedger, client = scripted(new FakeClient(), new Set())) {
    return (await load()).runEvals({ client, ledger, now: new Date(date), log: () => {} });
  }

  it("spends the slack on an Opus batch over the scorecards, once per cycle", async () => {
    const ledger = new MemoryLedger();
    const report = await runOn("2026-10-25T06:00:00Z", ledger);
    const opus = report.jobs.filter((j) => j.model === OPUS);
    expect(opus.map((j) => [j.slug, j.outcome])).toEqual([
      ["one", "submitted"],
      ["three", "submitted"],
      ["two", "submitted"]
    ]);
    expect(await ledger.hasEvent("use-it:2026-10-01")).toBe(true);

    const again = await runOn("2026-10-25T12:00:00Z", ledger);
    expect(again.jobs.filter((j) => j.model === OPUS).map((j) => j.outcome)).toEqual([]);
  });

  it("waits for the cycle's last days, and skips a cycle that is spending anyway", async () => {
    expect((await runOn("2026-10-24T06:00:00Z", new MemoryLedger())).jobs.some((j) => j.model === OPUS)).toBe(false);

    const busy = new MemoryLedger();
    await busy.recordUsage({
      job: "selection",
      serverId: "elsewhere",
      model: SONNET,
      usage: { inputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      usd: 61,
      batch: false,
      at: new Date("2026-10-05T00:00:00Z")
    });
    expect((await runOn("2026-10-26T06:00:00Z", busy)).jobs.some((j) => j.model === OPUS)).toBe(false);
  });
});
