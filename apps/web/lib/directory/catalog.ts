import { loadRedirects, loadResult, loadSeeds } from "./data";
import {
  CATEGORIES,
  hasSurface,
  type DirectoryCategory,
  type ScanResult,
  type ScannedResult,
  type Seed
} from "./types";

export interface DirectoryEntry {
  seed: Seed;
  /** Absent until the first scan writes a result file. */
  result?: ScanResult;
  /** Present only when a scan actually produced a tool surface. */
  scanned?: ScannedResult;
}

export interface CategoryStats {
  category: DirectoryCategory;
  count: number;
  /** Medians over scanned members only; undefined when the category has none. */
  medianTokens?: number;
  medianScore?: number;
  medianToolCount?: number;
}

export interface Catalog {
  entries: DirectoryEntry[];
  byCategory: Map<DirectoryCategory, DirectoryEntry[]>;
  stats: Map<DirectoryCategory, CategoryStats>;
  /** Latest `scanned_at` across every entry, or undefined before the first scan. */
  lastScannedAt?: string;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

let cache: Catalog | undefined;

export function loadCatalog(): Catalog {
  if (cache) return cache;

  const entries: DirectoryEntry[] = loadSeeds().map((seed) => {
    const result = loadResult(seed.slug);
    return {
      seed,
      result,
      scanned: result && hasSurface(result) ? result : undefined
    };
  });

  const byCategory = new Map<DirectoryCategory, DirectoryEntry[]>();
  for (const category of CATEGORIES) byCategory.set(category, []);
  for (const entry of entries) byCategory.get(entry.seed.category)!.push(entry);

  const stats = new Map<DirectoryCategory, CategoryStats>();
  for (const category of CATEGORIES) {
    const members = byCategory.get(category)!;
    const scanned = members.flatMap((m) => (m.scanned ? [m.scanned] : []));
    stats.set(category, {
      category,
      count: members.length,
      medianTokens: median(scanned.map((s) => s.token_footprint.tokens)),
      medianScore: median(scanned.map((s) => s.score.composite)),
      medianToolCount: median(scanned.map((s) => s.tool_count))
    });
  }

  const scannedAt = entries
    .flatMap((e) => (e.result?.status === "ok" ? [e.result.scanned_at] : []))
    .sort();

  cache = {
    entries,
    byCategory,
    stats,
    lastScannedAt: scannedAt.at(-1)
  };
  return cache;
}

/** Test seam: the module-level cache would otherwise outlive a fixture swap. */
export function resetCatalogCache(): void {
  cache = undefined;
}

export function findEntry(catalog: Catalog, slug: string): DirectoryEntry | undefined {
  return catalog.entries.find((entry) => entry.seed.slug === slug);
}

export function resolveRedirect(slug: string): string | undefined {
  return loadRedirects().find((r) => r.from === slug)?.to;
}

/** Scanned members of a category, best score first. Ties break on slug for determinism. */
export function rankedInCategory(
  catalog: Catalog,
  category: DirectoryCategory
): DirectoryEntry[] {
  return [...(catalog.byCategory.get(category) ?? [])]
    .filter((e) => e.scanned)
    .sort(
      (a, b) =>
        b.scanned!.score.composite - a.scanned!.score.composite ||
        a.seed.slug.localeCompare(b.seed.slug)
    );
}

/** 1-based rank within the entry's category, or undefined if it was never scanned. */
export function rankInCategory(catalog: Catalog, entry: DirectoryEntry): number | undefined {
  if (!entry.scanned) return undefined;
  const index = rankedInCategory(catalog, entry.seed.category).findIndex(
    (e) => e.seed.slug === entry.seed.slug
  );
  return index === -1 ? undefined : index + 1;
}

export function rankedOverall(catalog: Catalog): DirectoryEntry[] {
  return catalog.entries
    .filter((e) => e.scanned)
    .sort(
      (a, b) =>
        b.scanned!.score.composite - a.scanned!.score.composite ||
        a.seed.slug.localeCompare(b.seed.slug)
    );
}

/**
 * Neighbours for the "how this compares" module. Same category first, ordered by
 * score proximity; topped up from the rest of the directory so every page ships
 * the same number of outbound links even in a category of one.
 */
export function relatedServers(
  catalog: Catalog,
  entry: DirectoryEntry,
  limit = 3
): DirectoryEntry[] {
  const self = entry.seed.slug;
  const score = entry.scanned?.score.composite;

  const proximity = (other: DirectoryEntry): number =>
    score === undefined || !other.scanned
      ? Number.MAX_SAFE_INTEGER
      : Math.abs(other.scanned.score.composite - score);

  const order = (a: DirectoryEntry, b: DirectoryEntry): number =>
    proximity(a) - proximity(b) || a.seed.slug.localeCompare(b.seed.slug);

  const others = catalog.entries.filter((e) => e.seed.slug !== self);
  const sameCategory = (e: DirectoryEntry) => e.seed.category === entry.seed.category;

  // Same category first, as the plan specifies — but a scanned neighbour always
  // beats an unscanned one, because a "closest comparison" with no score is not
  // a comparison, and its page is noindexed anyway.
  const tiers = [
    others.filter((e) => sameCategory(e) && e.scanned),
    others.filter((e) => !sameCategory(e) && e.scanned),
    others.filter((e) => sameCategory(e) && !e.scanned),
    others.filter((e) => !sameCategory(e) && !e.scanned)
  ];

  return tiers.flatMap((tier) => tier.sort(order)).slice(0, limit);
}

/** Neighbouring categories for cross-linking, wrapping around the fixed list. */
export function neighbouringCategories(category: DirectoryCategory): DirectoryCategory[] {
  const i = CATEGORIES.indexOf(category);
  const size = CATEGORIES.length;
  return [CATEGORIES[(i - 1 + size) % size]!, CATEGORIES[(i + 1) % size]!];
}
