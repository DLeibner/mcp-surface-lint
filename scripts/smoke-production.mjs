import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rawOrigin = process.argv[2];
if (!rawOrigin) {
  throw new Error("Usage: node scripts/smoke-production.mjs <production-origin>");
}

const productionUrl = new URL(rawOrigin);
if (
  productionUrl.protocol !== "https:" ||
  productionUrl.pathname !== "/" ||
  productionUrl.search ||
  productionUrl.hash
) {
  throw new Error("The production origin must be an HTTPS origin without a path.");
}
const origin = productionUrl.origin;
const endpoint = `${origin}/api/mcp`;

const metadata = JSON.parse(readFileSync(resolve(repositoryRoot, "server.json"), "utf8"));
if (new URL(metadata.websiteUrl).origin !== origin) {
  throw new Error(`server.json websiteUrl does not use the production origin ${origin}.`);
}
if (
  !Array.isArray(metadata.remotes) ||
  metadata.remotes.length !== 1 ||
  metadata.remotes[0]?.type !== "streamable-http" ||
  metadata.remotes[0]?.url !== endpoint
) {
  throw new Error(`server.json must advertise ${endpoint} as its Streamable HTTP endpoint.`);
}

async function request(path) {
  const response = await fetch(`${origin}${path}`, {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}.`);
  }
  await response.arrayBuffer();
}

async function rpc(id, method, params) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    throw new Error(`MCP ${method} returned HTTP ${response.status}.`);
  }

  const body = await response.json();
  if (body.error) {
    throw new Error(`MCP ${method} failed: ${body.error.message ?? "unknown JSON-RPC error"}`);
  }
  return body.result;
}

async function smoke() {
  await Promise.all(
    [
      "/",
      "/install",
      "/rules",
      "/example",
      "/servers",
      "/methodology",
      "/audit",
      "/sitemap.xml",
      "/robots.txt"
    ].map(request)
  );

  const initialized = await rpc(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-surface-lint-release-smoke", version: "1.0.0" }
  });
  if (initialized?.serverInfo?.name !== "mcp-surface-lint") {
    throw new Error("MCP initialize returned unexpected server metadata.");
  }

  const listed = await rpc(2, "tools/list", {});
  const toolNames = listed?.tools?.map((tool) => tool.name);
  if (toolNames?.length !== 1 || toolNames[0] !== "check_mcp_server") {
    throw new Error(`MCP tools/list returned unexpected tools: ${JSON.stringify(toolNames)}`);
  }

  const called = await rpc(3, "tools/call", {
    name: "check_mcp_server",
    arguments: {
      snapshot: {
        serverInfo: { name: "release-smoke", version: "1.0.0" },
        tools: [
          {
            name: "search_things",
            description: "Search things by query.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"]
            },
            annotations: { readOnlyHint: true }
          }
        ]
      }
    }
  });
  const output = called?.structuredContent;
  if (
    called?.isError === true ||
    output?.staticAnalysis !== true ||
    output?.targetToolsInvoked !== false ||
    output?.server?.name !== "release-smoke" ||
    output?.stats?.toolCount !== 1
  ) {
    throw new Error("MCP tools/call returned an unexpected snapshot audit result.");
  }
}

let lastError;
for (let attempt = 1; attempt <= 20; attempt += 1) {
  try {
    await smoke();
    console.log(`Production smoke tests passed at ${origin}.`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < 20) {
      console.log(`Production is not ready yet (attempt ${attempt}/20); retrying.`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 6_000));
    }
  }
}

throw lastError;
