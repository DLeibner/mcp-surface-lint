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

const FILES = {
  footprint: { name: "footprint.json", schema: footprintSchema }
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
