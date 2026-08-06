import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

vi.mock("@/lib/analytics-server", () => ({
  mcpAuditMode: (mode: "paste" | "url") => (mode === "paste" ? "snapshot" : "url"),
  trackServer: vi.fn()
}));

import { trackServer } from "@/lib/analytics-server";

const endpoint = "http://localhost:3000/api/mcp";

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

async function mcpPost(body: unknown) {
  const response = await POST(request(body));
  return {
    response,
    body: (await response.json()) as Record<string, unknown>
  };
}

describe("/api/mcp", () => {
  beforeEach(() => {
    vi.mocked(trackServer).mockClear();
  });

  afterEach(() => {
    vi.mocked(trackServer).mockClear();
  });

  it("works end-to-end with the SDK Streamable HTTP client", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: async (input, init) => POST(new Request(input, init))
    });
    const client = new Client({ name: "route-test", version: "1.0.0" });

    await client.connect(transport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["check_mcp_server"]);

      const called = await client.callTool({
        name: "check_mcp_server",
        arguments: {
          snapshot: {
            tools: [{ name: "search_things", description: "Search things by query." }]
          }
        }
      });
      expect(called.structuredContent).toMatchObject({
        staticAnalysis: true,
        targetToolsInvoked: false,
        stats: { toolCount: 1 }
      });
      expect(trackServer).toHaveBeenCalledWith(
        "lint_started",
        expect.objectContaining({
          mode: "paste",
          audit_mode: "snapshot",
          entry_surface: "mcp_client"
        }),
        expect.any(String)
      );
      expect(trackServer).toHaveBeenCalledWith(
        "lint_succeeded",
        expect.objectContaining({
          mode: "paste",
          audit_mode: "snapshot",
          entry_surface: "mcp_client"
        }),
        expect.any(String)
      );
    } finally {
      await client.close();
    }
  });

  it("advertises one read-only static audit tool", async () => {
    const { response, body } = await mcpPost({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {}
    });

    expect(response.status).toBe(200);
    const result = body.result as { tools: Array<Record<string, unknown>> };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toMatchObject({
      name: "check_mcp_server",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    });
  });

  it("returns structured scores for an inline snapshot", async () => {
    const { response, body } = await mcpPost({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "check_mcp_server",
        arguments: {
          snapshot: {
            serverInfo: { name: "test-server", version: "1.0.0" },
            tools: [
              {
                name: "search_hotels",
                description: "Search hotels by destination and dates.",
                inputSchema: {
                  type: "object",
                  properties: { destination: { type: "string" } },
                  required: ["destination"]
                },
                annotations: { readOnlyHint: true }
              }
            ]
          }
        }
      }
    });

    expect(response.status).toBe(200);
    const result = body.result as {
      isError?: boolean;
      structuredContent: Record<string, unknown>;
    };
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      staticAnalysis: true,
      targetToolsInvoked: false,
      grade: expect.stringMatching(/^[ABCDF]$/),
      server: { name: "test-server", version: "1.0.0" },
      stats: { toolCount: 1 },
      scores: {
        composite: expect.any(Number),
        categories: {
          surface: expect.any(Number),
          naming: expect.any(Number),
          descriptions: expect.any(Number),
          schemas: expect.any(Number),
          annotations: expect.any(Number),
          design: expect.any(Number)
        }
      },
      findingCounts: {
        bySeverity: {
          error: expect.any(Number),
          warn: expect.any(Number),
          info: expect.any(Number)
        },
        byCategory: {
          surface: expect.any(Number),
          naming: expect.any(Number),
          descriptions: expect.any(Number),
          schemas: expect.any(Number),
          annotations: expect.any(Number),
          design: expect.any(Number)
        }
      }
    });
    expect(result.structuredContent).not.toHaveProperty("snapshot");
    expect(result.structuredContent).not.toHaveProperty("tools");
  });

  it("requires exactly one input source", async () => {
    const { body } = await mcpPost({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "check_mcp_server",
        arguments: {
          url: "https://example.com/mcp",
          snapshot: { tools: [] }
        }
      }
    });

    expect(body.result).toMatchObject({ isError: true });
    expect(trackServer).not.toHaveBeenCalled();
  });

  it("rejects oversized requests before protocol handling", async () => {
    const response = await POST(
      request(
        { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
        { "content-length": String(1024 * 1024 + 1) }
      )
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32000, message: expect.stringContaining("1 MB") }
    });
  });

  it("rejects cross-origin browser requests", async () => {
    const response = await POST(
      request(
        { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} },
        { origin: "https://attacker.example" }
      )
    );
    expect(response.status).toBe(403);
  });

  it("does not open an SSE stream for stateless GET requests", async () => {
    const response = await GET();
    expect(response.status).toBe(405);
  });
});
