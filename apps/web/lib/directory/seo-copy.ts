import { CATEGORY_LABELS, type DirectoryCategory } from "./types";
import type { DirectoryEntry } from "./catalog";

const SUFFIX = " | MCP Surface Lint";
const TITLE_LIMIT = 60;

function withSuffix(title: string): string {
  return title.length + SUFFIX.length <= TITLE_LIMIT ? `${title}${SUFFIX}` : title;
}

/**
 * §6.1's priority ladder: take the most informative title that still fits, and
 * only brand it when there is room left. A truncated title in a result page
 * costs more than a missing brand does.
 */
export function serverTitle(entry: DirectoryEntry): string {
  const { name } = entry.seed;
  const score = entry.scanned?.score.composite;

  const candidates =
    score === undefined
      ? [`${name} MCP Server Audit`]
      : [
          `${name} MCP Server: Tool Surface Audit (${score}/100)`,
          `${name} MCP Server Audit (${score}/100)`,
          `${name} MCP Server Audit`
        ];

  const fitting = candidates.find((c) => c.length <= TITLE_LIMIT) ?? candidates.at(-1)!;
  return withSuffix(fitting);
}

function isoDate(value: string): string {
  return value.slice(0, 10);
}

/**
 * Data-driven, never boilerplate: every number in here differs per server, which
 * is what keeps 150 near-identical pages out of a duplicate-content filter.
 */
export function serverDescription(entry: DirectoryEntry): string {
  const { name, description } = entry.seed;
  const scanned = entry.scanned;

  if (!scanned) {
    return `${description} Not yet scanned by MCP Surface Lint — no tool surface audit is published for ${name} at this time.`.slice(
      0,
      300
    );
  }

  const counted = scanned.findings.filter((f) => f.severity !== "info");
  const ruleCount = new Set(counted.map((f) => f.rule_id)).size;
  const tokens = scanned.token_footprint.tokens.toLocaleString("en-US");

  const findingsClause =
    counted.length === 0
      ? `Scores ${scanned.score.composite}/100 with no findings.`
      : `Scores ${scanned.score.composite}/100 with ${counted.length} findings across ${ruleCount} rule${ruleCount === 1 ? "" : "s"}.`;

  return `${name}'s MCP server exposes ${scanned.tool_count} tools costing about ${tokens} tokens per conversation. ${findingsClause} Scanned ${isoDate(scanned.scanned_at)}.`;
}

export function hubTitle(year: number): string {
  return `Best MCP Servers Ranked by Tool Surface Quality (${year})`;
}

export function hubDescription(count: number, scannedCount: number, year: number): string {
  return `Every MCP server we audit, ranked by tool surface quality. ${scannedCount} of ${count} servers scanned for token footprint, schema quality and design smells as of ${year}.`;
}

export function categoryTitle(category: DirectoryCategory, count: number): string {
  return `Best MCP Servers for ${CATEGORY_LABELS[category]} (${count} audited)`;
}

export function categoryDescription(category: DirectoryCategory, count: number): string {
  return `${count} ${CATEGORY_LABELS[category]} MCP server${count === 1 ? "" : "s"} audited for token footprint, schema quality and tool-selection design, each with a full scorecard.`;
}
