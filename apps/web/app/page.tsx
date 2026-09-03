import type { Metadata } from "next";
import { LintForm } from "@/components/LintForm";
import { CliDocsAnalytics } from "@/components/CliDocsAnalytics";
import Link from "next/link";
import { EXAMPLE_REPORT_PATH } from "@/lib/example-report-path";
import { loadCatalog, rankedOverall } from "@/lib/directory/catalog";
import { jsonLdProps, website } from "@/lib/directory/schema-org";
import { CATEGORY_LABELS } from "@/lib/directory/types";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  path: "/",
  title: "MCP Surface Lint — audit your MCP server's tool surface",
  description:
    "Measure what an MCP server costs your context window, then statically audit its tool surface against 19 design rules. Deterministic, no LLM calls, no tool invocation."
});

export default function HomePage() {
  const catalog = loadCatalog();
  const top = rankedOverall(catalog).slice(0, 10);

  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLdProps(website())} />
      <h1>Your tools cost tokens in every single conversation.</h1>
      <p className="lede">
        Every MCP server ships its whole <code>tools/list</code> payload into the model&apos;s context
        before the user has typed a word. MCP Surface Lint measures that footprint, then statically
        audits the tool surface for the design smells that make agents pick the wrong tool — naming
        drift, CRUD mirrors, overlapping descriptions, unbounded lists.
      </p>

      <LintForm />

      <p className="lede">
        New here?{" "}
        <Link href={EXAMPLE_REPORT_PATH}>Open the public example report</Link> — full scores and
        findings, no paste required.
      </p>

      <h2>The directory</h2>
      <p className="lede">
        We run the same audit weekly against public MCP servers and publish the result. Every
        scorecard shows what that server costs your context window, what its schemas leave
        unconstrained, and where its surface is likely to send an agent to the wrong tool.
      </p>
      {top.length > 0 ? (
        <div className="table-scroll">
          <table className="server-table">
            <caption className="visually-hidden">
              The ten highest-scoring audited MCP servers.
            </caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Server</th>
                <th scope="col">Category</th>
                <th scope="col">Score</th>
                <th scope="col">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {top.map((entry, i) => (
                <tr key={entry.seed.slug}>
                  <td>{i + 1}</td>
                  <th scope="row">
                    <Link href={`/servers/${entry.seed.slug}`}>{entry.seed.name}</Link>
                  </th>
                  <td>{CATEGORY_LABELS[entry.seed.category]}</td>
                  <td>
                    <strong>{entry.scanned!.score.composite}</strong>
                  </td>
                  <td>{entry.scanned!.token_footprint.tokens.toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="lede">
        <Link href="/servers">See every audited server →</Link>
      </p>

      <h2>What it checks</h2>
      <p className="lede">
        Nineteen rules across six categories. Tier 1 is hygiene — missing descriptions, loose schemas,
        absent annotations. Tier 2 is the interesting half: design. Whether your surface mirrors your
        REST API instead of your users&apos; intents, whether two tools are confusable, whether an enum
        is buried in prose where the model can&apos;t see it.{" "}
        <a href="/rules">Read the rule catalogue →</a>
      </p>

      <h2>It runs locally too</h2>
      <CliDocsAnalytics />
      <p className="lede">
        Keep private schemas and credentials on your machine, audit stdio servers, or add a
        deterministic quality gate to CI.
      </p>
      <div className="panel command-list">
        <code>npx mcp-surface-lint --stdio &quot;node dist/server.js&quot;</code>
        <code>npx mcp-surface-lint https://example.com/mcp</code>
        <code>npx mcp-surface-lint snapshot.json --fail-under 80</code>
      </div>

      <h2>Use it from your AI client</h2>
      <p className="lede">
        Add the hosted, stateless MCP endpoint to Cursor, VS Code, Claude, Windsurf, or another
        Streamable HTTP client. Then ask your agent to audit a server and turn the structured
        findings into a concrete refactor plan.
      </p>
      <div className="panel cta-panel">
        <div>
          <strong>One tool, one boundary.</strong>
          <p className="hint">
            <code>check_mcp_server</code> reads the tool surface and never calls target tools.
          </p>
        </div>
        <a className="button-link" href="/install">
          Install MCP server
        </a>
      </div>
    </main>
  );
}
