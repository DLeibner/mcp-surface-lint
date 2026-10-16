import { isModelId, type ModelId } from "./config";

/**
 * Result keys. A key names exactly what an answer depends on, so an existing
 * key is an answer already paid for: "never pay twice" is a lookup.
 */
export function scenariosKey(slug: string, toolsHash: string, model: ModelId, promptVersion: number): string {
  return ["scenarios", slug, toolsHash, model, `p${promptVersion}`].join("|");
}

export function selectionKey(
  slug: string,
  toolsHash: string,
  model: ModelId,
  scenarioSet: number,
  promptVersion: number
): string {
  return ["selection", slug, toolsHash, model, `s${scenarioSet}`, `p${promptVersion}`].join("|");
}

export function reviewKey(slug: string, toolsHash: string, model: ModelId, promptVersion: number): string {
  return ["review", slug, toolsHash, model, `p${promptVersion}`].join("|");
}

/** A summary depends on the score as well as the surface: a rule change can move one without the other. */
export function summaryKey(
  slug: string,
  toolsHash: string,
  model: ModelId,
  composite: number,
  promptVersion: number
): string {
  return ["summary", slug, toolsHash, model, `c${composite}`, `p${promptVersion}`].join("|");
}

export type JobKind = "scenarios" | "selection" | "review" | "summary";

export interface ParsedKey {
  job: JobKind;
  slug: string;
  toolsHash: string;
  model: ModelId;
  /** Selection keys only. */
  scenarioSet?: number;
  /** Summary keys only. */
  composite?: number;
  promptVersion: number;
}

/** The inverse of the builders above, for routing a collected batch result back to its job. */
export function parseKey(key: string): ParsedKey | undefined {
  const parts = key.split("|");
  const version = (part: string | undefined, prefix: string) =>
    part?.startsWith(prefix) ? Number(part.slice(prefix.length)) : Number.NaN;
  const [job, slug, toolsHash, model] = parts;
  if (!slug || !toolsHash || !model || !isModelId(model)) return undefined;
  if ((job === "scenarios" || job === "review") && parts.length === 5) {
    const promptVersion = version(parts[4], "p");
    return Number.isInteger(promptVersion) ? { job, slug, toolsHash, model, promptVersion } : undefined;
  }
  if (job === "summary" && parts.length === 6) {
    const composite = version(parts[4], "c");
    const promptVersion = version(parts[5], "p");
    return Number.isInteger(composite) && Number.isInteger(promptVersion)
      ? { job, slug, toolsHash, model, composite, promptVersion }
      : undefined;
  }
  if (job === "selection" && parts.length === 6) {
    const scenarioSet = version(parts[4], "s");
    const promptVersion = version(parts[5], "p");
    return Number.isInteger(scenarioSet) && Number.isInteger(promptVersion)
      ? { job, slug, toolsHash, model, scenarioSet, promptVersion }
      : undefined;
  }
  return undefined;
}
