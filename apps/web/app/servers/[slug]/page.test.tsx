import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HAIKU, OPUS, SONNET, type ModelId } from "@/lib/llm/config";
import { tool, writeFixtureData } from "@/lib/llm/testing";

let root: string;

function writeEval(slug: string, file: string, value: unknown): void {
  const dir = path.join(root, "evals", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), JSON.stringify(value));
}

async function render(slug: string): Promise<string> {
  vi.resetModules();
  process.env.DIRECTORY_DATA_ROOT = root;
  const { default: ServerPage } = await import("./page");
  return renderToStaticMarkup(await ServerPage({ params: Promise.resolve({ slug }) }));
}

const footprint = (toolsHash: string) => ({
  slug: "alpha",
  tools_hash: toolsHash,
  counted_at: "2026-10-16T12:00:00.000Z",
  models: { [HAIKU]: 12_345, [SONNET]: 12_346, [OPUS]: 12_901 },
  error: null
});

describe("server scorecard", () => {
  beforeEach(() => {
    root = writeFixtureData([
      {
        slug: "alpha",
        tier: "showcase",
        tools: [
          tool("search_hotels", "Search hotels by city.", { city: { type: "string" } }),
          tool("get_hotel", "Get one hotel by id.", { id: { type: "string" } })
        ]
      }
    ]);
  });

  it("shows the token footprint as each Claude model counts it", async () => {
    writeEval("alpha", "footprint.json", footprint("sha256:alpha-v1"));
    const html = await render("alpha");
    expect(html).toContain("Tokens per request, as each Claude model counts them");
    for (const count of ["12,345", "12,346", "12,901"]) expect(html).toContain(count);
    expect(html).toContain("Claude Opus 5.5");
    // Prose wording varies per server; the facts it states do not.
    expect(html).toMatch(/12,346 tokens[^<]*Claude Sonnet 5\.5/);
    expect(html).toContain("tool-use system prompt");
  });

  it("never shows a count taken from an older surface", async () => {
    writeEval("alpha", "footprint.json", footprint("sha256:alpha-v0"));
    const html = await render("alpha");
    expect(html).not.toContain("as each Claude model counts them");
    expect(html).not.toContain("12,901");
  });
});

function selectionRun(model: ModelId, overrides: Record<string, unknown> = {}) {
  return {
    key: `selection|alpha|sha256:alpha-v1|${model}|s1|p1`,
    model,
    tools_hash: "sha256:alpha-v1",
    scenario_set: 1,
    prompt_version: 1,
    mode: "standard",
    settings: { max_tokens: 200, thinking: "disabled", effort: "low" },
    completed_at: "2026-10-16T12:00:00.000Z",
    sampled: null,
    metrics: {
      scenarios: 13,
      targeted: 10,
      distractors: 3,
      graded: 13,
      selection_accuracy: 0.9,
      distractor_false_positive_rate: 0.333,
      no_call_rate: 0,
      argument_validity: 1,
      expected_args_match: 1,
      truncated: 0,
      refused: 0,
      errored: 0
    },
    confused_pairs: [{ expected: "get_hotel", actual: "search_hotels", count: 1 }],
    outcomes: [],
    usd: 0.002,
    ...overrides
  };
}

describe("tool selection on the scorecard", () => {
  it("shows a showcase server's accuracy and confused tools for every model", async () => {
    root = writeFixtureData([{ slug: "alpha", tier: "showcase", tools: [tool("search_hotels", "Search."), tool("get_hotel", "Get.")] }]);
    writeEval("alpha", "selection.json", {
      slug: "alpha",
      runs: [selectionRun(SONNET, { metrics: { ...selectionRun(SONNET).metrics, selection_accuracy: 1 }, confused_pairs: [] }), selectionRun(HAIKU)]
    });
    const html = await render("alpha");
    expect(html).toContain("How Claude uses this surface");
    expect(html).toMatch(/Claude Haiku 5\.5<\/th><td>90%<\/td><td>33%<\/td>/);
    expect(html).toMatch(/Claude Sonnet 5\.5<\/th><td>100%<\/td>/);
    expect(html).toContain("Asked for <code>get_hotel</code>, called <code>search_hotels</code>");
    expect(html).toContain("never affects the score");
  });

  it("shows only Sonnet on an unclaimed directory server", async () => {
    root = writeFixtureData([{ slug: "alpha", tier: "directory", tools: [tool("search_hotels", "Search."), tool("get_hotel", "Get.")] }]);
    writeEval("alpha", "selection.json", { slug: "alpha", runs: [selectionRun(HAIKU)] });
    expect(await render("alpha")).not.toContain("How Claude uses this surface");

    writeEval("alpha", "selection.json", { slug: "alpha", runs: [selectionRun(HAIKU), selectionRun(SONNET)] });
    const html = await render("alpha");
    expect(html).toContain("Claude Sonnet 5.5</th>");
    expect(html).not.toContain("Claude Haiku 5.5</th>");
  });

  it("files a run from an earlier surface under earlier runs", async () => {
    root = writeFixtureData([{ slug: "alpha", tier: "showcase", tools: [tool("search_hotels", "Search."), tool("get_hotel", "Get.")] }]);
    writeEval("alpha", "selection.json", {
      slug: "alpha",
      runs: [selectionRun(SONNET, { key: "old", tools_hash: "sha256:alpha-v0" })]
    });
    const html = await render("alpha");
    expect(html).toContain("This surface changed since its last selection run");
    expect(html).toContain("an earlier one");
  });
});
