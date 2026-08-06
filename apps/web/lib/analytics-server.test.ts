import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("analytics-server", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("maps MCP paste input to snapshot audit_mode", async () => {
    const { mcpAuditMode } = await import("./analytics-server");
    expect(mcpAuditMode("paste")).toBe("snapshot");
    expect(mcpAuditMode("url")).toBe("url");
  });

  it("does nothing when PostHog is not configured", async () => {
    const { trackServer } = await import("./analytics-server");
    trackServer("lint_started", { entry_surface: "mcp_client" }, "distinct");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("captures events with hashed IP as distinct_id", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://eu.i.posthog.com");

    const { trackServer } = await import("./analytics-server");
    trackServer(
      "lint_succeeded",
      { mode: "paste", audit_mode: "snapshot", entry_surface: "mcp_client" },
      "abc123"
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://eu.i.posthog.com/capture/",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" }
      })
    );

    const body = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body as string
    );
    expect(body).toEqual({
      api_key: "phc_test",
      event: "lint_succeeded",
      distinct_id: "abc123",
      properties: {
        mode: "paste",
        audit_mode: "snapshot",
        entry_surface: "mcp_client",
        $lib: "mcplint-server"
      }
    });
  });
});
