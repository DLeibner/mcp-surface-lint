import { describe, expect, it, vi } from "vitest";
import { rankByViews } from "./views";

const slugs = ["alpha", "beta", "gamma", "delta"];
const env = { POSTHOG_PERSONAL_API_KEY: "phx_x", POSTHOG_PROJECT_ID: "123" };

describe("rankByViews", () => {
  it("keeps the given order without PostHog credentials", async () => {
    const fetchImpl = vi.fn();
    expect(await rankByViews(slugs, () => {}, {}, fetchImpl)).toEqual(slugs);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("orders by 30-day pageviews, folding trailing slashes and leaving unread pages in place", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        results: [
          ["/servers/gamma", 40],
          ["/servers/beta", 10],
          ["/servers/beta/", 5],
          ["/servers", 99]
        ]
      })
    );
    expect(await rankByViews(slugs, () => {}, env, fetchImpl as unknown as typeof fetch)).toEqual([
      "gamma",
      "beta",
      "alpha",
      "delta"
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://us.posthog.com/api/projects/123/query/");
    expect(JSON.parse(String(init.body)).query.kind).toBe("HogQLQuery");
  });

  it("falls back to the given order when the query fails", async () => {
    const lines: string[] = [];
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 }));
    expect(await rankByViews(slugs, (line) => lines.push(line), env, fetchImpl as unknown as typeof fetch)).toEqual(
      slugs
    );
    expect(lines[0]).toContain("PostHog answered 403");
  });
});
