import { describe, expect, it } from "vitest";
import { HAIKU, OPUS, SONNET } from "../config";
import { toApiSurface } from "../surface";
import { fakeMessage, textBlock, tool, toolUseBlock } from "../testing";
import type { Scenario } from "./scenarios";
import { ArgumentChecker, gradeSelection, sameValue, selectionRequest, summariseSelection } from "./selection";

const api = toApiSurface([
  tool("search_hotels", "Search hotels.", { city: { type: "string" }, nights: { type: "integer" } }),
  tool("get_hotel", "Get one hotel.", { hotelId: { type: "string" } }),
  { name: "geo.lookup", description: "Geocode.", inputSchema: { type: "object", properties: { q: { type: "string" } } } }
]);
const checker = () => new ArgumentChecker(api.schemas);

const search: Scenario = {
  id: "s01",
  prompt: "Hotels in Paris for 3 nights",
  expected_tool: "search_hotels",
  expected_args: { city: "Paris", nights: 3 }
};
const distractor: Scenario = { id: "s02", prompt: "Book a flight", expected_tool: null, expected_args: {} };

describe("selectionRequest", () => {
  it("sends the surface as a client would, with tools and system as the cached prefix", () => {
    const request = selectionRequest(api, search, SONNET, "standard");
    expect(request.tool_choice).toEqual({ type: "auto" });
    expect(request.tools?.map((t) => ("name" in t ? t.name : t))).toEqual(["search_hotels", "get_hotel", "geo_lookup"]);
    expect(request.messages).toEqual([{ role: "user", content: search.prompt }]);
    expect(request.system).toMatchObject([{ cache_control: { type: "ephemeral" } }]);
    expect(selectionRequest(api, search, SONNET, "batch").system).toMatchObject([
      { cache_control: { type: "ephemeral", ttl: "1h" } }
    ]);
  });

  it("uses each model's lowest thinking setting and caps output", () => {
    expect(selectionRequest(api, search, HAIKU, "standard")).toMatchObject({ max_tokens: 200, thinking: { type: "disabled" } });
    expect(selectionRequest(api, search, SONNET, "standard")).toMatchObject({ max_tokens: 200, thinking: { type: "between_tools" } });
    expect(selectionRequest(api, search, OPUS, "standard")).toMatchObject({ max_tokens: 1_024, thinking: { type: "adaptive" } });
  });
});

describe("gradeSelection", () => {
  it("credits the right tool and checks its arguments loosely", () => {
    const outcome = gradeSelection(
      search,
      fakeMessage([textBlock("Searching."), toolUseBlock("search_hotels", { city: " paris ", nights: "3" })], "tool_use"),
      api,
      checker()
    );
    expect(outcome).toEqual({
      id: "s01",
      called: ["search_hotels"],
      stop: "tool_use",
      correct: true,
      // "3" is not an integer, so the schema check fails even though the value matches.
      args_valid: false,
      args_match: true
    });
  });

  it("maps renamed tools back to their MCP names", () => {
    const geo: Scenario = { id: "s03", prompt: "Where is Baker Street?", expected_tool: "geo.lookup", expected_args: {} };
    const outcome = gradeSelection(geo, fakeMessage([toolUseBlock("geo_lookup", { q: "Baker Street" })], "tool_use"), api, checker());
    expect(outcome).toMatchObject({ called: ["geo.lookup"], correct: true, args_valid: true, args_match: null });
  });

  it("marks the wrong tool, a missed call and a distractor false positive", () => {
    const wrong = gradeSelection(search, fakeMessage([toolUseBlock("get_hotel", { hotelId: "x" })], "tool_use"), api, checker());
    expect(wrong).toMatchObject({ correct: false, args_valid: true, args_match: null });
    const none = gradeSelection(search, fakeMessage([textBlock("Which dates?")], "end_turn"), api, checker());
    expect(none).toMatchObject({ called: [], stop: "no_tool", correct: false, args_valid: null });
    const fp = gradeSelection(distractor, fakeMessage([toolUseBlock("search_hotels", {})], "tool_use"), api, checker());
    expect(fp).toMatchObject({ correct: false });
    const ok = gradeSelection(distractor, fakeMessage([textBlock("I can't book flights.")], "end_turn"), api, checker());
    expect(ok).toMatchObject({ correct: true, stop: "no_tool" });
  });

  it("leaves truncated and refused answers ungraded", () => {
    expect(gradeSelection(search, fakeMessage([], "max_tokens"), api, checker())).toMatchObject({ stop: "truncated", correct: null });
    expect(gradeSelection(search, fakeMessage([], "refusal"), api, checker())).toMatchObject({ stop: "refused", correct: null });
  });
});

describe("sameValue", () => {
  it("ignores case, spacing, key order and number-as-string", () => {
    expect(sameValue("New  York", "new york")).toBe(true);
    expect(sameValue(3, "3")).toBe(true);
    expect(sameValue({ a: 1, b: ["X"] }, { b: ["x"], a: 1 })).toBe(true);
    expect(sameValue("Paris", "Paris, France")).toBe(false);
    expect(sameValue("Paris", undefined)).toBe(false);
  });
});

describe("summariseSelection", () => {
  it("computes each rate over the scenarios it applies to and lists confused pairs", () => {
    const scenarios: Scenario[] = [
      search,
      { ...search, id: "s03" },
      { ...search, id: "s04", expected_tool: "get_hotel", expected_args: {} },
      { ...search, id: "s05" },
      distractor,
      { ...distractor, id: "s06" }
    ];
    const outcomes = [
      { id: "s01", called: ["search_hotels"], stop: "tool_use" as const, correct: true, args_valid: true, args_match: true },
      { id: "s03", called: ["get_hotel"], stop: "tool_use" as const, correct: false, args_valid: true, args_match: null },
      { id: "s04", called: [], stop: "no_tool" as const, correct: false, args_valid: null, args_match: null },
      { id: "s05", called: [], stop: "truncated" as const, correct: null, args_valid: null, args_match: null },
      { id: "s02", called: ["search_hotels"], stop: "tool_use" as const, correct: false, args_valid: false, args_match: null },
      { id: "s06", called: [], stop: "no_tool" as const, correct: true, args_valid: null, args_match: null }
    ];
    const { metrics, confused_pairs } = summariseSelection(scenarios, outcomes);
    expect(metrics).toEqual({
      scenarios: 6,
      targeted: 4,
      distractors: 2,
      graded: 5,
      selection_accuracy: 0.333,
      distractor_false_positive_rate: 0.5,
      no_call_rate: 0.333,
      argument_validity: 0.667,
      expected_args_match: 1,
      truncated: 1,
      refused: 0,
      errored: 0
    });
    expect(confused_pairs).toEqual([{ expected: "search_hotels", actual: "get_hotel", count: 1 }]);
  });
});
