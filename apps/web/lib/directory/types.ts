import { z } from "zod";
import {
  scanFindingSchema,
  scanResultSchema,
  scanStatusSchema,
  scanToolSchema
} from "./scan-result-schema.js";

export {
  scanFindingSchema,
  scanResultSchema,
  scanStatusSchema,
  scanToolSchema
} from "./scan-result-schema.js";

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
export type ScanStatus = z.infer<typeof scanStatusSchema>;

export type ScanFinding = z.infer<typeof scanFindingSchema>;

export type ScanTool = z.infer<typeof scanToolSchema>;

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
