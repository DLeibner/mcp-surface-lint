import type { Metadata } from "next";
import Link from "next/link";
import { Docs, RuleRegistry, Scorer } from "mcp-surface-lint";
import { Breadcrumb } from "@/components/directory/Breadcrumb";
import { loadCatalog } from "@/lib/directory/catalog";
import { breadcrumbList, jsonLdProps } from "@/lib/directory/schema-org";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  path: "/methodology",
  title: "How MCP Server Scores Are Calculated",
  description:
    "The full scoring model behind every MCP server audit: what is measured, what is deliberately not measured, how snapshots are obtained, and how to request a re-scan or removal."
});

const CRUMBS = [{ name: "Home", path: "/" }, { name: "Methodology" }];

export default function MethodologyPage() {
  const rules = RuleRegistry.all();
  const catalog = loadCatalog();

  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLdProps(breadcrumbList(CRUMBS))} />
      <Breadcrumb crumbs={CRUMBS} />

      <h1>Methodology</h1>
      <p className="lede">
        Every score in this directory comes from the same {rules.length} deterministic rules run over
        a server&apos;s published <code>tools/list</code> payload. No LLM is involved at any point,
        so the same surface always produces the same score, and any two people can reproduce it.
      </p>

      <h2>What we read, and what we never do</h2>
      <p>
        A scan sends exactly two MCP requests: <code>initialize</code> and <code>tools/list</code>.
        It never invokes a tool, never reads a resource, and never sends a real credential. Servers
        behind OAuth are recorded as awaiting a snapshot and are excluded from the index rather than
        authenticated against.
      </p>
      <p>
        Snapshots come from one of three places, in order: a public Streamable HTTP endpoint; a
        locally spawned <code>stdio</code> process given placeholder environment variables, which is
        usually enough for a server to list its tools; or a snapshot file its maintainers have sent
        us. Where none of those work, the server keeps a page but no score.
      </p>

      <h2>How the score is built</h2>
      <p>
        Each rule belongs to one of six categories. A finding above <code>info</code> severity
        deducts that rule&apos;s weight from its category, capped per rule so one noisy check cannot
        empty a category. The category score is <code>100 − deductions</code>, floored at zero. The
        composite is the unweighted mean of the six categories, which is why a surface can be
        excellent at naming and still score poorly overall.
      </p>
      <ul className="related">
        {Scorer.categories.map((category) => (
          <li key={category}>
            <strong>{category}</strong> — {rules.filter((r) => r.category === category).length} rules
          </li>
        ))}
      </ul>
      <p>
        Letter grades are presentation only: A is 90 and above, B is 80, C is 70, D is 60, F below
        that. They never feed back into the number.{" "}
        <Link href="/rules">Every rule is documented individually</Link>, including its weight and
        its configurable thresholds.
      </p>

      <h2>Token footprint</h2>
      <p>
        The headline number is the serialized size of the whole <code>tools/list</code> array,
        counted with the <code>o200k_base</code> encoding. It is approximate: a client may reformat
        the payload, and different model families tokenise differently. It is still the right order
        of magnitude for the cost you pay on every turn, because that payload is injected into
        context before the user says anything.
      </p>

      <h2>What this does not measure</h2>
      <p>
        This is a static analysis of a published interface. It says nothing about whether a server is
        secure, whether its tools work, how fast they are, whether the vendor is reputable, or
        whether the surface suits your particular workflow. A high score means the surface is
        legible to a model. A low score means an agent is more likely to pick the wrong tool — not
        that the product is bad.
      </p>
      <p>
        We also do not measure anything that requires calling a tool, because we do not call tools.
        Behaviour, correctness, and rate limits are all outside what a <code>tools/list</code>{" "}
        payload can tell you.
      </p>

      <h2>Freshness</h2>
      <p>
        Scans run weekly. A result is only rewritten when the tool surface or the engine version
        actually changed, so the date on a page is the date its content last differed — not the date
        a job happened to run. When a scan fails, the previous successful result stays published and
        the page says when it was captured.
      </p>
      <p className="hint">
        {catalog.lastScannedAt
          ? `The most recent change across the directory was ${catalog.lastScannedAt.slice(0, 10)}.`
          : "No scan has been published yet."}
      </p>

      <h2>Corrections, re-scans and removal</h2>
      <p>
        Every server page carries a maintainer box. Use it to request a re-scan, send a corrected
        snapshot, or ask for the page to be taken down. Removal requests are honoured without
        argument and without asking why. Corrections are applied on the next scan and the page shows
        the new capture date.
      </p>

      <h2>Reproducing a score yourself</h2>
      <p>The same engine that produces these pages is on npm and runs locally:</p>
      <div className="panel command-list">
        <code>npx mcp-surface-lint https://example.com/mcp</code>
        <code>npx mcp-surface-lint --stdio &quot;npx -y some-mcp-server&quot;</code>
        <code>npx mcp-surface-lint snapshot.json --json</code>
      </div>
      <p className="hint">
        Rule documentation, including thresholds, lives at{" "}
        <Link href={`/rules/${Docs.slug(rules[0]!.id)}`}>one page per rule</Link>.
      </p>

      <p className="disclaimer">
        <Link href="/servers">Browse the directory</Link> ·{" "}
        <Link href="/audit">Get a fix plan for your own server</Link>
      </p>
    </main>
  );
}
