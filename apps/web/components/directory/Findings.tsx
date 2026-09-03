import Link from "next/link";
import { Docs, RuleRegistry, type Severity } from "mcp-surface-lint";
import type { ScanFinding } from "@/lib/directory/types";

const ORDER: Severity[] = ["error", "warn", "info"];

const SEVERITY_INTRO: Record<Severity, string> = {
  error: "Findings that actively harm tool selection.",
  warn: "Findings that measurably degrade tool selection.",
  info: "Advisory only — these deduct nothing from the score."
};

/**
 * Every finding carries three things: which rule fired, where it fired, and why
 * that matters. The third comes from the rule catalogue rather than the finding
 * message, so the reasoning is identical on the rule page and here.
 */
export function Findings({ findings }: { findings: ScanFinding[] }) {
  return (
    <>
      {ORDER.map((severity) => {
        const group = findings.filter((f) => f.severity === severity);
        if (group.length === 0) return null;
        return (
          <section key={severity}>
            <h3>
              <span className={`badge ${severity}`}>{severity}</span> {group.length}{" "}
              {group.length === 1 ? "finding" : "findings"}
            </h3>
            <p className="hint">{SEVERITY_INTRO[severity]}</p>
            {group.map((finding, i) => {
              const rule = RuleRegistry.byId(finding.rule_id);
              return (
                <article className={`finding ${severity}`} key={`${finding.rule_id}-${i}`}>
                  <div className="meta">
                    <Link className="rule-id" href={`/rules/${Docs.slug(finding.rule_id)}`}>
                      {finding.rule_id}
                    </Link>
                    {finding.tool_name && <span className="tool-name">{finding.tool_name}</span>}
                  </div>
                  <div className="msg">{finding.message}</div>
                  {rule ? <p className="why">{rule.rationale}</p> : null}
                  {finding.evidence && <p className="evidence">{finding.evidence}</p>}
                </article>
              );
            })}
          </section>
        );
      })}
    </>
  );
}
