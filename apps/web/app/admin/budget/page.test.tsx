import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SONNET } from "@/lib/llm/config";
import { MemoryLedger } from "@/lib/llm/ledger";
import { costUsd } from "@/lib/llm/pricing";

class DurableMemoryLedger extends MemoryLedger {
  override readonly durable = true;
}

const state = vi.hoisted(() => ({ ledger: undefined as MemoryLedger | undefined }));

vi.mock("@/lib/llm/ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/ledger")>();
  return { ...actual, getLedger: () => state.ledger };
});

const { default: BudgetPage } = await import("./page");

async function render(): Promise<string> {
  return renderToStaticMarkup(await BudgetPage());
}

describe("/admin/budget", () => {
  beforeEach(() => {
    state.ledger = new DurableMemoryLedger();
  });

  it("explains itself when there is no durable ledger", async () => {
    state.ledger = new MemoryLedger();
    expect(await render()).toContain("No ledger is configured");
  });

  it("shows a recorded call at the price the price table gives it", async () => {
    const usage = {
      inputTokens: 10_000,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 1_000
    };
    await state.ledger!.recordUsage({
      job: "fake",
      serverId: "example",
      model: SONNET,
      usage,
      usd: costUsd(SONNET, usage, false),
      batch: false
    });
    await state.ledger!.saveBatch({
      id: "msgbatch_open",
      submittedAt: new Date(),
      status: "in_progress",
      requestCount: 15,
      estimatedUsd: 0.25,
      requests: {},
      collectedAt: null
    });

    const html = await render();
    expect(html).toContain("$0.0300");
    expect(html).toContain("Claude Sonnet 5.5");
    expect(html).toContain("msgbatch_open");
    expect(html).toContain("$0.2500");
    expect(html).toContain("Every LLM job runs on its schedule.");
  });
});
