import { describe, expect, it, vi } from "vitest";
import { raise, resendNotifier, type Alert, type AlertSink } from "./alerts";

const alert: Alert = { key: "hard-stop:2026-10-01", kind: "hard-stop", subject: "Paused", body: "Details." };

describe("resendNotifier", () => {
  it("is off unless both the key and the address are set", () => {
    expect(resendNotifier({})).toBeUndefined();
    expect(resendNotifier({ RESEND_API_KEY: "re_x" })).toBeUndefined();
    expect(resendNotifier({ ALERT_EMAIL_TO: "a@example.com" })).toBeUndefined();
  });

  it("sends one plain-text email per alert", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await resendNotifier({ RESEND_API_KEY: "re_x", ALERT_EMAIL_TO: "a@example.com" })!(alert);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers).toMatchObject({ Authorization: "Bearer re_x" });
    expect(JSON.parse(String(init.body))).toEqual({
      from: "MCP Surface Lint <onboarding@resend.dev>",
      to: ["a@example.com"],
      subject: "Paused",
      text: "Details."
    });
  });
});

describe("raise", () => {
  function sink(notify?: AlertSink["notify"]): AlertSink & { lines: string[] } {
    const claimed = new Set<string>();
    const lines: string[] = [];
    return {
      claimEvent: async (key) => !claimed.has(key) && Boolean(claimed.add(key)),
      notify,
      log: (line) => lines.push(line),
      raised: [],
      lines
    };
  }

  it("raises each key once", async () => {
    const notify = vi.fn(async () => {});
    const target = sink(notify);
    await raise(target, alert);
    await raise(target, alert);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(target.raised).toEqual([alert]);
  });

  it("logs a failed email instead of failing the run", async () => {
    const target = sink(async () => {
      throw new Error("Resend answered 403");
    });
    await expect(raise(target, alert)).resolves.toBeUndefined();
    expect(target.lines[0]).toContain("Resend answered 403");
  });
});
