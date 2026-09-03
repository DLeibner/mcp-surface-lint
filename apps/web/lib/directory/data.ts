import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import {
  redirectsSchema,
  scanResultSchema,
  seedSchema,
  type ScanResult,
  type Seed,
  type SlugRedirect
} from "./types";

/**
 * The directory's data lives outside the Next project so the scanner (which runs
 * in CI, not in the app) owns it. `process.cwd()` is the Next project root during
 * both `next build` and Vitest, so the monorepo root is two levels up.
 */
const DATA_ROOT =
  process.env.DIRECTORY_DATA_ROOT ?? path.resolve(process.cwd(), "..", "..", "data");

export function dataRoot(): string {
  return DATA_ROOT;
}

function readYaml(relative: string): unknown {
  return parse(readFileSync(path.join(DATA_ROOT, relative), "utf8"));
}

let seedCache: Seed[] | undefined;

/**
 * Parsed once per process. A malformed seed is a build failure by design: a bad
 * slug or category would otherwise ship a broken public URL.
 */
export function loadSeeds(): Seed[] {
  if (seedCache) return seedCache;
  const raw = readYaml("seeds/servers.yaml");
  if (!Array.isArray(raw)) throw new Error("data/seeds/servers.yaml must be a list of servers.");
  const seeds = raw.map((entry, i) => {
    const parsed = seedSchema.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `data/seeds/servers.yaml entry ${i} (${(entry as { slug?: string })?.slug ?? "unknown"}): ` +
          `${issue?.path.join(".")} — ${issue?.message}`
      );
    }
    return parsed.data;
  });
  const seen = new Set<string>();
  for (const seed of seeds) {
    if (seen.has(seed.slug)) throw new Error(`Duplicate slug in seeds: ${seed.slug}`);
    seen.add(seed.slug);
  }
  seedCache = seeds;
  return seeds;
}

let redirectCache: SlugRedirect[] | undefined;

export function loadRedirects(): SlugRedirect[] {
  if (redirectCache) return redirectCache;
  const parsed = redirectsSchema.parse(readYaml("redirects.yaml"));
  const slugs = new Set(loadSeeds().map((s) => s.slug));
  for (const entry of parsed.redirects) {
    if (slugs.has(entry.from)) {
      throw new Error(`redirects.yaml: "${entry.from}" is still a live slug; remove the redirect.`);
    }
    if (!slugs.has(entry.to)) {
      throw new Error(`redirects.yaml: "${entry.to}" is not a known slug.`);
    }
  }
  redirectCache = parsed.redirects;
  return redirectCache;
}

export function resultPath(slug: string, file = "latest.json"): string {
  return path.join(DATA_ROOT, "results", slug, file);
}

export function loadResult(slug: string): ScanResult | undefined {
  const file = resultPath(slug);
  if (!existsSync(file)) return undefined;
  const parsed = scanResultSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error(`data/results/${slug}/latest.json is malformed: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Dated history files, newest first. Feeds the Phase 3 timeline; unused today. */
export function listResultDates(slug: string): string[] {
  const dir = path.join(DATA_ROOT, "results", slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ""))
    .sort()
    .reverse();
}
