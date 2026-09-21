import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const severitySchema = z.enum(["info", "warn", "error"]);

const ruleSettingSchema = z.union([
  z.literal("off"),
  severitySchema,
  z.object({
    severity: severitySchema.optional(),
    options: z.record(z.unknown()).optional()
  })
]);

export const configSchema = z.object({
  rules: z.record(ruleSettingSchema).default({}),
  failUnder: z.number().min(0).max(100).optional()
});

export type SurfaceLintConfig = z.infer<typeof configSchema>;
/** @deprecated Renamed to {@link SurfaceLintConfig}. Kept so the 0.3 type name still resolves. */
export type McplintConfig = SurfaceLintConfig;
export type RuleSetting = z.infer<typeof ruleSettingSchema>;

export class ConfigLoader {
  static readonly defaultFileName = ".mcp-surface-lintrc.json";

  /**
   * Searched in order. The legacy name stays supported indefinitely — a rename
   * of the tool should not silently drop a project's existing thresholds.
   */
  static readonly fileNames = [ConfigLoader.defaultFileName, ".mcplintrc.json"];

  static empty(): SurfaceLintConfig {
    return configSchema.parse({});
  }

  static async load(explicitPath?: string, cwd = process.cwd()): Promise<SurfaceLintConfig> {
    if (explicitPath) return this.read(explicitPath);
    for (const name of this.fileNames) {
      const path = resolve(cwd, name);
      if (await this.exists(path)) return this.read(path);
    }
    return this.empty();
  }

  private static async read(path: string): Promise<SurfaceLintConfig> {
    return configSchema.parse(JSON.parse(await readFile(path, "utf8")));
  }

  private static async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
}
