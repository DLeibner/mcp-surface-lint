import { Scorer } from "mcp-surface-lint";
import { ExternalLinkIcon } from "@/components/ExternalLinkIcon";
import type { DirectoryEntry } from "@/lib/directory/catalog";
import type { ScannedResult } from "@/lib/directory/types";

function scoreColor(score: number): string {
  if (score >= 90) return "var(--good)";
  if (score >= 50) return "var(--warn)";
  return "var(--error)";
}

/**
 * Above the fold: the four numbers a reader came for, plus provenance. The
 * snapshot date and engine version are not decoration — without them the score
 * is an unfalsifiable claim about somebody else's product.
 */
export function Verdict({
  entry,
  scanned
}: {
  entry: DirectoryEntry;
  scanned: ScannedResult;
}) {
  const { composite } = scanned.score;
  const date = scanned.scanned_at.slice(0, 10);

  return (
    <section className="verdict" aria-label="Audit summary">
      <div className="verdict-grid">
        <div className="verdict-score">
          <span className="grade" style={{ color: scoreColor(composite) }}>
            {Scorer.grade(composite)}
          </span>
          <span className="composite">{composite}/100</span>
          <span className="verdict-label">composite score</span>
        </div>
        <dl className="verdict-stats">
          <div>
            <dt>Token footprint</dt>
            <dd>~{scanned.token_footprint.tokens.toLocaleString("en-US")}</dd>
          </div>
          <div>
            <dt>Tools</dt>
            <dd>{scanned.tool_count}</dd>
          </div>
          <div>
            <dt>Findings</dt>
            <dd>{scanned.findings.filter((f) => f.severity !== "info").length}</dd>
          </div>
          <div>
            <dt>Scanned</dt>
            <dd>
              <time dateTime={date}>{date}</time>
            </dd>
          </div>
        </dl>
      </div>

      <p className="verdict-meta">
        Engine <code>mcp-surface-lint@{scanned.engine_version}</code>
        {scanned.server_info.name ? (
          <>
            {" · "}reported as <code>{scanned.server_info.name}</code>
            {scanned.server_info.version ? ` v${scanned.server_info.version}` : ""}
          </>
        ) : null}
      </p>

      <p className="verdict-links">
        <a href={entry.seed.official_url} target="_blank" rel="noreferrer">
          Official page
          <ExternalLinkIcon />
        </a>
        {entry.seed.repo_url ? (
          <a href={entry.seed.repo_url} target="_blank" rel="noreferrer">
            Repository
            <ExternalLinkIcon />
          </a>
        ) : null}
        {entry.seed.docs_url ? (
          <a href={entry.seed.docs_url} target="_blank" rel="noreferrer">
            Docs
            <ExternalLinkIcon />
          </a>
        ) : null}
      </p>
    </section>
  );
}
