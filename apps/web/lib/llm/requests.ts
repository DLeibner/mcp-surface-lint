import type Anthropic from "@anthropic-ai/sdk";
import type { RequestSettings } from "./config";

/** The per-model knobs from config.ts, in request form. */
export function settingsParams(
  settings: RequestSettings
): Pick<Anthropic.MessageCreateParamsNonStreaming, "max_tokens" | "thinking"> & {
  output_config: Anthropic.OutputConfig;
} {
  return {
    max_tokens: settings.maxTokens,
    thinking: { type: settings.thinking },
    output_config: { effort: settings.effort }
  };
}

/** The text of a response, wherever it sits after any thinking blocks. */
export function responseText(message: Anthropic.Message): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}
