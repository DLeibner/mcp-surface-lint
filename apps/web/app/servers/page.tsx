import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumb } from "@/components/directory/Breadcrumb";
import { loadCatalog, rankedOverall } from "@/lib/directory/catalog";
import { indexableServers } from "@/lib/directory/indexing";
import { breadcrumbList, directoryDataset, jsonLdProps } from "@/lib/directory/schema-org";
import { hubDescription, hubTitle } from "@/lib/directory/seo-copy";
import { CATEGORIES, CATEGORY_LABELS } from "@/lib/directory/types";
import { pageMetadata } from "@/lib/seo";

function currentYear(lastScannedAt?: string): number {
  return new Date(lastScannedAt ?? Date.now()).getUTCFullYear();
}

export function generateMetadata(): Metadata {
  const catalog = loadCatalog();
  const year = currentYear(catalog.lastScannedAt);
  return pageMetadata({
    path: "/servers",
    title: hubTitle(year),
    description: hubDescription(catalog.entries.length, indexableServers(catalog).length, year)
  });
}

const CRUMBS = [{ name: "Home", path: "/" }, { name: "Servers" }];

export default function ServersHubPage() {
  const catalog = loadCatalog();
  const ranked = rankedOverall(catalog);
  const pending = catalog.entries.filter((e) => !e.scanned);
  const year = currentYear(catalog.lastScannedAt);

  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLdProps(breadcrumbList(CRUMBS))} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={jsonLdProps(
          directoryDataset(catalog.lastScannedAt, ranked.length)
        )}
      />

      <Breadcrumb crumbs={CRUMBS} />
      <h1>MCP servers ranked by tool surface quality</h1>
      <p className="lede">
        Every server below is audited with the same {""}
        <Link href="/rules">19 static rules</Link>: what its <code>tools/list</code> costs in tokens,
        how tightly its schemas are typed, and whether its surface is shaped around user intents or
        around REST endpoints. Nothing here calls a tool or runs an LLM.{" "}
        {ranked.length === catalog.entries.length
          ? `All ${ranked.length} carry a published scan as of ${year}.`
          : `${ranked.length} of ${catalog.entries.length} carry a published scan as of ${year}.`}
      </p>

      <div className="table-scroll">
        <table className="server-table">
          <caption className="visually-hidden">
            Audited MCP servers, highest composite score first.
          </caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Server</th>
              <th scope="col">Category</th>
              <th scope="col">Score</th>
              <th scope="col">Tools</th>
              <th scope="col">Tokens</th>
              <th scope="col">Findings</th>
              <th scope="col">Scanned</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((entry, i) => {
              const s = entry.scanned!;
              const date = s.scanned_at.slice(0, 10);
              return (
                <tr key={entry.seed.slug}>
                  <td>{i + 1}</td>
                  <th scope="row">
                    <Link href={`/servers/${entry.seed.slug}`}>{entry.seed.name}</Link>
                  </th>
                  <td>{CATEGORY_LABELS[entry.seed.category]}</td>
                  <td>
                    <strong>{s.score.composite}</strong>
                  </td>
                  <td>{s.tool_count}</td>
                  <td>{s.token_footprint.tokens.toLocaleString("en-US")}</td>
                  <td>{s.findings.filter((f) => f.severity !== "info").length}</td>
                  <td>
                    <time dateTime={date}>{date}</time>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pending.length > 0 && (
        <>
          <h2>Awaiting a first scan</h2>
          <p className="hint">
            These servers are in the directory but have no published surface yet — most sit behind
            OAuth, and we never authenticate to anyone&apos;s server. Their pages are not indexed
            until a scan succeeds.
          </p>
          <ul className="related">
            {pending.map((entry) => (
              <li key={entry.seed.slug}>
                <Link href={`/servers/${entry.seed.slug}`}>{entry.seed.name}</Link>{" "}
                <span className="hint">— {entry.result?.status ?? "queued"}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>By category</h2>
      <ul className="category-list">
        {CATEGORIES.map((category) => {
          const members = catalog.byCategory.get(category) ?? [];
          if (members.length === 0) return null;
          return (
            <li key={category}>
              <strong>{CATEGORY_LABELS[category]}</strong>{" "}
              <span className="hint">({members.length})</span>
              <br />
              {members.map((entry, i) => (
                <span key={entry.seed.slug}>
                  {i > 0 ? ", " : ""}
                  <Link href={`/servers/${entry.seed.slug}`}>{entry.seed.name}</Link>
                </span>
              ))}
            </li>
          );
        })}
      </ul>

      <p className="disclaimer">
        Scores describe a published tool surface on a given date, not the quality or security of the
        product behind it. <Link href="/methodology">How this is measured</Link>.
      </p>
    </main>
  );
}
