import type { ModelId } from "./config";

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
