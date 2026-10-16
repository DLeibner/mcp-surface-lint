/**
 * The LLM eval runner. It runs in .github/workflows/evals.yml and never in the
 * web app's request path: the web app only reads what this writes.
 *
 * Usage (from the repository root):
 *   npm run evals -- budget        this cycle's spend, reservations and gate level
 *   npm run evals -- fake-usage    record one synthetic call, to check /admin/budget end to end
 *
 * Reads DATABASE_URL for the ledger. Without it the ledger is in memory and
 * nothing survives the process — fine for a dry run, useless for real spend.
 */
import { parseArgs } from "node:util";
import { budgetState, exhaustedEventKey, cycleWindow } from "../lib/llm/budget";
import { BUDGET, SONNET, MODEL_LABELS } from "../lib/llm/config";
import { getLedger, type LlmLedger } from "../lib/llm/ledger";
import { costUsd, type TokenUsage } from "../lib/llm/pricing";

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

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  const command = positionals[0] ?? "budget";
  const ledger = getLedger();
  const now = new Date();

  switch (command) {
    case "budget":
      await printBudget(ledger, now);
      return;
    case "fake-usage":
      await recordFakeUsage(ledger);
      await printBudget(ledger, now);
      return;
    default:
      throw new Error(`Unknown command "${command}". Expected one of: budget, fake-usage.`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
