import type Anthropic from "@anthropic-ai/sdk";
import { Scorer, RuleRegistry } from "mcp-surface-lint";
import type { ScanResult } from "../../directory/types";
import { SONNET, SUMMARY_SETTINGS, type ModelId } from "../config";
import { responseText, settingsParams } from "../requests";
import type { Footprint } from "../results";
import { plainText } from "./text";

/**
 * J4: two or three sentences for the top of a scorecard. The model sees only
 * facts we computed — scores, rule counts, token counts — never the server's
 * own descriptions, so what it writes about somebody else's product cannot be
 * steered by that product's tool text.
 */
export interface SummaryFacts {
  server: string;
  tools: number;
  score: number;
  grade: string;
  categories: Record<string, number>;
  findings: { rule: string; count: number; why: string }[];
  tokens_o200k: number;
  tokens_claude_sonnet: number | null;
  heaviest_tools: string[];
}

/** Tool names are the one thing from the server that reaches the prompt; keep them to name characters. */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.\-/]/g, "").slice(0, 64);
}

export function summaryFacts(name: string, scan: ScanResult, footprint: Footprint | undefined): SummaryFacts | undefined {
  if (!scan.score || !scan.token_footprint || scan.tool_count === null) return undefined;
  const counts = new Map<string, number>();
  for (const finding of scan.findings) {
    if (finding.severity !== "info") counts.set(finding.rule_id, (counts.get(finding.rule_id) ?? 0) + 1);
  }
  return {
    server: name,
    tools: scan.tool_count,
    score: scan.score.composite,
    grade: Scorer.grade(scan.score.composite),
    categories: scan.score.categories,
    findings: [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([rule, count]) => ({ rule, count, why: RuleRegistry.byId(rule)?.rationale ?? "" })),
    tokens_o200k: scan.token_footprint.tokens,
    tokens_claude_sonnet: footprint?.models[SONNET] ?? null,
    heaviest_tools: [...scan.tools]
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 3)
      .map((tool) => safeName(tool.name))
  };
}

const SYSTEM = `You write the two or three sentence summary at the top of an MCP server's audit page. You are given the audit's facts as JSON: the composite score and grade, the six category scores, the most frequent findings with why each rule matters, and the token cost of the tool list.

Say what matters most for someone deciding whether this tool surface will work well with an AI assistant: the overall standing, the biggest issue if there is one, and the context cost. Use only the facts given. Plain sentences, no headings, no lists, no links, no marketing, no advice addressed to the reader.`;

export function summaryRequest(facts: SummaryFacts, model: ModelId): Anthropic.MessageCreateParamsNonStreaming {
  const settings = settingsParams(SUMMARY_SETTINGS[model]);
  return {
    model,
    ...settings,
    output_config: {
      ...settings.output_config,
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
          additionalProperties: false
        }
      }
    },
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(facts) }]
  };
}

export function parseSummary(message: Anthropic.Message): string {
  if (message.stop_reason === "refusal") throw new Error("The model declined to summarise the audit.");
  if (message.stop_reason === "max_tokens") throw new Error("The summary was cut off at max_tokens.");
  let parsed: { summary?: unknown };
  try {
    parsed = JSON.parse(responseText(message)) as { summary?: unknown };
  } catch {
    throw new Error("The summary was not the JSON the schema asked for.");
  }
  const text = typeof parsed.summary === "string" ? plainText(parsed.summary, 600) : "";
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean).length;
  if (text.length < 60 || sentences > 4) throw new Error("The summary was not two or three sentences.");
  return text;
}
