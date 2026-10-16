import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolDef } from "mcp-surface-lint";
import { stringify } from "yaml";
import type { EvalClient } from "./client";
import { OPUS, type Tier } from "./config";

/**
 * Test-only: a throwaway data root shaped like the repository's data/, so the
 * runner and the pages can be exercised end to end without touching the real
 * directory. Point DIRECTORY_DATA_ROOT at it before importing the modules.
 */
export interface FixtureServer {
  slug: string;
  tools: ToolDef[];
  tier?: Tier;
  hash?: string;
  composite?: number;
}

export function writeFixtureData(servers: FixtureServer[]): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcplint-evals-"));
  mkdirSync(path.join(root, "seeds"), { recursive: true });
  writeFileSync(
    path.join(root, "seeds/servers.yaml"),
    stringify(
      servers.map((server) => ({
        slug: server.slug,
        name: server.slug
          .split("-")
          .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
          .join(" "),
        vendor: "Fixture",
        category: "other",
        official_url: `https://example.com/${server.slug}`,
        repo_url: null,
        docs_url: null,
        transport: "remote",
        endpoint: `https://example.com/${server.slug}/mcp`,
        auth: "none",
        stdio_command: null,
        stdio_env: {},
        snapshot_override: null,
        description: `Fixture server ${server.slug}.`,
        tags: [],
        tier: server.tier ?? "directory"
      }))
    )
  );
  writeFileSync(path.join(root, "seeds/pending.yaml"), "[]\n");
  writeFileSync(path.join(root, "redirects.yaml"), "redirects: []\n");

  for (const server of servers) {
    const dir = path.join(root, "results", server.slug);
    mkdirSync(dir, { recursive: true });
    const hash = server.hash ?? `sha256:${server.slug}-v1`;
    const at = "2026-10-01T03:00:00.000Z";
    const composite = server.composite ?? 80;
    writeFileSync(
      path.join(dir, "latest.json"),
      JSON.stringify({
        slug: server.slug,
        scanned_at: at,
        engine_version: "0.4.0",
        status: "ok",
        last_error: null,
        last_attempt_at: at,
        snapshot_hash: hash,
        server_info: { name: server.slug },
        score: {
          composite,
          categories: {
            surface: composite,
            naming: 100,
            descriptions: composite,
            schemas: composite,
            annotations: 100,
            design: composite
          }
        },
        token_footprint: { tokens: 1_000 * server.tools.length, tokenizer: "o200k_base" },
        tool_count: server.tools.length,
        findings: [],
        tools: server.tools.map((tool) => ({
          name: tool.name,
          description_length: tool.description?.length ?? 0,
          has_annotations: false,
          property_count: Object.keys((tool.inputSchema?.properties as object | undefined) ?? {}).length,
          required_count: 0,
          max_depth: 1,
          tokens: 1_000
        }))
      })
    );
    writeFileSync(
      path.join(dir, "snapshot.json"),
      JSON.stringify({ snapshot_hash: hash, serverInfo: {}, source: "http", tools: server.tools })
    );
  }
  return root;
}

export function tool(name: string, description: string, properties: Record<string, unknown> = {}): ToolDef {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required: Object.keys(properties).slice(0, 1) }
  };
}

/**
 * A scripted stand-in for the API. Token counts are a deterministic function
 * of the request, so tests can assert exact footprints.
 */
export class FakeClient implements EvalClient {
  readonly counts: Anthropic.MessageCountTokensParams[] = [];
  countError?: Error;

  async countTokens(params: Anthropic.MessageCountTokensParams): Promise<number> {
    if (this.countError) throw this.countError;
    this.counts.push(params);
    const perTool = params.model === OPUS ? 130 : 100;
    return 10 + (params.tools?.length ?? 0) * perTool;
  }

  async createMessage(): Promise<Anthropic.Message> {
    throw new Error("FakeClient.createMessage is not scripted for this test.");
  }

  async createBatch(): Promise<string> {
    throw new Error("FakeClient.createBatch is not scripted for this test.");
  }

  async batchStatus(): Promise<"in_progress"> {
    throw new Error("FakeClient.batchStatus is not scripted for this test.");
  }

  // eslint-disable-next-line require-yield -- a fake that only ever throws
  async *batchResults(): AsyncIterable<Anthropic.Messages.MessageBatchIndividualResponse> {
    throw new Error("FakeClient.batchResults is not scripted for this test.");
  }
}
