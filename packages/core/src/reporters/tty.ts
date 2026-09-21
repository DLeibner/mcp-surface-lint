import pc from "picocolors";
import { Scorer } from "../scoring.js";
import type { LintReport, ResolvedFinding, Severity } from "../types.js";

export class TtyReporter {
  render(report: LintReport): string {
    const lines: string[] = [];
    const name = report.server.name ?? "MCP server";
    lines.push("");
    lines.push(pc.bold(`MCP Surface Lint — ${name}${report.server.version ? ` v${report.server.version}` : ""}`));
    lines.push(pc.dim(`source: ${report.source} · captured: ${report.capturedAt}`));
    lines.push("");
    lines.push(
      pc.bold(
        `tools/list footprint: ~${report.stats.approxTokens.toLocaleString()} tokens per conversation (${report.stats.toolCount} tools)`
      ) + pc.dim(` [${report.stats.encoding}, approximate]`)
    );
    lines.push("");
    lines.push(`${pc.bold("Composite")} ${TtyReporter.scoreLabel(report.scores.composite)}`);
    for (const category of Scorer.categories) {
      const score = report.scores.categories[category];
      lines.push(`  ${category.padEnd(13)} ${TtyReporter.bar(score)} ${TtyReporter.scoreLabel(score)}`);
    }
    lines.push("");
    const counts: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
    for (const finding of report.findings) counts[finding.severity]++;
    lines.push(
      `${pc.red(`${counts.error} errors`)} · ${pc.yellow(`${counts.warn} warnings`)} · ${pc.cyan(`${counts.info} info`)}`
    );
    lines.push("");
    for (const finding of report.findings) {
      lines.push(this.renderFinding(finding));
    }
    if (report.findings.length === 0) lines.push(pc.green("No findings."));
    lines.push("");
    return lines.join("\n");
  }

  private renderFinding(finding: ResolvedFinding): string {
    const badge =
      finding.severity === "error"
        ? pc.red("error")
        : finding.severity === "warn"
          ? pc.yellow("warn ")
          : pc.cyan("info ");
    const tool = finding.toolName ? pc.bold(`${finding.toolName} `) : "";
    const evidence = finding.evidence
      ? `\n        ${pc.dim(TtyReporter.truncate(finding.evidence, 200))}`
      : "";
    return `  ${badge} ${pc.dim(finding.ruleId.padEnd(36))} ${tool}${finding.message}${evidence}`;
  }

  private static bar(score: number, width = 20): string {
    const filled = Math.round((score / 100) * width);
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    return score >= 90 ? pc.green(bar) : score >= 50 ? pc.yellow(bar) : pc.red(bar);
  }

  private static scoreLabel(score: number): string {
    const label = `${score}/100`;
    return score >= 90 ? pc.green(label) : score >= 50 ? pc.yellow(label) : pc.red(label);
  }

  private static truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
}
