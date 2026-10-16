import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HAIKU, OPUS, SONNET } from "./config";
import { MemoryLedger } from "./ledger";
import { FakeClient, tool, writeFixtureData } from "./testing";

let root: string;

async function load() {
  vi.resetModules();
  process.env.DIRECTORY_DATA_ROOT = root;
  return import("./runner");
}

function footprintFile(slug: string): string {
  return path.join(root, "evals", slug, "footprint.json");
}

const now = new Date("2026-10-16T12:00:00Z");

describe("footprints", () => {
  beforeEach(() => {
    root = writeFixtureData([
      { slug: "alpha", tools: [tool("a_one", "One."), tool("a_two", "Two.")] },
      { slug: "beta", tools: [tool("b_one", "One.")], tier: "showcase" }
    ]);
  });

  it("counts every model once per surface, net of the tool-less baseline", async () => {
    const { runEvals } = await load();
    const client = new FakeClient();
    const report = await runEvals({ client, ledger: new MemoryLedger(), now, log: () => {} });

    expect(report.footprints.map((f) => [f.slug, f.outcome])).toEqual([
      ["alpha", "counted"],
      ["beta", "counted"]
    ]);
    const alpha = JSON.parse(readFileSync(footprintFile("alpha"), "utf8"));
    expect(alpha).toMatchObject({
      slug: "alpha",
      tools_hash: "sha256:alpha-v1",
      counted_at: now.toISOString(),
      models: { [HAIKU]: 200, [SONNET]: 200, [OPUS]: 260 },
      error: null
    });
    // One baseline per model, shared by both servers.
    expect(client.counts.filter((c) => !c.tools)).toHaveLength(3);
    expect(report.written).toEqual(["data/evals/alpha/footprint.json", "data/evals/beta/footprint.json"]);
  });

  it("leaves a current count alone and recounts a changed surface", async () => {
    let { runEvals } = await load();
    await runEvals({ client: new FakeClient(), ledger: new MemoryLedger(), now, log: () => {} });

    const snapshot = path.join(root, "results/alpha/snapshot.json");
    const changed = JSON.parse(readFileSync(snapshot, "utf8"));
    changed.snapshot_hash = "sha256:alpha-v2";
    changed.tools.push(tool("a_three", "Three."));
    writeFileSync(snapshot, JSON.stringify(changed));

    ({ runEvals } = await load());
    const report = await runEvals({ client: new FakeClient(), ledger: new MemoryLedger(), now, log: () => {} });
    expect(report.footprints.map((f) => [f.slug, f.outcome])).toEqual([
      ["alpha", "counted"],
      ["beta", "current"]
    ]);
    expect(JSON.parse(readFileSync(footprintFile("alpha"), "utf8")).models[SONNET]).toBe(300);
  });

  it("plans without counting in a dry run", async () => {
    const { runEvals } = await load();
    const report = await runEvals({ ledger: new MemoryLedger(), now, log: () => {} });
    expect(report.footprints.every((f) => f.outcome === "planned")).toBe(true);
    expect(existsSync(footprintFile("alpha"))).toBe(false);
  });

  it("records a surface the API rejects, and retries a transient failure next time", async () => {
    const { runEvals } = await load();
    const rejecting = new FakeClient();
    rejecting.countError = new Anthropic.BadRequestError(
      400,
      { type: "error", error: { type: "invalid_request_error", message: "tools.0.input_schema: invalid" } },
      "tools.0.input_schema: invalid",
      new Headers()
    );
    const report = await runEvals({ client: rejecting, ledger: new MemoryLedger(), now, log: () => {} });
    expect(report.footprints[0]?.outcome).toBe("rejected");
    expect(JSON.parse(readFileSync(footprintFile("alpha"), "utf8")).error).toContain("input_schema");

    const flaky = new FakeClient();
    flaky.countError = new Anthropic.InternalServerError(500, undefined, "overloaded", new Headers());
    root = writeFixtureData([{ slug: "gamma", tools: [tool("g", "G.")] }]);
    const { runEvals: again } = await load();
    const retry = await again({ client: flaky, ledger: new MemoryLedger(), now, log: () => {} });
    expect(retry.footprints[0]?.outcome).toBe("failed");
    expect(existsSync(footprintFile("gamma"))).toBe(false);
  });

  it("stops counting once the credit is reported gone, and remembers it for the cycle", async () => {
    const { runEvals } = await load();
    const broke = new FakeClient();
    broke.countError = new Anthropic.BadRequestError(
      400,
      undefined,
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      new Headers()
    );
    const ledger = new MemoryLedger();
    const report = await runEvals({ client: broke, ledger, now, log: () => {} });
    expect(report.exhausted).toBe(true);
    expect(report.footprints.map((f) => f.outcome)).toEqual(["planned", "planned"]);
    expect(await ledger.hasEvent("credit-exhausted:2026-10-01")).toBe(true);
  });
});
