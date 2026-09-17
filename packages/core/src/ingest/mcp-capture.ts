import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerSnapshot, ToolDef } from "../types.js";

/** Guards against a hostile or broken server paginating us forever. */
export interface CaptureLimits {
  maxPages?: number;
  maxTools?: number;
  /**
   * Abandon the capture after this many milliseconds.
   *
   * Racing the returned promise against a timer is not enough: it rejects the
   * caller while the underlying connection stays open, so a stdio server that
   * never answers leaves its child process running and can keep the whole
   * process alive. Passing the budget in here lets the capture close its own
   * transport, which is what actually terminates the child.
   */
  timeoutMs?: number;
}

export interface StdioCaptureOptions extends CaptureLimits {
  /**
   * Environment for the spawned server. The SDK inherits only a small safe-list
   * by default, so a server that needs `FOO_TOKEN` to boot will not see it
   * unless it is passed here. The directory scanner uses this to hand servers
   * placeholder credentials — enough to reach `tools/list`, never a real secret.
   */
  env?: Record<string, string>;
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

const DEFAULT_LIMITS: Omit<Required<CaptureLimits>, "timeoutMs"> = {
  maxPages: 50,
  maxTools: 1000
};

/** Thrown when {@link CaptureLimits.timeoutMs} elapses before the surface is read. */
export class CaptureTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`The server did not complete tools/list within ${timeoutMs / 1000}s.`);
    this.name = "CaptureTimeoutError";
  }
}

export class McpCapture {
  static async fromStdio(
    command: string,
    opts: StdioCaptureOptions = {}
  ): Promise<ServerSnapshot> {
    const [cmd, ...args] = this.splitCommand(command);
    if (!cmd) throw new Error("Empty stdio command.");
    const transport = new StdioClientTransport({
      command: cmd,
      args,
      ...(opts.env ? { env: { ...getDefaultEnvironment(), ...opts.env } } : {})
    });
    return this.capture(transport, "stdio", opts);
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
    const { timeoutMs } = limits;
    const client = new Client({ name: "mcp-surface-lint", version: "0.1.0" });

    // The timer starts before `connect`, because a server that accepts the pipe
    // and then says nothing hangs there rather than in `listTools`.
    let timedOut = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            // Tearing the transport down is what unblocks the pending request
            // and kills a stdio child; the caller's rejection alone would not.
            void transport.close?.().catch(() => {});
            void client.close().catch(() => {});
          }, timeoutMs);

    try {
      await client.connect(transport);
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
    } catch (error) {
      // A closed transport surfaces as an opaque connection error; report the
      // cause the caller actually needs to see.
      if (timedOut) throw new CaptureTimeoutError(timeoutMs!);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await client.close().catch(() => {});
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
