import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerSnapshot, ToolDef } from "../types.js";

/** Guards against a hostile or broken server paginating us forever. */
export interface CaptureLimits {
  maxPages?: number;
  maxTools?: number;
}

export interface HttpCaptureOptions extends CaptureLimits {
  /** Sent on every request — e.g. `{ Authorization: "Bearer …" }`. */
  headers?: Record<string, string>;
  /**
   * Replaces the transport's fetch. The web app passes an SSRF-guarded fetch
   * here so an untrusted URL can never open a socket to a private address.
   */
  fetch?: FetchLike;
}

const DEFAULT_LIMITS: Required<CaptureLimits> = { maxPages: 50, maxTools: 1000 };

export class McpCapture {
  static async fromStdio(command: string, limits: CaptureLimits = {}): Promise<ServerSnapshot> {
    const [cmd, ...args] = this.splitCommand(command);
    if (!cmd) throw new Error("Empty stdio command.");
    const transport = new StdioClientTransport({ command: cmd, args });
    return this.capture(transport, "stdio", limits);
  }

  static async fromHttp(url: string, opts: HttpCaptureOptions = {}): Promise<ServerSnapshot> {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      ...(opts.headers ? { requestInit: { headers: opts.headers } } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {})
    });
    return this.capture(transport, "http", opts);
  }

  private static async capture(
    transport: Parameters<Client["connect"]>[0],
    source: "stdio" | "http",
    limits: CaptureLimits = {}
  ): Promise<ServerSnapshot> {
    const { maxPages, maxTools } = { ...DEFAULT_LIMITS, ...limits };
    const client = new Client({ name: "mcp-surface-lint", version: "0.1.0" });
    await client.connect(transport);
    try {
      const tools: ToolDef[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...(page.tools as ToolDef[]));
        cursor = page.nextCursor;
        if (++pages >= maxPages && cursor) {
          throw new Error(`Server exceeded the ${maxPages}-page tools/list limit.`);
        }
        if (tools.length > maxTools) {
          throw new Error(`Server exposed more than ${maxTools} tools.`);
        }
      } while (cursor);
      const serverVersion = client.getServerVersion();
      return {
        serverInfo: serverVersion
          ? { name: serverVersion.name, version: serverVersion.version }
          : undefined,
        tools,
        capturedAt: new Date().toISOString(),
        source
      };
    } finally {
      await client.close();
    }
  }

  static splitCommand(command: string): string[] {
    const parts: string[] = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(command)) !== null) {
      parts.push(match[1] ?? match[2] ?? match[3]!);
    }
    return parts;
  }
}
