import { Scorer } from "../scoring.js";
import type { LintReport, ResolvedFinding, Severity } from "../types.js";

export class MdReporter {
  private static readonly BADGES: Record<Severity, string> = {
    error: "🔴",
    warn: "🟡",
    info: "🔵"
  };

  render(report: LintReport): string {
    const lines: string[] = [];
    const name = report.server.name ?? "MCP server";
    lines.push(`# MCP Surface Lint report — ${name}`);
    lines.push("");
    lines.push(
      `> **tools/list footprint: ~${report.stats.approxTokens.toLocaleString()} tokens per conversation (${report.stats.toolCount} tools)** — counted with ${report.stats.encoding}, approximate.`
    );
    lines.push("");
    lines.push(`**Composite score: ${report.scores.composite}/100**`);
    lines.push("");
    lines.push("| Category | Score |");
    lines.push("|---|---|");
    for (const category of Scorer.categories) {
      lines.push(`| ${category} | ${report.scores.categories[category]} |`);
    }
    lines.push("");
    for (const severity of ["error", "warn", "info"] as const) {
      const group = report.findings.filter((f) => f.severity === severity);
      if (group.length === 0) continue;
      lines.push(`## ${MdReporter.BADGES[severity]} ${severity} (${group.length})`);
      lines.push("");
      for (const finding of group) {
        lines.push(this.renderFinding(finding));
      }
      lines.push("");
    }
    if (report.findings.length === 0) {
      lines.push("No findings. 🎉");
      lines.push("");
    }
    return lines.join("\n");
  }

  private renderFinding(finding: ResolvedFinding): string {
    const where = finding.toolName ? ` \`${finding.toolName}\`` : "";
    const evidence = finding.evidence
      ? `\n  - evidence: ${MdReporter.truncate(finding.evidence, 300)}`
      : "";
    return `- **[${finding.ruleId}](${finding.docsUrl})**${where} — ${finding.message}${evidence}`;
  }

  private static truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
}
