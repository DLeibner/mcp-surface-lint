import { existsSync, readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { SnapshotLoader, type JsonSchema, type ToolDef } from "mcp-surface-lint";
import { resultPath } from "../directory/data";

/** A server's tool surface as the scanner last captured it. */
export interface Surface {
  slug: string;
  /** The scanner's `snapshot_hash`: the `tools_hash` in every result key. */
  toolsHash: string;
  tools: ToolDef[];
}

/** Reads data/results/{slug}/snapshot.json, written by scripts/scan.mjs. */
export function loadSurface(slug: string): Surface | undefined {
  const file = resultPath(slug, "snapshot.json");
  if (!existsSync(file)) return undefined;
  const raw = JSON.parse(readFileSync(file, "utf8")) as { snapshot_hash?: unknown };
  if (typeof raw.snapshot_hash !== "string") {
    throw new Error(`data/results/${slug}/snapshot.json has no snapshot_hash.`);
  }
  return { slug, toolsHash: raw.snapshot_hash, tools: SnapshotLoader.fromJson(raw, "file").tools };
}

const API_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** The surface in the shape the Messages API takes, with the way back to MCP names. */
export interface ApiSurface {
  tools: Anthropic.Tool[];
  /** API tool name → MCP tool name. */
  mcpName: Map<string, string>;
  /** MCP tool name → the input schema the API was given, for checking arguments. */
  schemas: Map<string, Record<string, unknown>>;
}

function apiName(name: string, taken: Set<string>): string {
  if (API_NAME.test(name) && !taken.has(name)) return name;
  const base = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) {
    const suffix = `_${n}`;
    candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
  }
  return candidate;
}

function inputSchema(schema: JsonSchema | undefined): Record<string, unknown> {
  if (!schema) return { type: "object", properties: {} };
  return schema.type === "object" ? schema : { ...schema, type: "object" };
}

/**
 * Converts MCP tool definitions the way an MCP client does before calling the
 * API: name, description and input schema, nothing else. Names the API would
 * reject (dots, slashes, more than 64 characters) are rewritten as clients
 * rewrite them, and `mcpName` maps every API name back.
 */
export function toApiSurface(tools: readonly ToolDef[]): ApiSurface {
  const taken = new Set<string>();
  const mcpName = new Map<string, string>();
  const schemas = new Map<string, Record<string, unknown>>();
  const apiTools = tools.map((tool): Anthropic.Tool => {
    const name = apiName(tool.name, taken);
    taken.add(name);
    mcpName.set(name, tool.name);
    const schema = inputSchema(tool.inputSchema);
    schemas.set(tool.name, schema);
    return {
      name,
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: schema as Anthropic.Tool.InputSchema
    };
  });
  return { tools: apiTools, mcpName, schemas };
}

/** FNV-1a: stable across processes, so a sample does not change between runs. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * A deterministic sample of an oversized surface. Seeded by the surface's own
 * hash, so the same surface always yields the same sample and a changed one
 * gets a fresh draw. Original order is kept, as the model would see it.
 */
export function sampleTools(tools: readonly ToolDef[], seed: string, size: number): ToolDef[] {
  if (tools.length <= size) return [...tools];
  const chosen = new Set(
    [...tools]
      .sort((a, b) => fnv1a(`${seed}:${a.name}`) - fnv1a(`${seed}:${b.name}`) || a.name.localeCompare(b.name))
      .slice(0, size)
      .map((tool) => tool.name)
  );
  return tools.filter((tool) => chosen.has(tool.name));
}
