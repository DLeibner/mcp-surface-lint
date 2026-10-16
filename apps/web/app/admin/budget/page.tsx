import type { Metadata } from "next";
import {
  budgetState,
  cycleId,
  cycleWindow,
  exhaustedEventKey,
  type BudgetLevel
} from "@/lib/llm/budget";
import { BUDGET, MODEL_LABELS, isModelId } from "@/lib/llm/config";
import { getLedger } from "@/lib/llm/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "LLM budget",
  robots: { index: false, follow: false }
};

const LEVEL_COPY: Record<BudgetLevel, string> = {
  normal: "Every LLM job runs on its schedule.",
  "soft-stop": "Past the soft stop: only paid and showcase servers run LLM jobs.",
  "hard-stop": "Past the hard stop: every LLM job is deferred to the next cycle."
};

function usd(value: number): string {
  return `$${value.toFixed(value !== 0 && Math.abs(value) < 1 ? 4 : 2)}`;
}

function tokens(value: number): string {
  return value.toLocaleString("en-US");
}

function modelLabel(model: string): string {
  return isModelId(model) ? MODEL_LABELS[model] : model;
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Month-to-date spend for the credit cycle, read straight from the ledger the
 * budget gate reads. Behind Basic auth (middleware.ts) and never indexed.
 */
export default async function BudgetPage() {
  const ledger = getLedger();
  if (!ledger.durable) {
    return (
      <main>
        <h1>LLM budget</h1>
        <div className="panel">
          <p className="hint">
            No ledger is configured: <code>DATABASE_URL</code> is unset, so there is no spend to
            show. The eval runner records every call in Postgres; point this app at the same
            database to see it here.
          </p>
        </div>
      </main>
    );
  }

  const now = new Date();
  const window = cycleWindow(now);
  const [spentUsd, buckets, servers, rows, batches, exhausted] = await Promise.all([
    ledger.spentSince(window.start),
    ledger.usageByJobAndModel(window.start),
    ledger.usageByServer(window.start, 20),
    ledger.usageSince(window.start, 50),
    ledger.openBatches(),
    ledger.hasEvent(exhaustedEventKey(window))
  ]);
  const state = budgetState({
    now,
    spentUsd,
    pendingUsd: batches.reduce((sum, batch) => sum + batch.estimatedUsd, 0),
    exhausted
  });

  return (
    <main>
      <h1>LLM budget</h1>
      <p className="lede">
        Credit cycle {cycleId(window)} to {day(window.end)}, day {window.day} of {window.days}.{" "}
        {exhausted
          ? "The API reported the credit exhausted; LLM jobs resume when it refreshes."
          : LEVEL_COPY[state.level]}
      </p>

      <dl className="verdict-stats">
        <div>
          <dt>Spent this cycle</dt>
          <dd>{usd(state.spentUsd)}</dd>
        </div>
        <div>
          <dt>Reserved by open batches</dt>
          <dd>{usd(state.pendingUsd)}</dd>
        </div>
        <div>
          <dt>Projected at cycle end</dt>
          <dd>{usd(state.projectedUsd)}</dd>
        </div>
        <div>
          <dt>Credit</dt>
          <dd>{usd(BUDGET.creditUsd)}</dd>
        </div>
      </dl>
      <p className="hint">
        Target {usd(BUDGET.targetUsd)}; soft stop at {usd(BUDGET.creditUsd * BUDGET.softStopRatio)}
        ; hard stop at {usd(BUDGET.creditUsd * BUDGET.hardStopRatio)}. The projection extends this
        cycle&apos;s run rate to its last day and excludes open batches.
      </p>

      <h2>By job and model</h2>
      {buckets.length === 0 ? (
        <p className="hint">No LLM calls recorded this cycle.</p>
      ) : (
        <div className="table-scroll">
          <table className="server-table">
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Model</th>
                <th scope="col">Calls</th>
                <th scope="col">Batch</th>
                <th scope="col">Input</th>
                <th scope="col">Cache write</th>
                <th scope="col">Cache read</th>
                <th scope="col">Output</th>
                <th scope="col">USD</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr key={`${bucket.job}-${bucket.model}`}>
                  <th scope="row">{bucket.job}</th>
                  <td>{modelLabel(bucket.model)}</td>
                  <td>{tokens(bucket.calls)}</td>
                  <td>{tokens(bucket.batchCalls)}</td>
                  <td>{tokens(bucket.inputTokens)}</td>
                  <td>{tokens(bucket.cacheWriteTokens)}</td>
                  <td>{tokens(bucket.cacheReadTokens)}</td>
                  <td>{tokens(bucket.outputTokens)}</td>
                  <td>{usd(bucket.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Open batch submissions</h2>
      {batches.length === 0 ? (
        <p className="hint">Nothing submitted and waiting to be collected.</p>
      ) : (
        <div className="table-scroll">
          <table className="server-table">
            <thead>
              <tr>
                <th scope="col">Batch</th>
                <th scope="col">Submitted</th>
                <th scope="col">Requests</th>
                <th scope="col">Reserved</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => (
                <tr key={batch.id}>
                  <th scope="row">
                    <code>{batch.id}</code>
                  </th>
                  <td>{batch.submittedAt.toISOString().replace("T", " ").slice(0, 16)}</td>
                  <td>{tokens(batch.requestCount)}</td>
                  <td>{usd(batch.estimatedUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>By server</h2>
      {servers.length === 0 ? (
        <p className="hint">No server has cost anything this cycle.</p>
      ) : (
        <div className="table-scroll">
          <table className="server-table">
            <thead>
              <tr>
                <th scope="col">Server</th>
                <th scope="col">Calls</th>
                <th scope="col">USD</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => (
                <tr key={server.serverId}>
                  <th scope="row">{server.serverId}</th>
                  <td>{tokens(server.calls)}</td>
                  <td>{usd(server.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Latest calls</h2>
      {rows.length === 0 ? (
        <p className="hint">None yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="server-table">
            <thead>
              <tr>
                <th scope="col">When (UTC)</th>
                <th scope="col">Job</th>
                <th scope="col">Server</th>
                <th scope="col">Model</th>
                <th scope="col">In / cached / out</th>
                <th scope="col">USD</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={`${row.at.toISOString()}-${i}`}>
                  <th scope="row">{row.at.toISOString().replace("T", " ").slice(0, 19)}</th>
                  <td>
                    {row.job}
                    {row.batch ? " (batch)" : ""}
                  </td>
                  <td>{row.serverId}</td>
                  <td>{modelLabel(row.model)}</td>
                  <td>
                    {tokens(row.inputTokens + row.cacheWriteTokens)} /{" "}
                    {tokens(row.cacheReadTokens)} / {tokens(row.outputTokens)}
                  </td>
                  <td>{usd(row.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
