const ISSUE_URL =
  "https://github.com/DLeibner/mcp-surface-lint/issues/new?title=Re-scan%20request";

/**
 * Present on every server page from day one. We publish an analysis of somebody
 * else's product; the least we owe them is an obvious, one-click way to correct
 * it or have it removed.
 */
export function MaintainerBox({ name, slug }: { name: string; slug: string }) {
  return (
    <aside className="panel maintainer">
      <h2>Maintain {name}&apos;s MCP server?</h2>
      <p className="hint">
        Scores here reflect the published tool surface on the date shown. If the surface has changed,
        or the snapshot we read was wrong, ask for a re-scan and it will be picked up on the next
        run. Removal requests are honoured without argument.
      </p>
      <p className="verdict-links">
        <a href={`${ISSUE_URL}%3A%20${encodeURIComponent(slug)}`} target="_blank" rel="noreferrer">
          Request a re-scan
        </a>
        <a href={`mailto:hello@mcp-surface-lint.com?subject=${encodeURIComponent(`Correction: ${slug}`)}`}>
          Send a corrected snapshot
        </a>
      </p>
    </aside>
  );
}
