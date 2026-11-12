import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { GENERATION_SETTINGS, MODELS, SCENARIO_MODEL, SELECTION_SETTINGS, SONNET, TIERS, TIER_POLICY } from "./config";

const scanWorkflow = readFileSync(path.resolve(process.cwd(), "../../.github/workflows/scan.yml"), "utf8");

/** The cron → tiers mapping in scan.yml's Scan step, e.g. `"25 * * * *") tiers="paid,showcase"`. */
function scheduledTiers(): Map<string, string[]> {
  const mapping = new Map<string, string[]>();
  for (const [, cron, tiers] of scanWorkflow.matchAll(/"([^"]+)"\) tiers="([a-z,]*)"/g)) {
    mapping.set(cron!, tiers!.split(",").filter(Boolean));
  }
  return mapping;
}

describe("tier policy", () => {
  it("is what scan.yml's schedules enforce", () => {
    const workflow = parse(scanWorkflow) as { on: { schedule: { cron: string }[] } };
    const crons = workflow.on.schedule.map((entry) => entry.cron);
    const mapping = scheduledTiers();
    const hourly = crons.find((cron) => cron.startsWith("25 ") && cron.endsWith("* * * *"))!;
    const daily = crons.find((cron) => /^\d+ \d+ \* \* \*$/.test(cron))!;

    // Every schedule but the weekly full scan names its tiers, and only those tiers.
    expect([...mapping.keys()].sort()).toEqual([daily, hourly].sort());
    for (const tier of TIERS) {
      const probes = TIER_POLICY[tier].probes;
      expect(mapping.get(hourly)!.includes(tier), `${tier} hourly`).toBe(probes === "hourly");
      expect(mapping.get(daily)!.includes(tier), `${tier} daily`).toBe(probes !== "weekly");
    }
  });

  it("publishes every model it runs except on unclaimed servers, where only Sonnet is shown", () => {
    expect(TIER_POLICY.directory.publicModels).toEqual([SONNET]);
    for (const tier of TIERS) {
      for (const plan of TIER_POLICY[tier].selection) {
        expect(TIER_POLICY[tier].publicModels, `${tier} ${plan.model}`).toContain(plan.model);
      }
    }
  });

  it("has request settings for every model it can call", () => {
    for (const model of MODELS) {
      expect(SELECTION_SETTINGS[model].maxTokens).toBeGreaterThan(0);
      expect(GENERATION_SETTINGS[model].maxTokens).toBeGreaterThan(0);
    }
    // Only Sonnet 5.5 accepts between_tools; only Opus 5.5 cannot disable thinking.
    for (const settings of [SELECTION_SETTINGS, GENERATION_SETTINGS]) {
      for (const [model, { thinking }] of Object.entries(settings)) {
        if (thinking === "between_tools") expect(model).toBe(SONNET);
      }
    }
    expect(SCENARIO_MODEL).toBe("claude-haiku-5-5");
  });
});
