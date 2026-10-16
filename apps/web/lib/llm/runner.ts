import Anthropic from "@anthropic-ai/sdk";
import { loadResult, loadSeeds } from "../directory/data";
import type { ScanResult, Seed } from "../directory/types";
import { cycleWindow, exhaustedEventKey } from "./budget";
import { errorMessage, isCreditExhausted, type EvalClient } from "./client";
import type { ModelId } from "./config";
import { countFootprint } from "./footprint";
import type { LlmLedger } from "./ledger";
import { readEvalFile, writeEvalFile } from "./results";
import { loadSurface, toApiSurface, type Surface } from "./surface";

export interface RunOptions {
  /** Absent in a dry run: nothing is sent to the API. */
  client?: EvalClient;
  ledger: LlmLedger;
  now: Date;
  /** Limit the run to these slugs. */
  only?: ReadonlySet<string>;
  log: (line: string) => void;
}

/** A directory server the layer can work on: it has a captured surface. */
export interface EvalTarget {
  seed: Seed;
  surface: Surface;
  scan?: ScanResult;
}

export function evalTargets(only?: ReadonlySet<string>): EvalTarget[] {
  return loadSeeds().flatMap((seed) => {
    if (only && !only.has(seed.slug)) return [];
    const surface = loadSurface(seed.slug);
    return surface ? [{ seed, surface, scan: loadResult(seed.slug) }] : [];
  });
}

export type FootprintOutcome = "counted" | "current" | "rejected" | "failed" | "planned";

export interface RunReport {
  footprints: { slug: string; outcome: FootprintOutcome; detail?: string }[];
  /** Paths under data/evals that this run rewrote. */
  written: string[];
  /** The API said the credit is gone; the run stopped spending. */
  exhausted: boolean;
}

/** Records that the credit ran out, once per cycle. Nothing spends again until it refreshes. */
async function markExhausted(options: RunOptions, report: RunReport): Promise<void> {
  report.exhausted = true;
  await options.ledger.claimEvent(exhaustedEventKey(cycleWindow(options.now)), "credit-exhausted", {
    at: options.now.toISOString()
  });
}

/**
 * Per-model token counts through `count_tokens`, refreshed whenever the
 * surface changed since the last count. The endpoint is free, so it is not
 * budget-gated; a surface the API rejects is recorded as such rather than
 * retried forever.
 */
async function refreshFootprints(
  targets: EvalTarget[],
  options: RunOptions,
  report: RunReport
): Promise<void> {
  const baselines = new Map<ModelId, number>();
  let blocked = false;
  for (const { seed, surface } of targets) {
    const slug = seed.slug;
    if (readEvalFile(slug, "footprint")?.tools_hash === surface.toolsHash) {
      report.footprints.push({ slug, outcome: "current" });
      continue;
    }
    if (!options.client || blocked) {
      report.footprints.push({ slug, outcome: "planned" });
      continue;
    }

    let models: Record<string, number> = {};
    let error: string | null = null;
    try {
      models = await countFootprint(options.client, toApiSurface(surface.tools).tools, baselines);
    } catch (caught) {
      if (isCreditExhausted(caught)) {
        blocked = true;
        await markExhausted(options, report);
        report.footprints.push({ slug, outcome: "planned", detail: "credit exhausted" });
        continue;
      }
      if (!(caught instanceof Anthropic.BadRequestError)) {
        // Transient: try again next run rather than publish an error.
        report.footprints.push({ slug, outcome: "failed", detail: errorMessage(caught) });
        continue;
      }
      error = errorMessage(caught);
    }

    const written = writeEvalFile(slug, "footprint", {
      slug,
      tools_hash: surface.toolsHash,
      counted_at: options.now.toISOString(),
      models,
      error
    });
    if (written) report.written.push(`data/evals/${slug}/footprint.json`);
    report.footprints.push(
      error ? { slug, outcome: "rejected", detail: error } : { slug, outcome: "counted" }
    );
  }
}

export async function runEvals(options: RunOptions): Promise<RunReport> {
  const report: RunReport = { footprints: [], written: [], exhausted: false };
  if (await options.ledger.hasEvent(exhaustedEventKey(cycleWindow(options.now)))) {
    report.exhausted = true;
  }
  const targets = evalTargets(options.only);
  options.log(`${targets.length} server(s) with a captured surface.`);
  await refreshFootprints(targets, options, report);
  return report;
}
