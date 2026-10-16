import { describe, expect, it } from "vitest";
import { HAIKU, SONNET } from "../config";
import { fakeMessage, textBlock, tool } from "../testing";
import { parseReview, reviewRequest } from "./review";

const tools = [
  tool("search_hotels", "Search hotels.", { city: { type: "string" }, q: { type: "string" } }),
  tool("find_hotels", "Find hotels."),
  tool("delete_list", "Returns a list.")
];

const answer = (findings: unknown[]) => fakeMessage([textBlock(JSON.stringify({ findings }))], "end_turn");

describe("reviewRequest", () => {
  it("constrains kinds and tool names, and uses the tier's model", () => {
    const request = reviewRequest(tools, SONNET);
    expect(request.model).toBe(SONNET);
    const items = (request.output_config?.format?.schema as any).properties.findings.items.properties;
    expect(items.kind.enum).toEqual([
      "overlapping-tools",
      "vague-description",
      "undocumented-parameter",
      "name-description-mismatch"
    ]);
    expect(items.tools.items.enum).toEqual(["search_hotels", "find_hotels", "delete_list"]);
    expect(reviewRequest(tools, HAIKU).max_tokens).toBe(2_000);
  });
});

describe("parseReview", () => {
  it("maps each kind to its closest rule, or to none", () => {
    const findings = parseReview(
      answer([
        { kind: "overlapping-tools", tools: ["search_hotels", "FIND_HOTELS"], parameter: null, explanation: "Both search the same catalogue with no way to tell them apart." },
        { kind: "undocumented-parameter", tools: ["search_hotels"], parameter: "q", explanation: "Nothing says whether q is free text or a filter expression." },
        { kind: "name-description-mismatch", tools: ["delete_list"], parameter: null, explanation: "The name says delete but the description says it returns a list." }
      ]),
      tools
    );
    expect(findings).toEqual([
      { kind: "overlapping-tools", rule_id: "design/overlap-cluster", tools: ["search_hotels", "find_hotels"], parameter: null, explanation: "Both search the same catalogue with no way to tell them apart." },
      { kind: "undocumented-parameter", rule_id: "schemas/param-desc-missing", tools: ["search_hotels"], parameter: "q", explanation: "Nothing says whether q is free text or a filter expression." },
      { kind: "name-description-mismatch", rule_id: null, tools: ["delete_list"], parameter: null, explanation: "The name says delete but the description says it returns a list." }
    ]);
  });

  it("drops findings that do not point at real tools and parameters, and duplicates", () => {
    const findings = parseReview(
      answer([
        { kind: "overlapping-tools", tools: ["search_hotels"], parameter: null, explanation: "Overlaps with itself, apparently." },
        { kind: "vague-description", tools: ["no_such_tool"], parameter: null, explanation: "Says nothing useful at all." },
        { kind: "undocumented-parameter", tools: ["search_hotels"], parameter: "missing", explanation: "This parameter does not exist." },
        { kind: "vague-description", tools: ["find_hotels"], parameter: null, explanation: "Short." },
        { kind: "vague-description", tools: ["find_hotels"], parameter: null, explanation: "Find hotels how, by what, returning what?" },
        { kind: "vague-description", tools: ["find_hotels"], parameter: null, explanation: "Duplicate of the finding above, worded differently." },
        { kind: "praise", tools: ["find_hotels"], parameter: null, explanation: "Great tool, five stars." }
      ]),
      tools
    );
    expect(findings.map((f) => [f.kind, f.tools])).toEqual([["vague-description", ["find_hotels"]]]);
  });

  it("strips links from what the model wrote, since it will be published", () => {
    const [finding] = parseReview(
      answer([
        {
          kind: "vague-description",
          tools: ["find_hotels"],
          parameter: null,
          explanation: "Unclear — see https://evil.example/x and   www.spam.example for `details`."
        }
      ]),
      tools
    );
    expect(finding?.explanation).toBe("Unclear — see and for details.");
  });

  it("caps the list at twelve and rejects a cut-off answer", () => {
    const wide = Array.from({ length: 20 }, (_, i) => tool(`tool_${i}`, "Does a thing."));
    const many = wide.map((t, i) => ({
      kind: "vague-description",
      tools: [t.name],
      parameter: null,
      explanation: `Finding number ${i} about this tool.`
    }));
    expect(parseReview(answer(many), wide)).toHaveLength(12);
    expect(() => parseReview(fakeMessage([], "max_tokens"), tools)).toThrow(/cut off/);
  });
});
