import {
  ConfigLoader,
  LintEngine,
  McpCapture,
  RuleRegistry,
  SnapshotLoader,
  SnapshotValidationError,
  type LintReport,
  type ServerSnapshot,
  type Tier
} from "mcp-surface-lint";
import { z } from "zod";
import { humanizeCaptureError } from "./capture-error";
import { createGuardedFetch } from "./guarded-fetch";

export const MAX_TOOLS = 500;
export const MAX_PAGES = 20;
export const CAPTURE_TIMEOUT_MS = 20_000;

export const lintRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("paste"), snapshot: z.unknown() }),
  z.object({
    mode: z.literal("url"),
    url: z.string().trim().url(),
    headers: z.record(z.string()).optional()
  })
]);

export type LintRequest = z.infer<typeof lintRequestSchema>;

/**
 * The entitlement tier for a run. Hardcoded open in v1 — every user gets the
 * full audit for free. Flipping `GATE_FINDINGS` to "true" is the entire change
 * required to withhold findings behind a paywall; see `projectReport` in core.
 */
export function currentTier(): Tier {
  return process.env.GATE_FINDINGS === "true" ? "free" : "full";
}

export class LintError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid_snapshot" | "capture_failed" | "too_large"
  ) {
    super(message);
    this.name = "LintError";
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LintError(label, "capture_failed")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function buildSnapshot(request: LintRequest): Promise<ServerSnapshot> {
  if (request.mode === "paste") {
    let snapshot: ServerSnapshot;
    try {
      snapshot = SnapshotLoader.fromJson(request.snapshot, "file");
    } catch (error) {
      const message =
        error instanceof SnapshotValidationError
          ? error.message
          : "That doesn't look like a tools/list dump. Expected an object with a `tools` array, " +
            "each entry having at least a `name` (Cursor-style `tool` is accepted).";
      throw new LintError(message, "invalid_snapshot");
    }
    if (snapshot.tools.length > MAX_TOOLS) {
      throw new LintError(`Snapshots are limited to ${MAX_TOOLS} tools.`, "too_large");
    }
    return snapshot;
  }

  try {
    return await withTimeout(
      McpCapture.fromHttp(request.url, {
        fetch: createGuardedFetch(),
        headers: request.headers,
        maxTools: MAX_TOOLS,
        maxPages: MAX_PAGES
      }),
      CAPTURE_TIMEOUT_MS,
      `The server did not respond within ${CAPTURE_TIMEOUT_MS / 1000}s.`
    );
  } catch (error) {
    if (error instanceof LintError) throw error;
    throw new LintError(humanizeCaptureError(error), "capture_failed");
  }
}

export interface LintResult {
  snapshot: ServerSnapshot;
  report: LintReport;
  durationMs: number;
}

export async function runLint(request: LintRequest): Promise<LintResult> {
  const started = Date.now();
  const snapshot = await buildSnapshot(request);
  const report = new LintEngine(RuleRegistry.all(), ConfigLoader.empty()).run(snapshot);
  return {
    snapshot,
    report,
    durationMs: Date.now() - started
  };
}
