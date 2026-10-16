import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HAIKU, OPUS, SONNET } from "@/lib/llm/config";
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
