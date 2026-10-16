import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dataRoot } from "../directory/data";

/**
 * What the LLM layer publishes, one directory per server under data/evals/.
 * The runner writes these files in CI and commits them; the directory pages
 * read them at build time, exactly as they read the scan results. The ledger
 * in Postgres holds the money and the in-flight state; these files hold the
 * answers.
 */
export function evalsDir(slug: string): string {
  return path.join(dataRoot(), "evals", slug);
}

const iso = z.string().datetime();

export const footprintSchema = z.object({
  slug: z.string(),
  /** The surface these counts belong to. A mismatch with the scan means they are stale. */
  tools_hash: z.string(),
  counted_at: iso,
  /**
   * Tokens the tool list adds to a request, per model: `count_tokens` with the
   * tools minus `count_tokens` without them. Includes the tool-use system
   * prompt the API adds whenever any tool is present.
   */
  models: z.record(z.number().int().min(0)),
  /** Set when the API refused the surface — itself worth knowing. */
  error: z.string().nullable().default(null)
});
export type Footprint = z.infer<typeof footprintSchema>;

/** Set when an oversized surface was evaluated on a sample of its tools. */
const sampledSchema = z.object({ tools: z.number().int(), of: z.number().int() }).nullable();

export const scenariosSchema = z.object({
  slug: z.string(),
  /** Increments every time a new set is generated; selection results name the set they ran on. */
  version: z.number().int().min(1),
  tools_hash: z.string(),
  generated_at: iso,
  model: z.string(),
  prompt_version: z.number().int(),
  sampled: sampledSchema,
  scenarios: z.array(
    z.object({
      id: z.string(),
      prompt: z.string(),
      expected_tool: z.string().nullable(),
      expected_args: z.record(z.unknown())
    })
  )
});
export type ScenarioSet = z.infer<typeof scenariosSchema>;

const rateSchema = z.number().min(0).max(1).nullable();

export const selectionRunSchema = z.object({
  /** (server, tools_hash, model, scenario set, prompt version): the "never pay twice" key. */
  key: z.string(),
  model: z.string(),
  tools_hash: z.string(),
  scenario_set: z.number().int(),
  prompt_version: z.number().int(),
  mode: z.enum(["batch", "standard"]),
  settings: z.object({ max_tokens: z.number().int(), thinking: z.string(), effort: z.string() }),
  completed_at: iso,
  sampled: sampledSchema,
  metrics: z.object({
    scenarios: z.number().int(),
    targeted: z.number().int(),
    distractors: z.number().int(),
    graded: z.number().int(),
    selection_accuracy: rateSchema,
    distractor_false_positive_rate: rateSchema,
    no_call_rate: rateSchema,
    argument_validity: rateSchema,
    expected_args_match: rateSchema,
    truncated: z.number().int(),
    refused: z.number().int(),
    errored: z.number().int()
  }),
  confused_pairs: z.array(z.object({ expected: z.string(), actual: z.string(), count: z.number().int() })),
  outcomes: z.array(
    z.object({
      id: z.string(),
      called: z.array(z.string()),
      stop: z.enum(["tool_use", "no_tool", "truncated", "refused", "error"]),
      correct: z.boolean().nullable(),
      args_valid: z.boolean().nullable(),
      args_match: z.boolean().nullable()
    })
  ),
  usd: z.number().min(0)
});
export type SelectionRun = z.infer<typeof selectionRunSchema>;

export const selectionSchema = z.object({
  slug: z.string(),
  /** Newest first. Older surfaces and prompt versions stay, labelled, rather than vanish. */
  runs: z.array(selectionRunSchema)
});
export type SelectionResults = z.infer<typeof selectionSchema>;

/** Enough history to compare against, not an archive: git keeps the rest. */
export const RUNS_KEPT_PER_MODEL = 10;

const FILES = {
  footprint: { name: "footprint.json", schema: footprintSchema },
  scenarios: { name: "scenarios.json", schema: scenariosSchema },
  selection: { name: "selection.json", schema: selectionSchema }
} as const;

type EvalFile = keyof typeof FILES;
type EvalFileValue<K extends EvalFile> = z.infer<(typeof FILES)[K]["schema"]>;

export function readEvalFile<K extends EvalFile>(slug: string, kind: K): EvalFileValue<K> | undefined {
  const { name, schema } = FILES[kind];
  const file = path.join(evalsDir(slug), name);
  if (!existsSync(file)) return undefined;
  const parsed = schema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error(`data/evals/${slug}/${name} is malformed: ${parsed.error.message}`);
  }
  return parsed.data as EvalFileValue<K>;
}

/**
 * Writes only when the content changed, like the scanner: an unchanged run
 * must leave the working tree clean so the workflow has nothing to commit or
 * deploy. Returns whether the file was written.
 */
export function writeEvalFile<K extends EvalFile>(
  slug: string,
  kind: K,
  value: EvalFileValue<K>
): boolean {
  const { name, schema } = FILES[kind];
  const file = path.join(evalsDir(slug), name);
  const json = `${JSON.stringify(schema.parse(value), null, 2)}\n`;
  if (existsSync(file) && readFileSync(file, "utf8") === json) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, json, "utf8");
  return true;
}

/** Adds a run (newest first), replacing one with the same key and trimming old ones per model. */
export function withRun(results: SelectionResults | undefined, slug: string, run: SelectionRun): SelectionResults {
  const runs = [run, ...(results?.runs ?? []).filter((existing) => existing.key !== run.key)].sort(
    (a, b) => b.completed_at.localeCompare(a.completed_at) || a.key.localeCompare(b.key)
  );
  const perModel = new Map<string, number>();
  return {
    slug,
    runs: runs.filter((existing) => {
      const count = (perModel.get(existing.model) ?? 0) + 1;
      perModel.set(existing.model, count);
      return count <= RUNS_KEPT_PER_MODEL;
    })
  };
}
