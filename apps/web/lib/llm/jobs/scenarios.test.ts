import { describe, expect, it } from "vitest";
import { HAIKU } from "../config";
import { fakeMessage, textBlock, tool } from "../testing";
import { ScenarioError, parseScenarios, scenarioRequest } from "./scenarios";

const tools = [
  tool("search_hotels", "Search hotels by city and dates.", {
    city: { type: "string" },
    nights: { type: "integer" }
  }),
  tool("get_hotel", "Get one hotel by its id.", { hotelId: { type: "string" } })
];

function respond(scenarios: unknown[], stop: "end_turn" | "max_tokens" | "refusal" = "end_turn") {
  return fakeMessage([textBlock(JSON.stringify({ scenarios }))], stop);
}

function targeted(i: number, overrides: Record<string, unknown> = {}) {
  return {
    prompt: `Find me a hotel in city number ${i} for 3 nights.`,
    expected_tool: "search_hotels",
    expected_args: [
      { name: "city", value_json: `"City ${i}"` },
      { name: "nights", value_json: "3" }
    ],
    ...overrides
  };
}

const distractors = [
  { prompt: "Book me a flight to Rome.", expected_tool: null, expected_args: [] },
  { prompt: "What's the weather in Oslo?", expected_tool: null, expected_args: [] },
  { prompt: "Cancel my car rental.", expected_tool: null, expected_args: [{ name: "x", value_json: "1" }] }
];

describe("scenarioRequest", () => {
  it("asks Haiku for structured JSON whose expected tool can only be a real tool or null", () => {
    const request = scenarioRequest(tools);
    expect(request.model).toBe(HAIKU);
    expect(request.max_tokens).toBe(2_000);
    expect(request.thinking).toEqual({ type: "disabled" });
    const schema = request.output_config?.format?.schema as {
      properties: { scenarios: { items: { properties: { expected_tool: unknown } } } };
    };
    expect(schema.properties.scenarios.items.properties.expected_tool).toEqual({
      anyOf: [{ type: "string", enum: ["search_hotels", "get_hotel"] }, { type: "null" }]
    });
    expect(JSON.stringify(request.messages)).toContain("<tools>");
  });
});

describe("parseScenarios", () => {
  it("keeps a valid set, decodes stated arguments and numbers the scenarios", () => {
    const set = parseScenarios(respond([...Array.from({ length: 10 }, (_, i) => targeted(i)), ...distractors]), tools);
    expect(set).toHaveLength(13);
    expect(set[0]).toEqual({
      id: "s01",
      prompt: "Find me a hotel in city number 0 for 3 nights.",
      expected_tool: "search_hotels",
      expected_args: { city: "City 0", nights: 3 }
    });
    expect(set.filter((s) => s.expected_tool === null)).toHaveLength(3);
    // A distractor never carries arguments, whatever the model wrote.
    expect(set.at(-1)?.expected_args).toEqual({});
  });

  it("maps enum casing back, and drops unknown tools, undeclared arguments and duplicates", () => {
    const set = parseScenarios(
      respond([
        ...Array.from({ length: 9 }, (_, i) => targeted(i)),
        targeted(0),
        { prompt: "Show hotel H-1.", expected_tool: "GET_HOTEL", expected_args: [{ name: "hotelId", value_json: '"H-1"' }, { name: "bogus", value_json: "1" }] },
        { prompt: "Delete my account.", expected_tool: "delete_account", expected_args: [] },
        ...distractors
      ]),
      tools
    );
    expect(set).toHaveLength(13);
    const get = set.find((s) => s.expected_tool === "get_hotel");
    expect(get?.expected_args).toEqual({ hotelId: "H-1" });
    expect(set.some((s) => s.prompt === "Delete my account.")).toBe(false);
  });

  it("caps the set at 15 and keeps exactly three distractors", () => {
    const set = parseScenarios(
      respond([...Array.from({ length: 20 }, (_, i) => targeted(i)), ...distractors, distractors[0]!]),
      tools
    );
    expect(set).toHaveLength(15);
    expect(set.filter((s) => s.expected_tool === null)).toHaveLength(3);
  });

  it("rejects a set without its distractors or its breadth", () => {
    expect(() => parseScenarios(respond(Array.from({ length: 14 }, (_, i) => targeted(i))), tools)).toThrow(
      /distractor/
    );
    expect(() => parseScenarios(respond([targeted(1), ...distractors]), tools)).toThrow(/needs 12/);
  });

  it("rejects cut-off, refused and malformed responses", () => {
    expect(() => parseScenarios(respond([], "max_tokens"), tools)).toThrow(ScenarioError);
    expect(() => parseScenarios(respond([], "refusal"), tools)).toThrow(/declined/);
    expect(() => parseScenarios(fakeMessage([textBlock("not json")], "end_turn"), tools)).toThrow(/JSON/);
  });
});
