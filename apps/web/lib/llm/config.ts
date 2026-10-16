/**
 * The LLM layer's spending policy, on one screen: models, prices, the budget
 * and its stops. Call sites never hardcode any of these, so a price change or a
 * new threshold is a one-line diff here.
 *
 * The layer only buys what code cannot compute — what a model actually does
 * when handed a tool surface. Everything code *can* compute (the handshake,
 * schema checks, the lint score) stays in the deterministic scanner, which
 * never waits on or pays for a model. An exhausted budget therefore pauses the
 * evals and nothing else.
 */

export const HAIKU = "claude-haiku-5-5";
export const SONNET = "claude-sonnet-5-5";
export const OPUS = "claude-opus-5-5";

export const MODELS = [HAIKU, SONNET, OPUS] as const;
export type ModelId = (typeof MODELS)[number];

export const MODEL_LABELS: Record<ModelId, string> = {
  [HAIKU]: "Claude Haiku 5.5",
  [SONNET]: "Claude Sonnet 5.5",
  [OPUS]: "Claude Opus 5.5"
};

export function isModelId(value: string): value is ModelId {
  return (MODELS as readonly string[]).includes(value);
}

/** USD per million tokens. */
export interface PriceCard {
  /** The card applies to prompts (input + cache writes + cache reads) up to this many tokens. */
  maxPromptTokens: number;
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

/**
 * Verified against https://platform.claude.com/docs/en/about-claude/pricing in
 * October 2026. Cards are ordered by `maxPromptTokens`: Haiku 5.5 is the only
 * model here whose rate depends on prompt length.
 */
export const PRICES: Record<ModelId, readonly PriceCard[]> = {
  [HAIKU]: [
    {
      maxPromptTokens: 100_000,
      input: 0.1,
      cacheWrite5m: 0.125,
      cacheWrite1h: 0.2,
      cacheRead: 0.01,
      output: 0.5
    },
    {
      maxPromptTokens: Number.POSITIVE_INFINITY,
      input: 0.5,
      cacheWrite5m: 0.625,
      cacheWrite1h: 1,
      cacheRead: 0.05,
      output: 2.5
    }
  ],
  [SONNET]: [
    {
      maxPromptTokens: Number.POSITIVE_INFINITY,
      input: 2,
      cacheWrite5m: 2.5,
      cacheWrite1h: 4,
      cacheRead: 0.1,
      output: 10
    }
  ],
  [OPUS]: [
    {
      maxPromptTokens: Number.POSITIVE_INFINITY,
      input: 4,
      cacheWrite5m: 5,
      cacheWrite1h: 8,
      cacheRead: 0.2,
      output: 20
    }
  ]
};

/** The Batch API halves every token category, and the cache multipliers stack with it. */
export const BATCH_DISCOUNT = 0.5;

export const BUDGET = {
  /** The Max plan's monthly API credit. Unused credit expires; nothing rolls over. */
  creditUsd: 100,
  /** What a normal cycle should cost. The admin page compares the projection against it. */
  targetUsd: 70,
  /** From 90% of the credit, only protected tiers (paid, showcase) keep their LLM jobs. */
  softStopRatio: 0.9,
  /**
   * From 95%, every LLM job is deferred and one admin email goes out. The
   * Console workspace spend limit ($95) is the backstop behind this.
   */
  hardStopRatio: 0.95,
  /**
   * Day of the month the credit refreshes: the Max plan's billing day, which is
   * not necessarily the 1st. Clamped to the month's length (31 means "last day").
   */
  cycleStartDay: 1
} as const;

/**
 * Who a server is to us. Only `directory` and `showcase` have members today;
 * `claimed` and `paid` exist so the gate and the cadence already know how to
 * treat them when claiming and billing do.
 */
export const TIERS = ["directory", "claimed", "paid", "showcase"] as const;
export type Tier = (typeof TIERS)[number];

/** Tiers whose LLM jobs keep running between the soft and the hard stop. */
export const PROTECTED_TIERS: readonly Tier[] = ["paid", "showcase"];
