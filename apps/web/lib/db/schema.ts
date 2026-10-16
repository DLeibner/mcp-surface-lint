import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  varchar
} from "drizzle-orm/pg-core";

export const runs = pgTable(
  "runs",
  {
    id: varchar("id", { length: 16 }).primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    ingestMethod: varchar("ingest_method", { length: 8 }).notNull(), // "paste" | "url"

    serverName: text("server_name"),
    serverVersion: text("server_version"),

    toolCount: integer("tool_count").notNull(),
    approxTokens: integer("approx_tokens").notNull(),

    composite: smallint("composite").notNull(),
    surface: smallint("surface").notNull(),
    naming: smallint("naming").notNull(),
    descriptions: smallint("descriptions").notNull(),
    schemas: smallint("schemas").notNull(),
    annotations: smallint("annotations").notNull(),
    design: smallint("design").notNull(),

    report: jsonb("report").notNull(),
    /** Retained only so a run can be re-linted after a rule change. Purged with the run. */
    snapshot: jsonb("snapshot"),

    /** "unlisted" (default, noindex, unguessable URL) | "public" (opt-in) */
    visibility: varchar("visibility", { length: 12 }).notNull().default("unlisted"),
    /** Bearer of this token may delete the run. Hashed — we never store the raw value. */
    deleteTokenHash: text("delete_token_hash").notNull(),

    ipHash: text("ip_hash"),
    durationMs: integer("duration_ms").notNull(),
    /**
     * The engine that produced this score. Without it, a rule-weight change is
     * indistinguishable from a real shift in server quality when we look back.
     */
    engineVersion: text("engine_version").notNull(),

    /** Unlisted runs are purged after 30 days. Public ones are kept. */
    purgeAt: timestamp("purge_at", { withTimezone: true })
  },
  (table) => [
    index("runs_created_at_idx").on(table.createdAt),
    index("runs_server_name_idx").on(table.serverName),
    index("runs_purge_at_idx").on(table.purgeAt)
  ]
);

/**
 * Denormalised finding counts, written alongside each run.
 *
 * "Which rules fire most often across all servers" is the single most valuable
 * question this product can answer — it tells us which rules are miscalibrated
 * and it is the raw material for anything we publish. Answering it by crawling
 * the `report` jsonb of every row would get slow fast; this makes it an index scan.
 */
export const runFindings = pgTable(
  "run_findings",
  {
    runId: varchar("run_id", { length: 16 })
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    ruleId: varchar("rule_id", { length: 64 }).notNull(),
    severity: varchar("severity", { length: 8 }).notNull(),
    count: integer("count").notNull()
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.ruleId, table.severity] }),
    index("run_findings_rule_id_idx").on(table.ruleId)
  ]
);

/**
 * The demand test for the eventual paid tier.
 *
 * Rather than build billing to find out whether anyone wants this, we put a real
 * but inert call-to-action on the report page and count who asks to be told when
 * it exists. No payment is taken and nothing is promised. If this table stays
 * empty, that is the answer.
 */
export const interest = pgTable("interest", {
  id: varchar("id", { length: 16 }).primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  email: text("email").notNull(),
  runId: varchar("run_id", { length: 16 }),
  note: text("note")
});

/**
 * Every LLM call the eval layer pays for, one row per call. The budget gate and
 * /admin/budget sum this table. `usd` is priced from lib/llm/config.ts when the
 * call returns — never at a call site, and never re-priced afterwards.
 */
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** "scenarios" | "selection" | "review" | "summary" | "fake" */
    job: varchar("job", { length: 16 }).notNull(),
    /** Directory slug of the server the call was about. */
    serverId: varchar("server_id", { length: 64 }).notNull(),
    model: varchar("model", { length: 40 }).notNull(),
    inputTokens: integer("input_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    usd: numeric("usd", { precision: 12, scale: 6 }).notNull(),
    batch: boolean("batch").notNull(),
    /** Anthropic message batch id, when the call went through the Batch API. */
    batchId: varchar("batch_id", { length: 64 }),
    /** The result key the call was made for. */
    jobKey: text("job_key")
  },
  (table) => [
    index("llm_usage_created_at_idx").on(table.createdAt),
    index("llm_usage_server_id_idx").on(table.serverId)
  ]
);

/**
 * Batches submitted to the Message Batches API. One run submits, a later run
 * collects. Until then the batch's worst-case cost is reserved against the
 * budget, so a burst of submissions cannot overshoot a stop.
 */
export const llmBatches = pgTable("llm_batches", {
  id: varchar("id", { length: 64 }).primaryKey(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  /** "in_progress" | "collected" */
  status: varchar("status", { length: 16 }).notNull(),
  requestCount: integer("request_count").notNull(),
  estimatedUsd: numeric("estimated_usd", { precision: 12, scale: 6 }).notNull(),
  /** custom_id → which job and which scenario the request was for. */
  requests: jsonb("requests").notNull(),
  collectedAt: timestamp("collected_at", { withTimezone: true })
});

/**
 * One row per result key the layer has paid for — in flight, done, or failed.
 * "Never pay twice" is enforced here: an existing key is skipped. The finished
 * result is kept so the committed JSON under data/evals can be rewritten from
 * it if a commit is ever lost, without buying the same answer again.
 */
export const llmJobs = pgTable(
  "llm_jobs",
  {
    key: text("key").primaryKey(),
    job: varchar("job", { length: 16 }).notNull(),
    serverId: varchar("server_id", { length: 64 }).notNull(),
    model: varchar("model", { length: 40 }).notNull(),
    /** "submitted" | "done" | "failed" */
    status: varchar("status", { length: 12 }).notNull(),
    /** "batch" | "standard" */
    mode: varchar("mode", { length: 8 }).notNull(),
    batchId: varchar("batch_id", { length: 64 }),
    attempts: smallint("attempts").notNull().default(0),
    lastError: text("last_error"),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [index("llm_jobs_server_id_idx").on(table.serverId)]
);

/**
 * One-shot markers: an alert that must go out once, a pass that runs once per
 * cycle. The key carries its scope ("hard-stop:2026-10-01"), so a run that
 * fails to insert a key has learned that it already happened.
 */
export const llmEvents = pgTable("llm_events", {
  key: text("key").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  kind: varchar("kind", { length: 32 }).notNull(),
  detail: jsonb("detail")
});

export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
