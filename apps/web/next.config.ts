import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const siteOrigin =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000");

/**
 * Slugs in data/seeds/servers.yaml are permanent public URLs. A rename is
 * expressed in data/redirects.yaml instead, and served here as a real 301 —
 * a client-side rewrite would not pass ranking signal.
 */
function slugRedirects(): { source: string; destination: string; permanent: true }[] {
  const file = path.resolve(appRoot, "../../data/redirects.yaml");
  const parsed = parse(readFileSync(file, "utf8")) as {
    redirects?: { from: string; to: string }[];
  };
  return (parsed.redirects ?? []).map(({ from, to }) => ({
    source: `/servers/${from}`,
    destination: `/servers/${to}`,
    permanent: true
  }));
}

const config: NextConfig = {
  // `mcp-surface-lint` is a workspace source package, and the MCP SDK it pulls in is
  // Node-only. Keep both out of the client bundle and let Next transpile the
  // workspace package rather than treating it as a prebuilt dep.
  transpilePackages: ["mcp-surface-lint"],
  serverExternalPackages: ["@modelcontextprotocol/sdk", "gpt-tokenizer", "undici"],
  outputFileTracingRoot: path.resolve(appRoot, "../.."),
  // One canonical spelling per URL: `/rules/` 308-redirects to `/rules`. This is
  // the framework default, pinned explicitly because the SEO checks assert it.
  trailingSlash: false,
  env: {
    MCP_SURFACE_LINT_DOCS_BASE: `${siteOrigin.replace(/\/$/, "")}/rules`
  },
  async redirects() {
    return [
      { source: "/r/example", destination: "/example", permanent: true },
      ...slugRedirects()
    ];
  }
};

export default config;
