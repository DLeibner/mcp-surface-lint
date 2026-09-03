import type { Metadata } from "next";
import { Docs, RuleRegistry, Scorer, type Category } from "mcp-surface-lint";
import { RulePageAnalytics } from "@/components/RulePageAnalytics";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  path: "/rules",
  title: "MCP Tool Surface Rules — the full catalogue",
  description:
    "All 19 rules MCP Surface Lint checks on a tools/list surface, across six categories: surface, naming, descriptions, schemas, annotations, and design."
});

const BLURBS: Record<Category, string> = {
  surface: "How much of the context window the tool surface consumes before anyone says anything.",
  naming: "Whether tool names are internally consistent enough for a model to generalise from.",
  descriptions: "Whether each tool explains itself well enough to be chosen correctly.",
  schemas: "Whether the input schemas are tight enough to constrain what the model sends.",
  annotations: "Whether clients can tell a read from a write before they run it.",
  design:
    "The interesting half. Whether the surface is shaped around your users' intents or around your REST endpoints."
};

export default function RulesPage() {
  // Generated from the registry rather than a hand-written page, so the anchors
  // here always match the docsUrl that every finding links to.
  const rules = RuleRegistry.all();

  return (
    <main>
      <RulePageAnalytics />
      <h1>Rules</h1>
      <p className="lede">
        {rules.length} rules, six categories. Each finding in a report links back to its rule here.
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
              {BLURBS[category]}
            </p>
            {group.map((rule) => (
              <article className="rule-card" key={rule.id} id={Docs.slug(rule.id)}>
                <h3>
                  <span className={`badge ${rule.severity}`}>{rule.severity}</span> {rule.id}
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
