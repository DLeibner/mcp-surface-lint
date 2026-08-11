import type { ZodError } from "zod";

/**
 * Cursor (and some other hosts) expose installed-server tool dumps with
 * `tools[].tool` instead of the MCP `tools/list` field `tools[].name`.
 * Rewrite the alias before schema validation so both shapes lint the same.
 */
export function normalizeClientToolDump(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const root = raw as Record<string, unknown>;
  if (!Array.isArray(root.tools)) return raw;

  let changed = false;
  const tools = root.tools.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const tool = entry as Record<string, unknown>;
    const hasName = typeof tool.name === "string" && tool.name.length > 0;
    if (hasName) return entry;
    if (typeof tool.tool === "string" && tool.tool.length > 0) {
      changed = true;
      const { tool: alias, ...rest } = tool;
      return { ...rest, name: alias };
    }
    return entry;
  });

  return changed ? { ...root, tools } : raw;
}

export class SnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotValidationError";
  }
}

function toolEntryHint(entry: unknown, index: number): string | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return `tools[${index}] must be an object with a non-empty \`name\`.`;
  }
  const tool = entry as Record<string, unknown>;
  const hasName = typeof tool.name === "string" && tool.name.length > 0;
  const hasToolAlias = typeof tool.tool === "string" && tool.tool.length > 0;
  if (!hasName && !hasToolAlias) {
    return (
      `tools[${index}] is missing \`name\`. Each tool needs a non-empty \`name\` ` +
      `(Cursor-style dumps may use \`tool\` instead — that alias is accepted).`
    );
  }
  if (!hasName && hasToolAlias) {
    // Should be unreachable after normalizeClientToolDump, but keep a clear fallback.
    return `tools[${index}] has \`tool\` but no \`name\`; failed to normalize the Cursor alias.`;
  }
  return undefined;
}

/**
 * Turn a failed snapshot parse into a short, actionable message for agents and UI.
 * Prefers structural hints over raw Zod paths when the dump is clearly the wrong shape.
 */
export function describeSnapshotError(raw: unknown, zodError?: ZodError): string {
  if (raw === null || raw === undefined) {
    return "Expected a tools/list object with a `tools` array, got nothing.";
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return "Expected a tools/list object with a `tools` array, each entry having at least a `name`.";
  }

  const root = raw as Record<string, unknown>;
  if (!("tools" in root)) {
    return (
      "Missing `tools` array. Pass an MCP tools/list response, an mcplint snapshot, " +
      "or a client tool dump that includes `tools`."
    );
  }
  if (!Array.isArray(root.tools)) {
    return `\`tools\` must be an array (got ${typeof root.tools}).`;
  }

  for (let i = 0; i < root.tools.length; i++) {
    const hint = toolEntryHint(root.tools[i], i);
    if (hint) return hint;
  }

  const first = zodError?.issues[0];
  if (first) {
    const path = first.path.length > 0 ? first.path.join(".") : "(root)";
    return `Invalid snapshot at ${path}: ${first.message}. Expected tools/list with tools[].name (or Cursor-style tools[].tool).`;
  }

  return (
    "That doesn't look like a tools/list dump. Expected an object with a `tools` array, " +
    "each entry having at least a `name` (Cursor-style `tool` is accepted)."
  );
}
