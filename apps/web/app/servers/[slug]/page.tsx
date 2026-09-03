import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Scorer } from "mcp-surface-lint";
import { Breadcrumb } from "@/components/directory/Breadcrumb";
import { Verdict } from "@/components/directory/Verdict";
import { Findings } from "@/components/directory/Findings";
import { ToolInventory } from "@/components/directory/ToolInventory";
import { MaintainerBox } from "@/components/directory/MaintainerBox";
import { findEntry, loadCatalog, rankInCategory, relatedServers } from "@/lib/directory/catalog";
import { logIndexDecisions, serverIndexability } from "@/lib/directory/indexing";
import { buildProse } from "@/lib/directory/prose";
import {
  breadcrumbList,
  jsonLdProps,
  softwareApplication,
  type Crumb
} from "@/lib/directory/schema-org";
import { serverDescription, serverTitle } from "@/lib/directory/seo-copy";
import { CATEGORY_LABELS } from "@/lib/directory/types";
import { pageMetadata } from "@/lib/seo";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams(): { slug: string }[] {
  const catalog = loadCatalog();
  logIndexDecisions(catalog);
  return catalog.entries.map((entry) => ({ slug: entry.seed.slug }));
}

function crumbsFor(name: string, category: keyof typeof CATEGORY_LABELS): Crumb[] {
  // The category is not a link until Phase 2 ships /servers/category/{category};
  // a breadcrumb that 404s is worse than one that reads as plain text.
  return [
    { name: "Home", path: "/" },
    { name: "Servers", path: "/servers" },
    { name: CATEGORY_LABELS[category] },
    { name }
  ];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const catalog = loadCatalog();
  const entry = findEntry(catalog, slug);
  if (!entry) return { title: "Server not found" };

  return pageMetadata({
    path: `/servers/${slug}`,
    title: serverTitle(entry),
    description: serverDescription(entry),
    noindex: !serverIndexability(entry, catalog).indexable,
    ogType: "article"
  });
}

export default async function ServerPage({ params }: Props) {
  const { slug } = await params;
  const catalog = loadCatalog();
  const entry = findEntry(catalog, slug);
  if (!entry) notFound();

  const { seed, scanned, result } = entry;
  const crumbs = crumbsFor(seed.name, seed.category);
  const related = relatedServers(catalog, entry);
  const stats = catalog.stats.get(seed.category);
  const rank = rankInCategory(catalog, entry);
  const prose = scanned ? buildProse(entry, catalog) : undefined;
  const counted = scanned?.findings.filter((f) => f.severity !== "info") ?? [];

  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLdProps(breadcrumbList(crumbs))} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={jsonLdProps(softwareApplication(entry))}
      />

      <Breadcrumb crumbs={crumbs} />
      <h1>{seed.name} MCP server tool surface audit</h1>

      {scanned ? (
        <>
          <Verdict entry={entry} scanned={scanned} />

          {prose!.summary.map((paragraph, i) => (
            <p className="lede" key={`summary-${i}`}>
              {paragraph}
            </p>
          ))}

          <h2 id="token-footprint">Token footprint</h2>
          {prose!.footprint.map((paragraph, i) => (
            <p key={`footprint-${i}`}>{paragraph}</p>
          ))}

          <div className="cats">
            {Scorer.categories.map((category) => {
              const score = scanned.score.categories[category] ?? 100;
              return (
                <div className="cat" key={category}>
                  <span className="name">{category}</span>
                  <span className="bar">
                    <i
                      style={{
                        width: `${score}%`,
                        background:
                          score >= 90 ? "var(--good)" : score >= 50 ? "var(--warn)" : "var(--error)"
                      }}
                    />
                  </span>
                  <span className="val">{score}</span>
                </div>
              );
            })}
          </div>

          <h2 id="findings">Findings</h2>
          {counted.length === 0 ? (
            prose!.strengths.map((paragraph, i) => <p key={`clean-${i}`}>{paragraph}</p>)
          ) : (
            <>
              {prose!.findings.map((paragraph, i) => (
                <p key={`findings-${i}`}>{paragraph}</p>
              ))}
              <Findings findings={scanned.findings} />
              <h3>What this surface does well</h3>
              {prose!.strengths.map((paragraph, i) => (
                <p key={`strength-${i}`}>{paragraph}</p>
              ))}
            </>
          )}

          <h2 id="tools">Tool inventory</h2>
          {prose!.inventory.map((paragraph, i) => (
            <p key={`inventory-${i}`}>{paragraph}</p>
          ))}
          <p className="hint">
            All {scanned.tool_count} tools as published, heaviest first. Token counts use the{" "}
            {scanned.token_footprint.tokenizer} encoding and are approximate.
          </p>
          <ToolInventory tools={scanned.tools} />

          <h2 id="compares">How this compares</h2>
          {prose!.comparison.map((paragraph, i) => (
            <p key={`compare-${i}`}>{paragraph}</p>
          ))}
          <dl className="verdict-stats">
            <div>
              <dt>Category</dt>
              <dd>{CATEGORY_LABELS[seed.category]}</dd>
            </div>
            <div>
              <dt>Rank in category</dt>
              <dd>{rank ?? "—"}</dd>
            </div>
            <div>
              <dt>Category median score</dt>
              <dd>{stats?.medianScore ?? "—"}</dd>
            </div>
            <div>
              <dt>Category median tokens</dt>
              <dd>{stats?.medianTokens?.toLocaleString("en-US") ?? "—"}</dd>
            </div>
          </dl>
          {related.length > 0 && (
            <ul className="related">
              {related.map((other) => (
                <li key={other.seed.slug}>
                  <Link href={`/servers/${other.seed.slug}`}>
                    {other.seed.name} MCP server
                    {other.scanned ? ` — ${other.scanned.score.composite}/100` : ""}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <UnscannedNotice
          name={seed.name}
          description={seed.description}
          status={result?.status}
          error={result?.last_error}
        />
      )}

      <MaintainerBox name={seed.name} slug={seed.slug} />

      <div className="panel cta-panel">
        <div>
          <strong>Want this surface fixed, not just measured?</strong>
          <p className="hint">
            A fix plan turns these findings into an ordered set of changes with the token saving of
            each one.
          </p>
        </div>
        <Link className="button-link" href={`/audit?ref=${seed.slug}`}>
          Get a fix plan
        </Link>
      </div>

      <p className="disclaimer">
        This page is a static analysis of {seed.name}&apos;s published <code>tools/list</code>{" "}
        surface on the date shown. It is not a security review, a performance benchmark, or a
        judgement of the product behind the surface. Read{" "}
        <Link href="/methodology">how the score is computed</Link>, or browse{" "}
        <Link href="/servers">every audited server</Link>.
      </p>
    </main>
  );
}

function UnscannedNotice({
  name,
  description,
  status,
  error
}: {
  name: string;
  description: string;
  status?: string;
  error?: string | null;
}) {
  return (
    <>
      <p className="lede">{description}</p>
      <div className="panel">
        <p className="hint">
          {status === "needs-snapshot"
            ? `${name}'s server sits behind authentication. We do not authenticate to anyone's server and we never call a tool, so this surface can only be audited from a snapshot its maintainers publish or send us.`
            : status === "unreachable"
              ? `The last scan could not reach ${name}'s server, and no earlier successful scan exists to fall back on.`
              : `${name} is queued for its first scan.`}
        </p>
        {error ? <p className="evidence">{error}</p> : null}
      </div>
    </>
  );
}
