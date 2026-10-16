/**
 * The LLM eval runner. It runs in .github/workflows/evals.yml and never in the
 * web app's request path: the web app only reads what this writes.
 *
 * Usage (from the repository root):
 *   npm run evals -- run [--slug x]    do whatever is due, and write data/evals
 *   npm run evals -- plan [--slug x]   show what is due without calling the API
 *   npm run evals -- budget            this cycle's spend, reservations and gate level
 *   npm run evals -- fake-usage        record one synthetic call, to check /admin/budget
 *
 * Reads ANTHROPIC_API_KEY for the API and DATABASE_URL for the ledger. Without
 * a database the ledger is in memory and nothing survives the process — fine
 * for `plan`, useless for real spend.
 */
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { budgetState, exhaustedEventKey, cycleWindow } from "../lib/llm/budget";
import { sdkClient } from "../lib/llm/client";
import { BUDGET, SONNET, MODEL_LABELS } from "../lib/llm/config";
import { getLedger, type LlmLedger } from "../lib/llm/ledger";
import { costUsd, type TokenUsage } from "../lib/llm/pricing";
import { runEvals, type RunReport } from "../lib/llm/runner";

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

async function printBudget(ledger: LlmLedger, now: Date): Promise<void> {
  const window = cycleWindow(now);
  const [spentUsd, batches, exhausted] = await Promise.all([
    ledger.spentSince(window.start),
    ledger.openBatches(),
    ledger.hasEvent(exhaustedEventKey(window))
  ]);
  const state = budgetState({
    now,
    spentUsd,
    pendingUsd: batches.reduce((sum, batch) => sum + batch.estimatedUsd, 0),
    exhausted
  });
  console.log(
    [
      `cycle      ${window.start.toISOString().slice(0, 10)} → ${window.end.toISOString().slice(0, 10)} (day ${window.day} of ${window.days})`,
      `spent      ${usd(state.spentUsd)} of ${usd(BUDGET.creditUsd)}`,
      `reserved   ${usd(state.pendingUsd)} across ${batches.length} open batch(es)`,
      `projected  ${usd(state.projectedUsd)} (target ${usd(BUDGET.targetUsd)})`,
      `level      ${state.exhausted ? "credit exhausted" : state.level}`
    ].join("\n")
  );
}

/**
 * One call's worth of usage at known prices: 10,000 input and 1,000 output
 * tokens on Sonnet 5.5 is exactly $0.03 at standard rates, so the admin page
 * either shows that number or the pricing path is broken.
 */
async function recordFakeUsage(ledger: LlmLedger): Promise<void> {
  const usage: TokenUsage = {
    inputTokens: 10_000,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 1_000
  };
  const cost = costUsd(SONNET, usage, false);
  await ledger.recordUsage({
    job: "fake",
    serverId: "example",
    model: SONNET,
    usage,
    usd: cost,
    batch: false
  });
  console.log(
    `Recorded a fake ${MODEL_LABELS[SONNET]} call: 10,000 in / 1,000 out = ${usd(cost)}.` +
      (ledger.durable ? "" : "\nDATABASE_URL is unset, so it lives only in this process.")
  );
}

function reportLines(report: RunReport): string[] {
  const lines = report.footprints
    .filter((f) => f.outcome !== "current")
    .map((f) => `footprint  ${f.outcome.padEnd(9)} ${f.slug}${f.detail ? `  ${f.detail}` : ""}`);
  const current = report.footprints.filter((f) => f.outcome === "current").length;
  if (current > 0) lines.push(`footprint  ${current} already current`);
  for (const job of report.jobs) {
    const cost = job.usd ? ` ${usd(job.usd)}` : "";
    lines.push(
      `${job.job.padEnd(10)} ${job.outcome.padEnd(9)} ${job.slug} · ${MODEL_LABELS[job.model]}${cost}` +
        (job.detail ? `  ${job.detail}` : "")
    );
  }
  if (report.exhausted) lines.push("The API reported the credit exhausted; paid jobs wait for the next cycle.");
  lines.push(`${report.written.length} file(s) written under data/evals.`);
  return lines;
}

/** The same report on the workflow run's summary page, and the slugs to commit and ping. */
function writeWorkflowOutputs(report: RunReport): void {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    appendFileSync(summary, `## LLM evals\n\n\`\`\`\n${reportLines(report).join("\n")}\n\`\`\`\n`);
  }
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    const changed = [...new Set(report.written.map((file) => file.split("/")[2]))].sort();
    appendFileSync(output, `changed=${changed.join(",")}\n`);
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { slug: { type: "string", multiple: true } }
  });
  const command = positionals[0] ?? "budget";
  const ledger = getLedger();
  const now = new Date();
  const only = values.slug?.length ? new Set(values.slug) : undefined;

  switch (command) {
    case "run":
    case "plan": {
      const report = await runEvals({
        client: command === "run" ? sdkClient() : undefined,
        ledger,
        now,
        only,
        log: (line) => console.log(line)
      });
      console.log(reportLines(report).join("\n"));
      writeWorkflowOutputs(report);
      await printBudget(ledger, now);
      return;
    }
    case "budget":
      await printBudget(ledger, now);
      return;
    case "fake-usage":
      await recordFakeUsage(ledger);
      await printBudget(ledger, now);
      return;
    default:
      throw new Error(
        `Unknown command "${command}". Expected one of: run, plan, budget, fake-usage.`
      );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
