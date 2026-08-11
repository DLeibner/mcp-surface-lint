import { describe, expect, it } from "vitest";
import {
  SnapshotLoader,
  SnapshotValidationError
} from "../src/ingest/index.js";
import { Scorer } from "../src/scoring.js";
import { projectReport, countFindings } from "../src/project.js";
import { LintEngine } from "../src/engine.js";
import { ConfigLoader } from "../src/config.js";
import { RuleRegistry } from "../src/rules/index.js";
import { DesignCrudMirror } from "../src/rules/design-crud-mirror.js";
import { Docs } from "../src/rules/docs.js";
import { Fixture } from "./helpers.js";

describe("SnapshotLoader.fromJson", () => {
  it("builds a snapshot from an in-memory tools/list dump", () => {
    const snapshot = SnapshotLoader.fromJson({
      serverInfo: { name: "acme", version: "1.2.3" },
      tools: [{ name: "search_hotels", description: "Search for hotels." }],
      capturedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(snapshot.serverInfo).toEqual({ name: "acme", version: "1.2.3" });
    expect(snapshot.tools).toHaveLength(1);
    expect(snapshot.capturedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(snapshot.source).toBe("file");
  });

  it("accepts Cursor-style dumps that use tools[].tool instead of name", () => {
    const snapshot = SnapshotLoader.fromJson({
      mode: "server",
      server: "user-playwright",
      tools: [
        {
          tool: "browser_navigate",
          description: "Navigate to a URL",
          inputSchema: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"]
          }
        }
      ]
    });
    expect(snapshot.tools).toEqual([
      expect.objectContaining({
        name: "browser_navigate",
        description: "Navigate to a URL"
      })
    ]);
    expect(snapshot.tools[0]).not.toHaveProperty("tool");
  });

  it("prefers name when both name and tool are present", () => {
    const snapshot = SnapshotLoader.fromJson({
      tools: [{ name: "canonical", tool: "alias", description: "Keep the MCP name." }]
    });
    expect(snapshot.tools[0]?.name).toBe("canonical");
  });

  it("stamps capturedAt when the dump omits it, and honours the source override", () => {
    const snapshot = SnapshotLoader.fromJson({ tools: [] }, "http");
    expect(snapshot.source).toBe("http");
    expect(Date.parse(snapshot.capturedAt)).not.toBeNaN();
  });

  it("rejects malformed input with actionable messages", () => {
    expect(() => SnapshotLoader.fromJson({ tools: "nope" })).toThrow(SnapshotValidationError);
    expect(() => SnapshotLoader.fromJson({ tools: "nope" })).toThrow(/tools` must be an array/);
    expect(() => SnapshotLoader.fromJson({ tools: [{ description: "no name" }] })).toThrow(
      /tools\[0\] is missing `name`/
    );
    expect(() => SnapshotLoader.fromJson({ tools: [{ description: "no name" }] })).toThrow(
      /Cursor-style/
    );
    expect(() => SnapshotLoader.fromJson({ foo: 1 })).toThrow(/Missing `tools` array/);
    expect(() => SnapshotLoader.fromJson(null)).toThrow(SnapshotValidationError);
    expect(() => SnapshotLoader.fromJson(null)).toThrow(/got nothing/);
  });
});

describe("Scorer.grade", () => {
  it("maps composites to letters at the boundaries", () => {
    expect(Scorer.grade(100)).toBe("A");
    expect(Scorer.grade(90)).toBe("A");
    expect(Scorer.grade(89)).toBe("B");
    expect(Scorer.grade(80)).toBe("B");
    expect(Scorer.grade(79)).toBe("C");
    expect(Scorer.grade(70)).toBe("C");
    expect(Scorer.grade(69)).toBe("D");
    expect(Scorer.grade(60)).toBe("D");
    expect(Scorer.grade(59)).toBe("F");
    expect(Scorer.grade(0)).toBe("F");
  });
});

describe("projectReport", () => {
  const report = new LintEngine(RuleRegistry.all(), ConfigLoader.empty()).run(
    Fixture.snapshot([
      Fixture.tool({ name: "a_thing", description: "" }),
      Fixture.tool({ name: "b_thing", description: "short" })
    ])
  );

  it("returns the report untouched for the full tier", () => {
    expect(projectReport(report, "full")).toBe(report);
  });

  it("withholds findings but keeps scores and stats for the free tier", () => {
    const gated = projectReport(report, "free");
    expect(gated).not.toHaveProperty("findings");
    expect(gated.scores).toEqual(report.scores);
    expect(gated.stats).toEqual(report.stats);
    expect("gated" in gated && gated.gated).toBe(true);
  });

  it("counts every finding it withholds", () => {
    const counts = countFindings(report.findings);
    const total = Object.values(counts.bySeverity).reduce((a, b) => a + b, 0);
    expect(total).toBe(report.findings.length);
    expect(Object.values(counts.byCategory).reduce((a, b) => a + b, 0)).toBe(
      report.findings.length
    );
  });
});

describe("Docs", () => {
  it("anchors rule links on a slug the web catalogue can match", () => {
    expect(Docs.slug("design/crud-mirror")).toBe("design-crud-mirror");
    expect(Docs.rule("design/crud-mirror")).toBe(
      process.env.MCPLINT_DOCS_BASE ? `${Docs.base}#design-crud-mirror` : Docs.base
    );
  });
});

describe("design/crud-mirror singularizer", () => {
  const rule = new DesignCrudMirror();

  it("does not strip the trailing s from double-s nouns", () => {
    // get_access / update_access / delete_access is a genuine CRUD family over
    // "access" — it must not be keyed under the mangled noun "acces".
    const findings = rule.check(
      Fixture.snapshot([
        Fixture.tool({ name: "get_access" }),
        Fixture.tool({ name: "update_access" }),
        Fixture.tool({ name: "delete_access" })
      ])
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('CRUD mirror over "access"');
  });

  it("still singularizes ordinary plurals so they group with their singular", () => {
    const findings = rule.check(
      Fixture.snapshot([
        Fixture.tool({ name: "list_hotels" }),
        Fixture.tool({ name: "create_hotel" }),
        Fixture.tool({ name: "delete_hotel" })
      ])
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('CRUD mirror over "hotel"');
  });
});
