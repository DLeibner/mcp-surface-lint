import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumb } from "@/components/directory/Breadcrumb";
import { breadcrumbList, jsonLdProps } from "@/lib/directory/schema-org";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  path: "/audit",
  title: "MCP Tool Surface Audit and Fix Plan",
  description:
    "A prioritised plan for reshaping your MCP server's tool surface: what to merge, what to cut, what to retype, and the token saving of each change."
});

const CRUMBS = [{ name: "Home", path: "/" }, { name: "Audit" }];

const MAILTO =
  "mailto:hello@mcp-surface-lint.com?subject=" +
  encodeURIComponent("MCP surface fix plan") +
  "&body=" +
  encodeURIComponent(
    "Server (URL, package, or snapshot):\n\nWhat the surface is for:\n\nWhat is going wrong today:\n"
  );

export default function AuditPage() {
  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLdProps(breadcrumbList(CRUMBS))} />
      <Breadcrumb crumbs={CRUMBS} />

      <h1>Get a fix plan for your MCP server</h1>
      <p className="lede">
        The <Link href="/servers">directory</Link> and the{" "}
        <Link href="/">free playground</Link> tell you what is wrong. This is the part where somebody
        works out what to do about it, in what order, and what each change is worth.
      </p>

      <h2>What you get</h2>
      <ul className="related">
        <li>
          <strong>A ranked change list.</strong> Every finding turned into a concrete edit, ordered
          by token saving and selection-accuracy impact rather than by rule severity.
        </li>
        <li>
          <strong>A consolidation proposal.</strong> Which tools should merge behind one intent-shaped
          tool, with the parameter shape written out, and which should simply be removed.
        </li>
        <li>
          <strong>Rewritten descriptions and schemas</strong> for the tools that carry the most
          selection ambiguity — as a diff you can apply, not as advice.
        </li>
        <li>
          <strong>A before/after token budget</strong> so the saving is a number you can put in a
          pull request description.
        </li>
      </ul>

      <h2>How it works</h2>
      <p>
        Send the server: a public endpoint, an npm package, or a <code>tools/list</code> snapshot if
        the surface is private. Nothing is invoked, and nothing is published without your say-so —
        private surfaces stay private, and a directory page only ever covers a public server.
      </p>

      <div className="panel cta-panel">
        <div>
          <strong>Start with an email.</strong>
          <p className="hint">
            Describe the server and what is going wrong. You get a scoped reply, not a sales call.
          </p>
        </div>
        <a className="button-link" href={MAILTO}>
          Request a fix plan
        </a>
      </div>

      <h2>Before you pay for anything</h2>
      <p>
        Run the audit yourself first — it is free, it takes a minute, and it may be all you need.
        Paste a <code>tools/list</code> dump into <Link href="/">the playground</Link>, run{" "}
        <code>npx mcp-surface-lint</code> against your server, or read{" "}
        <Link href="/methodology">how the scoring works</Link> and fix the obvious things directly.
      </p>

      <p className="disclaimer">
        <Link href="/servers">See what other servers score</Link> ·{" "}
        <Link href="/rules">Read the rule catalogue</Link>
      </p>
    </main>
  );
}
