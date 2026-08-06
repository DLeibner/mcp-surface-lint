import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.fn();
const register = vi.fn();
const init = vi.fn();

vi.mock("posthog-js", () => ({
  default: { init, register, capture }
}));

describe("analytics", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    capture.mockClear();
    register.mockClear();
    init.mockClear();
    storage.clear();
    vi.stubGlobal("window", {
      location: { search: "" },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        }
      }
    });
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("records campaign_landing once when UTM params are present", async () => {
    window.location.search =
      "?utm_source=linkedin&utm_campaign=mcplint_use_cases&utm_content=cursor_grafana_audit";

    const { initAnalytics } = await import("./analytics");
    initAnalytics();
    initAnalytics();

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("campaign_landing", {
      utm_source: "linkedin",
      utm_campaign: "mcplint_use_cases",
      utm_content: "cursor_grafana_audit"
    });
  });

  it("does not record campaign_landing without campaign params", async () => {
    window.location.search = "";

    const { initAnalytics } = await import("./analytics");
    initAnalytics();

    expect(capture).not.toHaveBeenCalled();
  });
});
