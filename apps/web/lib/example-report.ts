import {
  ConfigLoader,
  LintEngine,
  RuleRegistry,
  SnapshotLoader,
  type LintReport
} from "mcp-surface-lint";
import exampleSnapshot from "../fixtures/example-server.json";
import { EXAMPLE_REPORT_PATH } from "./example-report-path";

let cached: LintReport | undefined;

/**
 * Deterministic audit of the checked-in example snapshot. No database row, no
 * owner cookie — always available for LinkedIn posts and first-time visitors.
 */
export function getExampleReport(): LintReport {
  if (cached) return cached;

  const snapshot = SnapshotLoader.fromJson(exampleSnapshot, "file");
  cached = new LintEngine(RuleRegistry.all(), ConfigLoader.empty()).run(snapshot);
  return cached;
}

export { EXAMPLE_REPORT_PATH };
