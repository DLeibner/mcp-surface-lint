import { z } from "zod";

export const CATEGORIES = [
  "developer-tools",
  "project-management",
  "communication",
  "data-and-databases",
  "cloud-and-infrastructure",
  "payments-and-commerce",
  "design",
  "productivity-and-docs",
  "search-and-browsing",
  "observability",
  "other"
] as const;

export type DirectoryCategory = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<DirectoryCategory, string> = {
  "developer-tools": "Developer Tools",
  "project-management": "Project Management",
  communication: "Communication",
  "data-and-databases": "Data and Databases",
  "cloud-and-infrastructure": "Cloud and Infrastructure",
  "payments-and-commerce": "Payments and Commerce",
  design: "Design",
  "productivity-and-docs": "Productivity and Docs",
  "search-and-browsing": "Search and Browsing",
  observability: "Observability",
  other: "Other"
};

/** Lowercase ASCII with single hyphens. Slugs are public URLs and never change. */
const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase ASCII with single hyphens");

export const seedSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1),
  vendor: z.string().min(1),
  category: z.enum(CATEGORIES),
  official_url: z.string().url(),
  repo_url: z.string().url().nullable(),
  docs_url: z.string().url().nullable(),
  transport: z.enum(["remote", "stdio"]),
  endpoint: z.string().url().nullable(),
  auth: z.enum(["none", "apikey", "oauth"]),
  stdio_command: z.string().nullable(),
  stdio_env: z.record(z.string()).default({}),
  snapshot_override: z.string().nullable(),
  description: z.string().min(1),
  tags: z.array(z.string()).default([])
});

export type Seed = z.infer<typeof seedSchema>;

export const redirectsSchema = z.object({
  redirects: z.array(z.object({ from: slugSchema, to: slugSchema })).default([])
});

export type SlugRedirect = z.infer<typeof redirectsSchema>["redirects"][number];

/**
 * A scan outcome. `ok` means the tool surface was read and linted. `unreachable`
 * means the transport failed; the previous good payload is carried forward so
 * the page can say "last successful scan". `needs-snapshot` means the server is
 * behind auth we deliberately do not attempt — see the hard rule in the
 * scanner: never authenticate, never call a tool.
 */
export const scanStatusSchema = z.enum(["ok", "unreachable", "needs-snapshot"]);
export type ScanStatus = z.infer<typeof scanStatusSchema>;

export const scanFindingSchema = z.object({
  rule_id: z.string(),
  severity: z.enum(["error", "warn", "info"]),
  category: z.string(),
  tool_name: z.string().optional(),
  message: z.string(),
  evidence: z.string().optional()
});

export type ScanFinding = z.infer<typeof scanFindingSchema>;

export const scanToolSchema = z.object({
  name: z.string(),
  description_length: z.number().int().min(0),
  has_annotations: z.boolean(),
  property_count: z.number().int().min(0),
  required_count: z.number().int().min(0),
  max_depth: z.number().int().min(0),
  tokens: z.number().int().min(0)
});

export type ScanTool = z.infer<typeof scanToolSchema>;

export const scanResultSchema = z.object({
  slug: slugSchema,
  scanned_at: z.string().datetime(),
  engine_version: z.string(),
  status: scanStatusSchema,
  /** Present only when the most recent attempt failed. */
  last_error: z.string().nullable().default(null),
  /** ISO date of the last attempt, successful or not. */
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

export type ScanResult = z.infer<typeof scanResultSchema>;

/** A scan that actually produced a surface. Everything the pages render needs this. */
export interface ScannedResult extends ScanResult {
  score: NonNullable<ScanResult["score"]>;
  token_footprint: NonNullable<ScanResult["token_footprint"]>;
  tool_count: number;
}

export function hasSurface(result: ScanResult): result is ScannedResult {
  return (
    result.score !== null && result.token_footprint !== null && result.tool_count !== null
  );
}
