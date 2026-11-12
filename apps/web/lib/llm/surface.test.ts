import { describe, expect, it } from "vitest";
import { sampleTools, toApiSurface } from "./surface";
import { tool } from "./testing";

describe("toApiSurface", () => {
  it("passes valid tools through as name, description and input schema", () => {
    const surface = toApiSurface([tool("search_hotels", "Search hotels.", { city: { type: "string" } })]);
    expect(surface.tools).toEqual([
      {
        name: "search_hotels",
        description: "Search hotels.",
        input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
      }
    ]);
    expect(surface.mcpName.get("search_hotels")).toBe("search_hotels");
  });

  it("renames what the API would reject and maps it back", () => {
    const long = "x".repeat(70);
    const surface = toApiSurface([
      { name: "github.create_issue" },
      { name: "github/create_issue" },
      { name: long }
    ]);
    const names = surface.tools.map((t) => t.name);
    expect(names).toEqual(["github_create_issue", "github_create_issue_2", "x".repeat(64)]);
    expect(surface.mcpName.get("github_create_issue_2")).toBe("github/create_issue");
    expect(surface.mcpName.get("x".repeat(64))).toBe(long);
  });

  it("always hands the API an object schema", () => {
    const surface = toApiSurface([{ name: "ping" }, { name: "odd", inputSchema: { properties: {} } }]);
    expect(surface.tools[0]?.input_schema).toEqual({ type: "object", properties: {} });
    expect(surface.tools[1]?.input_schema).toEqual({ type: "object", properties: {} });
    expect(surface.schemas.get("odd")).toEqual({ type: "object", properties: {} });
  });
});

describe("sampleTools", () => {
  const tools = Array.from({ length: 40 }, (_, i) => tool(`tool_${String(i).padStart(2, "0")}`, "A tool."));

  it("draws the same sample from the same surface, in surface order", () => {
    const a = sampleTools(tools, "sha256:abc", 25);
    const b = sampleTools([...tools].reverse(), "sha256:abc", 25).reverse();
    expect(a).toHaveLength(25);
    expect(a.map((t) => t.name)).toEqual(b.map((t) => t.name));
    expect(a.map((t) => t.name)).toEqual([...a.map((t) => t.name)].sort());
  });

  it("draws afresh for a changed surface and keeps small surfaces whole", () => {
    expect(sampleTools(tools, "sha256:abc", 25)).not.toEqual(sampleTools(tools, "sha256:def", 25));
    expect(sampleTools(tools.slice(0, 10), "sha256:abc", 25)).toHaveLength(10);
  });
});
