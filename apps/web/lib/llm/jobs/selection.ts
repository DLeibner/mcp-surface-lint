import type Anthropic from "@anthropic-ai/sdk";
import AjvModule from "ajv";
import type { Mode, ModelId } from "../config";
import { SELECTION_SETTINGS } from "../config";
import { settingsParams } from "../requests";
import type { ApiSurface } from "../surface";
import type { Scenario } from "./scenarios";

/**
 * J2: tool selection. The model under test gets the surface exactly as a
 * client would send it and one scenario at a time, and we look at which tool
 * it reaches for. Nothing is executed: the `tool_use` block is graded and
 * thrown away, so no server is ever called.
 */
const SYSTEM =
  "You are an AI assistant connected to an MCP server through the tools provided. " +
  "When one of the tools fits the user's request, call it. When none fits, reply without calling a tool.";

/**
 * Tools and system prompt are the cached prefix shared by every scenario of a
 * run. A batch can take longer than five minutes to work through, so batched
 * requests ask for the one-hour TTL.
 */
export function selectionRequest(
  api: ApiSurface,
  scenario: Scenario,
  model: ModelId,
  mode: Mode
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    ...settingsParams(SELECTION_SETTINGS[model]),
    system: [
      {
        type: "text",
        text: SYSTEM,
        cache_control: mode === "batch" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" }
      }
    ],
    tools: api.tools,
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: scenario.prompt }]
  };
}

export type SelectionStop = "tool_use" | "no_tool" | "truncated" | "refused" | "error";

export interface ScenarioOutcome {
  id: string;
  /** MCP names of the tools the model called, in order. */
  called: string[];
  stop: SelectionStop;
  /** Null when the scenario could not be graded (truncated, refused, failed). */
  correct: boolean | null;
  /** The call's input against the tool's input schema; null when there is no call or no checkable schema. */
  args_valid: boolean | null;
  /** The stated arguments, when the right tool was called and the scenario states any. */
  args_match: boolean | null;
}

// ajv ships CommonJS; under ESM interop the class is sometimes one level down.
const Ajv = ((AjvModule as unknown as { default?: typeof AjvModule }).default ??
  AjvModule) as typeof AjvModule;

/**
 * Validates tool arguments against the schemas the surface publishes. Lenient
 * on purpose: unknown keywords and formats pass, and a schema that does not
 * compile makes the call uncheckable rather than wrong.
 */
export class ArgumentChecker {
  private readonly ajv = new Ajv({ strict: false, validateFormats: false, validateSchema: false });
  private readonly compiled = new Map<string, ((input: unknown) => boolean) | null>();

  constructor(private readonly schemas: Map<string, Record<string, unknown>>) {}

  check(tool: string, input: unknown): boolean | null {
    if (!this.compiled.has(tool)) {
      const schema = this.schemas.get(tool);
      let validate: ((input: unknown) => boolean) | null = null;
      if (schema) {
        const { $schema: _draft, $id: _id, ...rest } = schema;
        try {
          const compiled = this.ajv.compile(rest);
          validate = (value) => compiled(value) as boolean;
        } catch {
          validate = null;
        }
      }
      this.compiled.set(tool, validate);
    }
    const validate = this.compiled.get(tool);
    return validate ? validate(input) : null;
  }
}

function normalise(value: unknown): unknown {
  if (typeof value === "string") return value.trim().toLowerCase().replace(/\s+/g, " ");
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, normalise(inner)])
    );
  }
  return value;
}

/**
 * Loose equality for stated arguments: case, spacing and key order do not
 * matter, and "3" matches 3. A model that passes "paris" for "Paris" picked
 * the right value.
 */
export function sameValue(expected: unknown, actual: unknown): boolean {
  const a = normalise(expected);
  const b = normalise(actual);
  if (typeof a !== "object" && typeof b !== "object") return String(a) === String(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

export function gradeSelection(
  scenario: Scenario,
  message: Anthropic.Message,
  api: ApiSurface,
  checker: ArgumentChecker
): ScenarioOutcome {
  const calls = message.content.flatMap((block) =>
    block.type === "tool_use" ? [{ name: api.mcpName.get(block.name) ?? block.name, input: block.input }] : []
  );
  const called = calls.map((call) => call.name);
  const ungraded = (stop: SelectionStop): ScenarioOutcome => ({
    id: scenario.id,
    called,
    stop,
    correct: null,
    args_valid: null,
    args_match: null
  });

  if (message.stop_reason === "refusal") return ungraded("refused");
  if (calls.length === 0 && message.stop_reason === "max_tokens") return ungraded("truncated");

  const expected = scenario.expected_tool;
  const correct = expected === null ? calls.length === 0 : called.includes(expected);
  const primary = calls.find((call) => call.name === expected) ?? calls[0];
  const stated = Object.entries(scenario.expected_args);

  return {
    id: scenario.id,
    called,
    stop: calls.length > 0 ? "tool_use" : "no_tool",
    correct,
    args_valid: primary ? checker.check(primary.name, primary.input) : null,
    args_match:
      expected !== null && correct && stated.length > 0 && primary
        ? stated.every(([name, value]) =>
            sameValue(value, (primary.input as Record<string, unknown> | null)?.[name])
          )
        : null
  };
}

export interface SelectionMetrics {
  scenarios: number;
  targeted: number;
  distractors: number;
  /** Scenarios with a usable answer. */
  graded: number;
  /** Right tool, over graded scenarios that have one. */
  selection_accuracy: number | null;
  /** Any tool called, over graded distractors. */
  distractor_false_positive_rate: number | null;
  /** No tool called, over graded scenarios that have one. */
  no_call_rate: number | null;
  /** Schema-valid input, over calls with a checkable schema. */
  argument_validity: number | null;
  /** Stated arguments passed, over right-tool calls on scenarios that state any. */
  expected_args_match: number | null;
  truncated: number;
  refused: number;
  errored: number;
}

export interface ConfusedPair {
  expected: string;
  actual: string;
  count: number;
}

function rate(hits: number, total: number): number | null {
  return total === 0 ? null : Math.round((hits / total) * 1000) / 1000;
}

export function summariseSelection(
  scenarios: readonly Scenario[],
  outcomes: readonly ScenarioOutcome[]
): { metrics: SelectionMetrics; confused_pairs: ConfusedPair[] } {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const graded = outcomes.filter((outcome) => outcome.correct !== null);
  const targeted = graded.filter((outcome) => byId.get(outcome.id)?.expected_tool !== null);
  const distractors = graded.filter((outcome) => byId.get(outcome.id)?.expected_tool === null);
  const checked = graded.filter((outcome) => outcome.args_valid !== null);
  const stated = graded.filter((outcome) => outcome.args_match !== null);

  const pairs = new Map<string, ConfusedPair>();
  for (const outcome of targeted) {
    const expected = byId.get(outcome.id)?.expected_tool;
    const actual = outcome.called[0];
    if (outcome.correct || !expected || !actual) continue;
    const key = `${expected}\u0000${actual}`;
    const pair = pairs.get(key) ?? { expected, actual, count: 0 };
    pair.count += 1;
    pairs.set(key, pair);
  }

  return {
    metrics: {
      scenarios: scenarios.length,
      targeted: scenarios.filter((scenario) => scenario.expected_tool !== null).length,
      distractors: scenarios.filter((scenario) => scenario.expected_tool === null).length,
      graded: graded.length,
      selection_accuracy: rate(targeted.filter((o) => o.correct).length, targeted.length),
      distractor_false_positive_rate: rate(
        distractors.filter((o) => o.called.length > 0).length,
        distractors.length
      ),
      no_call_rate: rate(targeted.filter((o) => o.called.length === 0).length, targeted.length),
      argument_validity: rate(checked.filter((o) => o.args_valid).length, checked.length),
      expected_args_match: rate(stated.filter((o) => o.args_match).length, stated.length),
      truncated: outcomes.filter((o) => o.stop === "truncated").length,
      refused: outcomes.filter((o) => o.stop === "refused").length,
      errored: outcomes.filter((o) => o.stop === "error").length
    },
    confused_pairs: [...pairs.values()].sort(
      (a, b) => b.count - a.count || a.expected.localeCompare(b.expected) || a.actual.localeCompare(b.actual)
    )
  };
}
