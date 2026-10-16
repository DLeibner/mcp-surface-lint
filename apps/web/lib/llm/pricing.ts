import type Anthropic from "@anthropic-ai/sdk";
import { BATCH_DISCOUNT, PRICES, type ModelId, type PriceCard } from "./config";

/** Token counts for one call, in the shape the ledger stores. */
export interface TokenUsage {
  inputTokens: number;
  /** Every cache-write token; `cacheWrite1hTokens` of them used the one-hour TTL. */
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export function usageFromApi(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    cacheWrite1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens: usage.output_tokens
  };
}

/** What the API bills a prompt's length on: cached and uncached input alike. */
export function promptTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
}

export function priceCard(model: ModelId, prompt: number): PriceCard {
  const cards = PRICES[model];
  return cards.find((card) => prompt <= card.maxPromptTokens) ?? cards[cards.length - 1]!;
}

/** Ledger amounts carry micro-dollar precision; a $0.002 call must not round to zero. */
export function roundUsd(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** What one call cost, from the `usage` object the API returned for it. */
export function costUsd(model: ModelId, usage: TokenUsage, batch: boolean): number {
  const card = priceCard(model, promptTokens(usage));
  const write5m = Math.max(usage.cacheWriteTokens - usage.cacheWrite1hTokens, 0);
  const perMillion =
    usage.inputTokens * card.input +
    write5m * card.cacheWrite5m +
    usage.cacheWrite1hTokens * card.cacheWrite1h +
    usage.cacheReadTokens * card.cacheRead +
    usage.outputTokens * card.output;
  return roundUsd((perMillion / 1_000_000) * (batch ? BATCH_DISCOUNT : 1));
}

/**
 * An upper bound before the call is made: the whole prompt uncached and every
 * allowed output token spent. The budget gate reserves this much, so a job can
 * never be admitted on an optimistic guess and then cross a stop.
 */
export function estimateUsd(
  model: ModelId,
  inputTokens: number,
  maxOutputTokens: number,
  batch: boolean
): number {
  return costUsd(
    model,
    {
      inputTokens,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
      outputTokens: maxOutputTokens
    },
    batch
  );
}
