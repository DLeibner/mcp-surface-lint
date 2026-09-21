import { z } from "zod";

/** Lowercase ASCII with single hyphens. */
const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase ASCII with single hyphens");

export const scanStatusSchema = z.enum(["ok", "unreachable", "needs-snapshot"]);

export const scanFindingSchema = z.object({
  rule_id: z.string(),
  severity: z.enum(["error", "warn", "info"]),
  category: z.string(),
  tool_name: z.string().optional(),
  message: z.string(),
  evidence: z.string().optional()
});

export const scanToolSchema = z.object({
  name: z.string(),
  description_length: z.number().int().min(0),
  has_annotations: z.boolean(),
  property_count: z.number().int().min(0),
  required_count: z.number().int().min(0),
  max_depth: z.number().int().min(0),
  tokens: z.number().int().min(0)
});

export const scanResultSchema = z.object({
  slug: slugSchema,
  scanned_at: z.string().datetime(),
  engine_version: z.string(),
  status: scanStatusSchema,
  /** Present only when the most recent attempt failed. */
  last_error: z.string().nullable().default(null),
  /**
   * The last attempt that changed this payload. Unchanged scans deliberately
   * leave the file alone so they do not trigger a no-op deployment.
   */
  last_attempt_at: z.string().datetime(),
  snapshot_hash: z.string().nullable(),
  server_info: z.object({ name: z.string().optional(), version: z.string().optional() }).default({}),
  score: z
    .object({
      composite: z.number().int().min(0).max(100),
      categories: z.record(z.number().int().min(0).max(100))
    })
    .nullable(),
  token_footprint: z
    .object({ tokens: z.number().int().min(0), tokenizer: z.string() })
    .nullable(),
  tool_count: z.number().int().min(0).nullable(),
  findings: z.array(scanFindingSchema).default([]),
  tools: z.array(scanToolSchema).default([])
});
