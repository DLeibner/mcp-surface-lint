import type Anthropic from "@anthropic-ai/sdk";
import type { EvalClient } from "./client";
import { MODELS, type ModelId } from "./config";

/** Any message will do: the footprint is the difference the tools make to it. */
const PROBE: Anthropic.MessageParam[] = [{ role: "user", content: "Hello" }];

/**
 * Tokens a tool list adds to every request, counted by each model's own
 * tokenizer through the free `count_tokens` endpoint. One number is not
 * enough: the tokenizer that arrived with Opus 4.7 counts roughly 30% more
 * than the older one, and o200k_base is neither.
 *
 * `baselines` caches the tool-less count per model across servers.
 */
export async function countFootprint(
  client: EvalClient,
  tools: Anthropic.Tool[],
  baselines: Map<ModelId, number>
): Promise<Record<ModelId, number>> {
  const counts = {} as Record<ModelId, number>;
  for (const model of MODELS) {
    let baseline = baselines.get(model);
    if (baseline === undefined) {
      baseline = await client.countTokens({ model, messages: PROBE });
      baselines.set(model, baseline);
    }
    const withTools = await client.countTokens({ model, messages: PROBE, tools });
    counts[model] = Math.max(withTools - baseline, 0);
  }
  return counts;
}
