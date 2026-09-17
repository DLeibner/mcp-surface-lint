import type { RuleSetting, SurfaceLintConfig } from "./config.js";
import { Scorer } from "./scoring.js";
import { TokenCounter } from "./tokens.js";
import type {
  LintReport,
  ResolvedFinding,
  Rule,
  RuleOptions,
  ServerSnapshot,
  Severity
} from "./types.js";

interface ResolvedRule {
  rule: Rule;
  severity: Severity;
  options: RuleOptions;
}

export class LintEngine {
  private readonly resolved: ResolvedRule[];

  constructor(rules: Rule[], private readonly config: SurfaceLintConfig) {
    this.resolved = rules
      .map((rule) => this.resolveRule(rule))
      .filter((r): r is ResolvedRule => r !== undefined);
  }

  private resolveRule(rule: Rule): ResolvedRule | undefined {
    const setting: RuleSetting | undefined = this.config.rules[rule.id];
    if (setting === "off") return undefined;
    if (setting === undefined) {
      return { rule, severity: rule.severity, options: { ...rule.defaultOptions } };
    }
    if (typeof setting === "string") {
      return { rule, severity: setting, options: { ...rule.defaultOptions } };
    }
    return {
      rule,
      severity: setting.severity ?? rule.severity,
      options: { ...rule.defaultOptions, ...(setting.options ?? {}) }
    };
  }

  run(snapshot: ServerSnapshot): LintReport {
    const findings: ResolvedFinding[] = [];
    for (const { rule, severity, options } of this.resolved) {
      for (const finding of rule.check(snapshot, options)) {
        findings.push({
          ...finding,
          severity: finding.severity ?? severity,
          category: rule.category,
          docsUrl: rule.docsUrl
        });
      }
    }
    const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
    findings.sort(
      (a, b) => order[a.severity] - order[b.severity] || a.ruleId.localeCompare(b.ruleId)
    );
    const scores = new Scorer(this.resolved.map((r) => r.rule)).score(findings);
    return {
      server: snapshot.serverInfo ?? {},
      source: snapshot.source,
      capturedAt: snapshot.capturedAt,
      stats: {
        toolCount: snapshot.tools.length,
        approxTokens: TokenCounter.snapshot(snapshot),
        encoding: TokenCounter.encoding
      },
      scores,
      findings
    };
  }
}
