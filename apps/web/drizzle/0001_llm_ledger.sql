CREATE TABLE "llm_batches" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" varchar(16) NOT NULL,
	"request_count" integer NOT NULL,
	"estimated_usd" numeric(12, 6) NOT NULL,
	"requests" jsonb NOT NULL,
	"collected_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "llm_events" (
	"key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" varchar(32) NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "llm_jobs" (
	"key" text PRIMARY KEY NOT NULL,
	"job" varchar(16) NOT NULL,
	"server_id" varchar(64) NOT NULL,
	"model" varchar(40) NOT NULL,
	"status" varchar(12) NOT NULL,
	"mode" varchar(8) NOT NULL,
	"batch_id" varchar(64),
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"job" varchar(16) NOT NULL,
	"server_id" varchar(64) NOT NULL,
	"model" varchar(40) NOT NULL,
	"input_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"usd" numeric(12, 6) NOT NULL,
	"batch" boolean NOT NULL,
	"batch_id" varchar(64),
	"request_id" varchar(16),
	"job_key" text
);
--> statement-breakpoint
CREATE INDEX "llm_jobs_server_id_idx" ON "llm_jobs" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "llm_usage_created_at_idx" ON "llm_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "llm_usage_server_id_idx" ON "llm_usage" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_usage_batch_request_idx" ON "llm_usage" USING btree ("batch_id","request_id");