import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Scorer, countFindings } from "mcp-surface-lint";
import { z } from "zod";
import { mcpAuditMode, trackServer } from "./analytics-server";
import { checkRateLimit } from "./rate-limit";
import { LintError, runLint, type LintRequest } from "./lint";
import { ENGINE_VERSION } from "./version";

const categoriesSchema = z.object({
  surface: z.number().int().min(0).max(100),
  naming: z.number().int().min(0).max(100),
  descriptions: z.number().int().min(0).max(100),
  schemas: z.number().int().min(0).max(100),
  annotations: z.number().int().min(0).max(100),
  design: z.number().int().min(0).max(100)
});

const findingSchema = z.object({
  ruleId: z.string(),
  toolName: z.string().optional(),
  path: z.string().optional(),
  message: z.string(),
  evidence: z.string().optional(),
  severity: z.enum(["error", "warn", "info"]),
  category: z.enum([
    "surface",
    "naming",
    "descriptions",
    "schemas",
    "annotations",
    "design"
  ]),
  docsUrl: z.string()
});

export const checkMcpServerOutputSchema = z.object({
  staticAnalysis: z.literal(true),
  targetToolsInvoked: z.literal(false),
  grade: z.enum(["A", "B", "C", "D", "F"]),
  server: z.object({
    name: z.string().optional(),
    version: z.string().optional()
  }),
  source: z.string(),
  stats: z.object({
    toolCount: z.number().int().nonnegative(),
    approxTokens: z.number().int().nonnegative(),
    encoding: z.string()
  }),
  scores: z.object({
    composite: z.number().int().min(0).max(100),
    categories: categoriesSchema
  }),
  findingCounts: z.object({
    bySeverity: z.object({
      error: z.number().int().nonnegative(),
      warn: z.number().int().nonnegative(),
      info: z.number().int().nonnegative()
    }),
    byCategory: z.object({
      surface: z.number().int().nonnegative(),
      naming: z.number().int().nonnegative(),
      descriptions: z.number().int().nonnegative(),
      schemas: z.number().int().nonnegative(),
      annotations: z.number().int().nonnegative(),
      design: z.number().int().nonnegative()
    })
  }),
  findings: z.array(findingSchema)
});

export type CheckMcpServerOutput = z.infer<typeof checkMcpServerOutputSchema>;

const checkMcpServerInputSchema = z.object({
  url: z
    .string()
    .trim()
    .url()
    .optional()
    .describe("Public HTTPS Streamable HTTP MCP endpoint to inspect."),
  headers: z
    .record(z.string())
    .optional()
    .describe("Optional HTTP headers sent only while reading the remote tools/list response."),
  snapshot: z
    .unknown()
    .optional()
    .describe(
      "A tools/list JSON response, mcplint snapshot, or client tool dump containing a tools array. " +
        "Each tool needs `name`, or the Cursor-style `tool` alias. Forward another installed " +
        "server's complete tool definitions here — do not invent schemas."
    )
});

function validateCheckMcpServerInput(
  input: z.infer<typeof checkMcpServerInputSchema>
): string | undefined {
  const hasUrl = input.url !== undefined;
  const hasSnapshot = input.snapshot !== undefined;
  if (hasUrl === hasSnapshot) {
    return "Provide exactly one of url or snapshot.";
  }
  if (input.headers && !hasUrl) {
    return "headers can only be used with url.";
  }
  return undefined;
}

export interface McplintMcpServerOptions {
  rateLimitKey: string;
}

function asLintRequest(input: z.infer<typeof checkMcpServerInputSchema>): LintRequest {
  if (input.url !== undefined) {
    return { mode: "url", url: input.url, headers: input.headers };
  }
  return { mode: "paste", snapshot: input.snapshot };
}

export function createMcplintMcpServer(options: McplintMcpServerOptions): McpServer {
  const server = new McpServer({
    name: "mcplint",
    version: ENGINE_VERSION
  });

  server.registerTool(
    "check_mcp_server",
    {
      title: "Check MCP server",
      description:
        "Statically audit an MCP tool surface from a public HTTPS URL or tools/list snapshot. " +
        "Returns deterministic scores and findings without invoking any target tool or making LLM calls. " +
        "When the user asks to check another installed MCP server, read that server's complete tool " +
        "definitions from client context and pass them as snapshot (MCP `name` or Cursor-style `tool` " +
        "both work; do not use file paths or $ref). If those definitions are unavailable, ask the " +
        "user for its public endpoint or tools/list JSON instead of inventing an audit.",
      inputSchema: checkMcpServerInputSchema,
      outputSchema: checkMcpServerOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (input) => {
      const validationError = validateCheckMcpServerInput(input);
      if (validationError) {
        throw new Error(validationError);
      }

      const request = asLintRequest(input);
      const mode = request.mode;
      const audit_mode = mcpAuditMode(mode);
      const analytics = {
        mode,
        audit_mode,
        entry_surface: "mcp_client" as const
      };

      trackServer("lint_started", analytics, options.rateLimitKey);

      const limit = await checkRateLimit(request.mode, options.rateLimitKey);
      if (!limit.ok) {
        trackServer(
          "lint_failed",
          {
            ...analytics,
            status: limit.reason === "not_configured" ? 503 : 429
          },
          options.rateLimitKey
        );
        if (limit.reason === "not_configured") {
          throw new Error(
            "Audits are unavailable until production rate limiting is configured."
          );
        }
        throw new Error("Rate limit reached. Try again shortly.");
      }

      let report;
      try {
        // runLint captures only tools/list for URL inputs. The snapshot is held
        // for this invocation and deliberately never passed to the report store.
        ({ report } = await runLint(request));
      } catch (error) {
        const status =
          error instanceof LintError ? (error.kind === "too_large" ? 413 : 422) : 500;
        trackServer("lint_failed", { ...analytics, status }, options.rateLimitKey);
        throw error;
      }

      trackServer("lint_succeeded", analytics, options.rateLimitKey);
      const output: CheckMcpServerOutput = {
        staticAnalysis: true,
        targetToolsInvoked: false,
        grade: Scorer.grade(report.scores.composite),
        server: report.server,
        source: report.source,
        stats: report.stats,
        scores: report.scores,
        findingCounts: countFindings(report.findings),
        findings: report.findings
      };

      return {
        content: [
          {
            type: "text",
            text:
              `Static audit complete: ${output.grade} (${output.scores.composite}/100) across ` +
              `${output.stats.toolCount} tools (${output.stats.approxTokens} approximate tokens).`
          }
        ],
        structuredContent: output
      };
    }
  );

  return server;
}
