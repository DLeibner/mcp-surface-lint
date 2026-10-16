import { describe, expect, it } from "vitest";
import { HAIKU, OPUS, SONNET } from "./config";
import { costUsd, estimateUsd, priceCard, type TokenUsage } from "./pricing";

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    ...partial
  };
}

describe("costUsd", () => {
  it("prices input and output at the standard rate", () => {
    // $2/MTok in, $10/MTok out.
    expect(costUsd(SONNET, usage({ inputTokens: 10_000, outputTokens: 1_000 }), false)).toBe(0.03);
    // $4/MTok in, $20/MTok out.
    expect(costUsd(OPUS, usage({ inputTokens: 10_000, outputTokens: 1_000 }), false)).toBe(0.06);
    // $0.10/MTok in, $0.50/MTok out.
    expect(costUsd(HAIKU, usage({ inputTokens: 10_000, outputTokens: 1_000 }), false)).toBe(0.0015);
  });

  it("halves every category in a batch", () => {
    const tokens = usage({
      inputTokens: 1_000,
      cacheWriteTokens: 5_000,
      cacheReadTokens: 5_000,
      outputTokens: 200
    });
    expect(costUsd(SONNET, tokens, true)).toBeCloseTo(costUsd(SONNET, tokens, false) / 2, 6);
  });

  it("splits cache writes by TTL and prices cache reads at the model's own rate", () => {
    // Sonnet: 5m write $2.50, 1h write $4, read $0.10 (0.05x input, not 0.1x).
    const tokens = usage({
      cacheWriteTokens: 3_000_000,
      cacheWrite1hTokens: 1_000_000,
      cacheReadTokens: 1_000_000
    });
    expect(costUsd(SONNET, tokens, false)).toBe(2 * 2.5 + 4 + 0.1);
  });

  it("moves Haiku to its long-context card past 100k prompt tokens, cache included", () => {
    expect(priceCard(HAIKU, 100_000).input).toBe(0.1);
    expect(priceCard(HAIKU, 100_001).input).toBe(0.5);
    const long = usage({ inputTokens: 1_000, cacheReadTokens: 100_000, outputTokens: 1_000 });
    // 1k × $0.50 + 100k × $0.05 + 1k × $2.50, per million.
    expect(costUsd(HAIKU, long, false)).toBe(0.008);
  });

  it("keeps micro-dollar precision", () => {
    expect(costUsd(HAIKU, usage({ inputTokens: 1 }), false)).toBe(0);
    expect(costUsd(HAIKU, usage({ inputTokens: 100 }), false)).toBe(0.00001);
  });
});

describe("estimateUsd", () => {
  it("assumes no cache hits and every output token spent", () => {
    expect(estimateUsd(SONNET, 5_000, 200, true)).toBe((5_000 * 1 + 200 * 5) / 1_000_000);
  });
});
