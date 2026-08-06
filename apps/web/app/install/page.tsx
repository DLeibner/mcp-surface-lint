import type { Metadata } from "next";
import { InstallTabs } from "@/components/InstallTabs";
import { InstallPageAnalytics } from "@/components/InstallPageAnalytics";
import { CliDocsAnalytics } from "@/components/CliDocsAnalytics";
import { mcpEndpointUrl } from "@/lib/site";

export const metadata: Metadata = {
  title: "Install the mcplint MCP server",
  description:
    "Add mcplint to Cursor, VS Code, Claude, Windsurf, or any Streamable HTTP MCP client."
};

export default function InstallPage() {
  const endpoint = mcpEndpointUrl();

  return (
    <main>
      <InstallPageAnalytics />
      <h1>Give your AI client an MCP reviewer.</h1>
      <p className="lede">
        The hosted mcplint server exposes one read-only tool: <code>check_mcp_server</code>. It
        accepts a public HTTPS endpoint or a <code>tools/list</code> snapshot and returns structured
        scores and findings.
      </p>

      <InstallTabs endpoint={endpoint} />

      <h2>What to ask</h2>
      <div className="panel prompt-panel">
        <p className="hint">Installed-server workflow</p>
        <code>Check my installed Grafana MCP server using the MCPLint tool.</code>
        <p className="hint">
          If your client exposes Grafana&apos;s complete tool definitions to the agent, it can forward
          them to mcplint as a snapshot. Otherwise the agent must ask you for Grafana&apos;s public
          endpoint or a <code>tools/list</code> JSON export. MCPLint never guesses missing schemas.
        </p>
      </div>
      <div className="use-case-grid">
        <article className="rule-card">
          <h3>Review a remote server</h3>
          <p>
            “Use mcplint to check <code>https://example.com/mcp</code>. Summarize the three
            highest-impact fixes.”
          </p>
        </article>
        <article className="rule-card">
          <h3>Review a snapshot</h3>
          <p>
            “Check this <code>tools/list</code> JSON with mcplint and explain why the design score
            is low.”
          </p>
        </article>
        <article className="rule-card">
          <h3>Iterate on a schema</h3>
          <p>
            “Audit this revised tool surface, compare category scores, and flag overlapping
            tools.”
          </p>
        </article>
      </div>

      <h2>Safety boundary</h2>
      <CliDocsAnalytics />
      <p className="lede">
        This is static analysis. The hosted tool reads only MCP initialization and{" "}
        <code>tools/list</code>; it never invokes a target tool and makes no LLM calls of its own.
        Inputs and captured schemas are not saved by the MCP endpoint. For private servers or
        sensitive credentials, use the local CLI instead.
      </p>
      <div className="panel">
        <code className="command">npx mcp-surface-lint --stdio &quot;node dist/server.js&quot;</code>
      </div>
    </main>
  );
}
