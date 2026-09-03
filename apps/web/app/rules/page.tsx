import type { Metadata } from "next";
import Link from "next/link";
import { Docs, RuleRegistry, Scorer } from "mcp-surface-lint";
import { RulePageAnalytics } from "@/components/RulePageAnalytics";
import { RULE_CATEGORY_BLURBS } from "@/lib/rule-categories";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  path: "/rules",
  title: "MCP Tool Surface Rules — the full catalogue",
  description:
    "All 19 rules MCP Surface Lint checks on a tools/list surface, across six categories: surface, naming, descriptions, schemas, annotations, and design."
});

export default function RulesPage() {
  // Generated from the registry rather than a hand-written page, so the anchors
  // here always match the docsUrl that every finding links to.
  const rules = RuleRegistry.all();

  return (
    <main>
      <RulePageAnalytics />
      <h1>Rules</h1>
      <p className="lede">
        {rules.length} rules, six categories, one page each. Every finding in a report links back to
        the rule that produced it.
        Everything is static: MCP Surface Lint reads your <code>tools/list</code> and never calls a
        tool.
      </p>

      {Scorer.categories.map((category) => {
        const group = rules.filter((rule) => rule.category === category);
        if (group.length === 0) return null;
        return (
          <section key={category}>
            <h2>{category}</h2>
            <p className="lede" style={{ marginBottom: "1rem" }}>
              {RULE_CATEGORY_BLURBS[category]}
            </p>
            {group.map((rule) => (
              <article className="rule-card" key={rule.id} id={Docs.slug(rule.id)}>
                <h3>
                  <span className={`badge ${rule.severity}`}>{rule.severity}</span>{" "}
                  <Link href={`/rules/${Docs.slug(rule.id)}`}>{rule.id}</Link>
                </h3>
                <p>{rule.rationale}</p>
              </article>
            ))}
          </section>
        );
      })}
    </main>
  );
}
