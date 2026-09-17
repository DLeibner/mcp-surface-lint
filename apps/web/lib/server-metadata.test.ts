import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface ServerMetadata {
  $schema: string;
  name: string;
  title?: string;
  description: string;
  version: string;
  repository?: { url: string; source: string; subfolder?: string };
  remotes?: Array<{ type: string; url: string }>;
}

describe("server.json", () => {
  it("uses the official registry schema and describes the hosted endpoint", async () => {
    const path = new URL("../../../server.json", import.meta.url);
    const metadata = JSON.parse(await readFile(path, "utf8")) as ServerMetadata;

    expect(metadata.$schema).toBe(
      "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json"
    );
    expect(metadata.name).toBe("io.github.DLeibner/mcp-surface-lint");
    expect(metadata.title).toBe("MCP Surface Lint");
    expect(metadata.description.length).toBeGreaterThan(0);
    expect(metadata.description.length).toBeLessThanOrEqual(100);
    expect(metadata.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    expect(metadata.repository).toMatchObject({
      url: "https://github.com/DLeibner/mcp-surface-lint",
      source: "github",
      subfolder: "apps/web"
    });
    expect(metadata.remotes).toEqual([
      {
        type: "streamable-http",
        url: "https://mcplint-web.vercel.app/api/mcp"
      }
    ]);
  });
});
