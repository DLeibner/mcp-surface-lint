import { describe, expect, it } from "vitest";
import { EXAMPLE_REPORT_PATH } from "./example-report-path";
import { getExampleReport } from "./example-report";

describe("example report", () => {
  it("audits the checked-in snapshot with multiple findings", () => {
    const report = getExampleReport();

    expect(report.server.name).toBe("example-catalog");
    expect(report.stats.toolCount).toBeGreaterThan(10);
    expect(report.findings.length).toBeGreaterThan(5);
    expect(report.scores.composite).toBeLessThan(100);
  });

  it("uses a stable public URL path", () => {
    expect(EXAMPLE_REPORT_PATH).toBe("/example");
  });
});
