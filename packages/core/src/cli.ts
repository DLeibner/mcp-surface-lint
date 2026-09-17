#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { ConfigLoader } from "./config.js";
import { LintEngine } from "./engine.js";
import { SnapshotLoader } from "./ingest/index.js";
import { JsonReporter } from "./reporters/json.js";
import { MdReporter } from "./reporters/md.js";
import { TtyReporter } from "./reporters/tty.js";
import { RuleRegistry } from "./rules/index.js";

class Cli {
  static async main(): Promise<void> {
    const program = new Command()
      .name("mcp-surface-lint")
      .description("Lighthouse for MCP servers — static, design-level linting of tool surfaces")
      .version("0.1.0")
      .argument("[target]", "server URL (streamable HTTP) or path to a tools/list snapshot JSON")
      .option("--stdio <command>", "spawn a server via stdio and connect to it")
      .option("--dump <file>", "capture the snapshot to a file and exit without linting")
      .option("--json", "output the report as JSON")
      .option("--md", "output the report as Markdown")
      .option("--fail-under <score>", "exit non-zero if the composite score is below this", parseFloat)
      .option("--config <path>", `path to ${ConfigLoader.defaultFileName}`)
      .option("--explain <ruleId>", "print a rule's rationale and docs link, then exit")
      .showHelpAfterError();

    program.parse();
    const options = program.opts<{
      stdio?: string;
      dump?: string;
      json?: boolean;
      md?: boolean;
      failUnder?: number;
      config?: string;
      explain?: string;
    }>();
    const target = program.args[0];

    if (options.explain) {
      Cli.explain(options.explain);
      return;
    }

    const snapshot = await SnapshotLoader.ingest({ target, stdio: options.stdio });

    if (options.dump) {
      await SnapshotLoader.dump(snapshot, options.dump);
      console.log(pc.green(`Snapshot written to ${options.dump} (${snapshot.tools.length} tools).`));
      return;
    }

    const config = await ConfigLoader.load(options.config);
    const report = new LintEngine(RuleRegistry.all(), config).run(snapshot);

    const reporter = options.json ? new JsonReporter() : options.md ? new MdReporter() : new TtyReporter();
    console.log(reporter.render(report));

    const failUnder = options.failUnder ?? config.failUnder;
    if (failUnder !== undefined && report.scores.composite < failUnder) {
      console.error(
        pc.red(`Composite score ${report.scores.composite} is below --fail-under ${failUnder}.`)
      );
      process.exitCode = 1;
    }
  }

  private static explain(ruleId: string): void {
    const rule = RuleRegistry.byId(ruleId);
    if (!rule) {
      console.error(pc.red(`Unknown rule "${ruleId}".`));
      console.error(`Known rules:\n  ${RuleRegistry.all().map((r) => r.id).join("\n  ")}`);
      process.exitCode = 1;
      return;
    }
    console.log("");
    console.log(pc.bold(rule.id));
    console.log(pc.dim(`category: ${rule.category} · severity: ${rule.severity} · weight: ${rule.weight}`));
    console.log("");
    console.log(rule.rationale);
    console.log("");
    console.log(pc.dim(`docs: ${rule.docsUrl}`));
    if (Object.keys(rule.defaultOptions).length > 0) {
      console.log(pc.dim(`default options: ${JSON.stringify(rule.defaultOptions)}`));
    }
    console.log("");
  }
}

Cli.main().catch((error: unknown) => {
  console.error(pc.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
