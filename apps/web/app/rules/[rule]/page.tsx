import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Docs, RuleRegistry } from "mcp-surface-lint";
import { Breadcrumb } from "@/components/directory/Breadcrumb";
import { RULE_CATEGORY_BLURBS } from "@/lib/rule-categories";
import { breadcrumbList, jsonLdProps } from "@/lib/directory/schema-org";
import { pageMetadata } from "@/lib/seo";

type Props = { params: Promise<{ rule: string }> };

export const dynamicParams = false;

export function generateStaticParams(): { rule: string }[] {
  return RuleRegistry.all().map((rule) => ({ rule: Docs.slug(rule.id) }));
}

function bySlug(slug: string) {
  return RuleRegistry.all().find((rule) => Docs.slug(rule.id) === slug);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { rule: slug } = await params;
  const rule = bySlug(slug);
  if (!rule) return { title: "Rule not found" };

  return pageMetadata({
    path: `/rules/${slug}`,
    title: `${rule.id} — MCP tool surface rule`,
    description: `${rule.rationale.slice(0, 150)}`.trim()
  });
}

export default async function RulePage({ params }: Props) {
  const { rule: slug } = await params;
  const rule = bySlug(slug);
  if (!rule) notFound();

  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Rules", path: "/rules" },
    { name: rule.id }
  ];
  const siblings = RuleRegistry.all().filter(
    (other) => other.category === rule.category && other.id !== rule.id
  );

  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLdProps(breadcrumbList(crumbs))} />
      <Breadcrumb crumbs={crumbs} />

      <h1>
        <code>{rule.id}</code>
      </h1>
      <p className="lede">{rule.rationale}</p>

      <dl className="verdict-stats">
        <div>
          <dt>Category</dt>
          <dd>{rule.category}</dd>
        </div>
        <div>
          <dt>Default severity</dt>
          <dd>
            <span className={`badge ${rule.severity}`}>{rule.severity}</span>
          </dd>
        </div>
        <div>
          <dt>Weight</dt>
          <dd>{rule.weight}</dd>
        </div>
        <div>
          <dt>Max deduction</dt>
          <dd>{rule.maxDeduction}</dd>
        </div>
      </dl>

      <h2>Why this category matters</h2>
      <p>{RULE_CATEGORY_BLURBS[rule.category]}</p>
      <p>
        A rule deducts <code>weight</code> points from its category for each non-info finding, capped
        at <code>maxDeduction</code>. The composite is the mean of the six category scores — so a
        single noisy rule can never sink a whole surface on its own.{" "}
        <Link href="/methodology">Read the full scoring model</Link>.
      </p>

      {Object.keys(rule.defaultOptions).length > 0 && (
        <>
          <h2>Configuration</h2>
          <p className="hint">
            Override these in <code>.mcp-surface-lintrc.json</code> to match your own thresholds.
          </p>
          <pre className="panel">
            <code>{JSON.stringify({ rules: { [rule.id]: { options: rule.defaultOptions } } }, null, 2)}</code>
          </pre>
        </>
      )}

      {siblings.length > 0 && (
        <>
          <h2>Other {rule.category} rules</h2>
          <ul className="related">
            {siblings.map((other) => (
              <li key={other.id}>
                <Link href={`/rules/${Docs.slug(other.id)}`}>
                  <code>{other.id}</code>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="disclaimer">
        <Link href="/rules">Back to the full rule catalogue</Link> ·{" "}
        <Link href="/servers">Browse audited servers</Link>
      </p>
    </main>
  );
}
