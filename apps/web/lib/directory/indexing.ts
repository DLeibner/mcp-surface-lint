import { RuleRegistry, Docs } from "mcp-surface-lint";
import { loadCatalog, type Catalog, type DirectoryEntry } from "./catalog";
import { MIN_PROSE_WORDS, buildProse } from "./prose";

export interface IndexablePage {
  path: string;
  /** Drives the sitemap's `lastmod`; only changes when the underlying data does. */
  lastModified: Date;
}

export interface ServerIndexability {
  indexable: boolean;
  /** Populated when a page is withheld, and logged during the build. */
  reason?: "never-scanned" | "no-good-result" | "thin-content";
  wordCount: number;
}

/**
 * §6.7. A page enters the index only when it has something to say: a successful
 * scan (or a prior one it can fall back on) and enough generated prose to be
 * worth a result slot.
 */
export function serverIndexability(entry: DirectoryEntry, catalog: Catalog): ServerIndexability {
  if (!entry.result) return { indexable: false, reason: "never-scanned", wordCount: 0 };
  if (!entry.scanned) return { indexable: false, reason: "no-good-result", wordCount: 0 };

  const { wordCount } = buildProse(entry, catalog);
  if (wordCount < MIN_PROSE_WORDS) {
    return { indexable: false, reason: "thin-content", wordCount };
  }
  return { indexable: true, wordCount };
}

export function indexableServers(catalog: Catalog): DirectoryEntry[] {
  return catalog.entries.filter((entry) => serverIndexability(entry, catalog).indexable);
}

let logged = false;

/**
 * §6.3 requires withheld pages to be visible in the build output — a page that
 * silently drops out of the index is a page nobody notices is missing.
 */
export function logIndexDecisions(catalog: Catalog): void {
  if (logged) return;
  logged = true;

  const withheld = catalog.entries
    .map((entry) => ({ entry, verdict: serverIndexability(entry, catalog) }))
    .filter(({ verdict }) => !verdict.indexable);

  const indexed = catalog.entries.length - withheld.length;
  console.log(`[directory] ${indexed}/${catalog.entries.length} server pages indexable`);
  for (const { entry, verdict } of withheld) {
    const detail = verdict.reason === "thin-content" ? ` (${verdict.wordCount} words)` : "";
    console.log(`[directory]   noindex ${entry.seed.slug}: ${verdict.reason}${detail}`);
  }
}

function serverLastModified(entry: DirectoryEntry): Date {
  return new Date(entry.scanned?.scanned_at ?? entry.result?.scanned_at ?? Date.now());
}

/**
 * The single source of truth for what belongs in the index. The sitemap renders
 * this list verbatim, and the acceptance tests assert the two never diverge.
 */
export function indexablePages(catalog: Catalog = loadCatalog()): IndexablePage[] {
  const servers = indexableServers(catalog);
  const newest = servers.length
    ? new Date(Math.max(...servers.map((s) => serverLastModified(s).getTime())))
    : new Date(0);

  const pages: IndexablePage[] = [
    { path: "/", lastModified: newest },
    { path: "/servers", lastModified: newest },
    { path: "/rules", lastModified: newest },
    { path: "/methodology", lastModified: newest },
    { path: "/audit", lastModified: newest },
    { path: "/install", lastModified: newest },
    { path: "/example", lastModified: newest }
  ];

  for (const rule of RuleRegistry.all()) {
    pages.push({ path: `/rules/${Docs.slug(rule.id)}`, lastModified: newest });
  }

  for (const entry of servers) {
    pages.push({ path: `/servers/${entry.seed.slug}`, lastModified: serverLastModified(entry) });
  }

  return pages;
}
