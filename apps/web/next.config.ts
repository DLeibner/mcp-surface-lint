import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const siteOrigin =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000");

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
    return [{ source: "/r/example", destination: "/example", permanent: true }];
  }
};

export default config;
