import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("siteUrl", () => {
  it("prefers the configured origin and strips anything after it", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://mcp-surface-lint.com/ignored?a=b";
    const { siteUrl } = await import("./site");
    expect(siteUrl()).toBe("https://mcp-surface-lint.com");
  });

  it("warns when it falls back to a deployment host, because canonicals depend on it", async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "mcplint-web.vercel.app";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { siteUrl } = await import("./site");
    expect(siteUrl()).toBe("https://mcplint-web.vercel.app");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("NEXT_PUBLIC_SITE_URL is unset");

    // Once per process, not once per page render.
    siteUrl();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("stays quiet on a custom production host", async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "mcp-surface-lint.com";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { siteUrl } = await import("./site");
    expect(siteUrl()).toBe("https://mcp-surface-lint.com");
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects a non-HTTP origin", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "ftp://mcp-surface-lint.com";
    const { siteUrl } = await import("./site");
    expect(() => siteUrl()).toThrow(/http or https/);
  });
});
