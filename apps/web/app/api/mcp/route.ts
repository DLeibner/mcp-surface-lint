import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createSurfaceLintMcpServer } from "@/lib/mcp-server";
import { hashIp } from "@/lib/store";
import { siteUrl } from "@/lib/site";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BODY_BYTES = 1024 * 1024;

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "0.0.0.0";
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code, message },
      id: null
    },
    { status }
  );
}

function validateOrigin(request: Request): Response | undefined {
  const origin = request.headers.get("origin");
  if (!origin) return undefined;

  try {
    if (new URL(origin).origin === siteUrl()) return undefined;
  } catch {
    // Invalid origins are rejected below.
  }
  return jsonRpcError(403, -32000, "Origin is not allowed.");
}

async function readJsonBody(request: Request): Promise<
  | { ok: true; value: unknown }
  | { ok: false; response: Response }
> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return {
      ok: false,
      response: jsonRpcError(413, -32000, "Request body exceeds the 1 MB limit.")
    };
  }

  if (!request.body) {
    return { ok: false, response: jsonRpcError(400, -32700, "Request body must be JSON.") };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel();
      return {
        ok: false,
        response: jsonRpcError(413, -32000, "Request body exceeds the 1 MB limit.")
      };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: jsonRpcError(400, -32700, "Request body must be JSON.") };
  }
}

async function handleMcpRequest(request: Request): Promise<Response> {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const parsedBody = request.method === "POST" ? await readJsonBody(request) : undefined;
  if (parsedBody && !parsedBody.ok) return parsedBody.response;

  const server = createSurfaceLintMcpServer({
    rateLimitKey: hashIp(clientIp(request))
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request, {
      parsedBody: parsedBody?.value
    });
  } catch (error) {
    console.error("MCP request failed", error);
    return jsonRpcError(500, -32603, "Internal server error.");
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

export const POST = handleMcpRequest;

export async function GET(): Promise<Response> {
  return jsonRpcError(405, -32000, "Method not allowed for this stateless endpoint.");
}

export async function DELETE(): Promise<Response> {
  return jsonRpcError(405, -32000, "Method not allowed for this stateless endpoint.");
}
