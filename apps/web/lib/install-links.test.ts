import { describe, expect, it } from "vitest";
import { cursorInstallUrl, vscodeInstallUrl } from "./install-links";

const endpoint = "https://mcplint.example/api/mcp";

describe("MCP install links", () => {
  it("encodes a direct Cursor transport object as base64", () => {
    const link = new URL(cursorInstallUrl(endpoint));
    expect(link.protocol).toBe("cursor:");
    expect(link.searchParams.get("name")).toBe("mcp-surface-lint");
    const encoded = link.searchParams.get("config");
    expect(encoded).toBeTruthy();
    expect(JSON.parse(atob(encoded!))).toEqual({ url: endpoint });
  });

  it("encodes the VS Code server configuration", () => {
    const prefix = "vscode:mcp/install?";
    const link = vscodeInstallUrl(endpoint);
    expect(link.startsWith(prefix)).toBe(true);
    expect(JSON.parse(decodeURIComponent(link.slice(prefix.length)))).toEqual({
      name: "mcp-surface-lint",
      type: "http",
      url: endpoint
    });
  });

  it("rejects non-HTTP endpoints", () => {
    expect(() => cursorInstallUrl("file:///tmp/server")).toThrow(/HTTP/);
  });
});
