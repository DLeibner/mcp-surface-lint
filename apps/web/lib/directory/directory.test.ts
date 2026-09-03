import { describe, expect, it } from "vitest";
import { Docs, RuleRegistry } from "mcp-surface-lint";
import sitemap from "@/app/sitemap";
import robots from "@/app/robots";
import { loadCatalog, relatedServers, resolveRedirect } from "./catalog";
import { indexablePages, indexableServers, serverIndexability } from "./indexing";
import { MIN_PROSE_WORDS, buildProse } from "./prose";
import { serverDescription, serverTitle } from "./seo-copy";
import { canonicalUrl } from "../seo";
import { CATEGORIES } from "./types";

const catalog = loadCatalog();

describe("seed data", () => {
  it("has unique slugs in a known category", () => {
    const slugs = catalog.entries.map((e) => e.seed.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const entry of catalog.entries) {
      expect(CATEGORIES).toContain(entry.seed.category);
    }
  });

  it("gives every remote server an endpoint and every stdio server a command", () => {
    for (const { seed } of catalog.entries) {
      if (seed.transport === "remote") expect(seed.endpoint, seed.slug).toBeTruthy();
      else expect(seed.stdio_command, seed.slug).toBeTruthy();
    }
  });

  it("never redirects a slug that is still live", () => {
    for (const { seed } of catalog.entries) {
      expect(resolveRedirect(seed.slug), seed.slug).toBeUndefined();
    }
  });
});

describe("indexation", () => {
  it("indexes a server only when it has a surface and enough prose", () => {
    for (const entry of catalog.entries) {
      const verdict = serverIndexability(entry, catalog);
      if (verdict.indexable) {
        expect(entry.scanned, entry.seed.slug).toBeDefined();
        expect(verdict.wordCount, entry.seed.slug).toBeGreaterThanOrEqual(MIN_PROSE_WORDS);
      }
    }
  });

  it("gives every indexable server at least MIN_PROSE_WORDS of generated prose", () => {
    for (const entry of indexableServers(catalog)) {
      const { wordCount } = buildProse(entry, catalog);
      expect(wordCount, entry.seed.slug).toBeGreaterThanOrEqual(MIN_PROSE_WORDS);
    }
  });

  it("keeps the sitemap identical to the indexable page set", () => {
    const expected = indexablePages(catalog).map((p) => canonicalUrl(p.path)).sort();
    const actual = sitemap().map((entry) => String(entry.url)).sort();
    expect(actual).toEqual(expected);
  });

  it("never lists a withheld server in the sitemap", () => {
    const urls = new Set(sitemap().map((entry) => String(entry.url)));
    for (const entry of catalog.entries) {
      const url = canonicalUrl(`/servers/${entry.seed.slug}`);
      expect(urls.has(url), entry.seed.slug).toBe(
        serverIndexability(entry, catalog).indexable
      );
    }
  });

  it("lists one page per rule", () => {
    const urls = new Set(sitemap().map((entry) => String(entry.url)));
    for (const rule of RuleRegistry.all()) {
      expect(urls.has(canonicalUrl(`/rules/${Docs.slug(rule.id)}`)), rule.id).toBe(true);
    }
  });

  it("emits only apex URLs", () => {
    const origin = new URL(canonicalUrl("/")).origin;
    for (const entry of sitemap()) {
      expect(String(entry.url).startsWith(origin)).toBe(true);
    }
  });
});

describe("robots.txt", () => {
  it("advertises the sitemap and blocks only the API", () => {
    const result = robots();
    const rule = Array.isArray(result.rules) ? result.rules[0]! : result.rules!;
    expect(rule.disallow).toContain("/api/");
    expect(result.sitemap).toBe(canonicalUrl("/sitemap.xml"));
  });

  it("leaves /r/ crawlable so its noindex tag can be read", () => {
    // Blocking a URL in robots.txt hides the noindex from the crawler, which
    // leaves a discovered report indexed as a bare URL forever.
    const result = robots();
    const rule = Array.isArray(result.rules) ? result.rules[0]! : result.rules!;
    const disallow = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow];
    expect(disallow).not.toContain("/r/");
  });
});

describe("titles and descriptions", () => {
  const indexable = indexableServers(catalog);

  it("keeps every server title unique", () => {
    const titles = indexable.map(serverTitle);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("keeps every server description unique and data-driven", () => {
    const descriptions = indexable.map(serverDescription);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    for (const [i, description] of descriptions.entries()) {
      expect(description, indexable[i]!.seed.slug).toMatch(/\d/);
      expect(description.length, indexable[i]!.seed.slug).toBeLessThanOrEqual(200);
    }
  });

  it("takes the longest title from the ladder that still fits 60 characters", () => {
    for (const entry of indexable) {
      const title = serverTitle(entry);
      const score = entry.scanned!.score.composite;
      const best = `${entry.seed.name} MCP Server: Tool Surface Audit (${score}/100)`;
      if (best.length <= 60) expect(title.startsWith(best), entry.seed.slug).toBe(true);
      else expect(title.length, entry.seed.slug).toBeLessThanOrEqual(60);
    }
  });
});

describe("internal linking", () => {
  it("gives every server three related servers to link to", () => {
    for (const entry of catalog.entries) {
      const related = relatedServers(catalog, entry);
      expect(related.length, entry.seed.slug).toBe(Math.min(3, catalog.entries.length - 1));
      expect(related.map((r) => r.seed.slug)).not.toContain(entry.seed.slug);
    }
  });
});

describe("prose determinism", () => {
  it("produces byte-identical prose across builds", () => {
    for (const entry of indexableServers(catalog)) {
      expect(buildProse(entry, catalog)).toEqual(buildProse(entry, catalog));
    }
  });

  it("varies wording between servers rather than reusing one template", () => {
    const openings = indexableServers(catalog).map((e) => {
      const first = buildProse(e, catalog).summary[0] ?? "";
      // Strip the numbers so only the sentence shape is compared.
      return first.replace(/[\d,]+/g, "#").slice(0, 60);
    });
    expect(new Set(openings).size).toBeGreaterThan(1);
  });
});
