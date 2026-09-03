#!/usr/bin/env node
/**
 * Directory scanner. Reads data/seeds/servers.yaml, obtains each server's
 * tools/list, lints it, and writes data/results/{slug}/.
 *
 * Two hard rules, both inherited from the product:
 *   1. Only `initialize` and `tools/list` are ever sent. No tool is invoked.
 *   2. No real credential is used. Servers behind OAuth are recorded as
 *      `needs-snapshot` and skipped, never authenticated against.
 *
 * Usage:
 *   node scripts/scan.mjs                 # every seed
 *   node scripts/scan.mjs --slug github   # one seed
 *   node scripts/scan.mjs --concurrency 4
 *   node scripts/scan.mjs --skip-stdio    # HTTP only, spawns nothing
 *
 * `--skip-stdio` exists because a stdio scan executes third-party packages.
 * That belongs in CI's throwaway container, not on a workstation.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  ConfigLoader,
  LintEngine,
  McpCapture,
  RuleRegistry,
  SnapshotLoader,
  TokenCounter
} from "mcp-surface-lint";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const RESULTS = path.join(DATA, "results");

const CAPTURE_TIMEOUT_MS = 60_000;
/**
 * The capture owns the real deadline and closes its own transport, which is
 * what actually kills a stalled stdio child. The outer race below is a backstop
 * for a hang somewhere other than the capture, so it must fire second.
 */
const GRACE_MS = 5_000;
const LIMITS = { maxTools: 500, maxPages: 20, timeoutMs: CAPTURE_TIMEOUT_MS };

const ENGINE_VERSION = JSON.parse(
  await readFile(path.join(ROOT, "packages/core/package.json"), "utf8")
).version;

function parseArgs(argv) {
  const args = { slug: undefined, concurrency: 4, skipStdio: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--slug") args.slug = argv[++i];
    else if (argv[i] === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (argv[i] === "--skip-stdio") args.skipStdio = true;
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer.");
  }
  return args;
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s.`)), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stable across key order so a server that reorders its JSON does not look
 * changed. This hash is what makes the run idempotent, and therefore what makes
 * the sitemap's `lastmod` mean something.
 */
function snapshotHash(tools) {
  const canonical = JSON.stringify(
    [...tools].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value
  );
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function schemaDepth(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return depth;
  let deepest = depth;
  const props = schema.properties;
  if (props && typeof props === "object") {
    for (const child of Object.values(props)) {
      deepest = Math.max(deepest, schemaDepth(child, depth + 1));
    }
  }
  if (schema.items) deepest = Math.max(deepest, schemaDepth(schema.items, depth + 1));
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    if (Array.isArray(schema[key])) {
      for (const branch of schema[key]) deepest = Math.max(deepest, schemaDepth(branch, depth));
    }
  }
  return deepest;
}

function summariseTool(tool) {
  const schema = tool.inputSchema ?? {};
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  return {
    name: String(tool.name),
    description_length: (tool.description ?? "").length,
    has_annotations: Boolean(tool.annotations && Object.keys(tool.annotations).length > 0),
    property_count: Object.keys(properties).length,
    required_count: Array.isArray(schema.required) ? schema.required.length : 0,
    max_depth: schemaDepth(schema),
    tokens: TokenCounter.tool(tool)
  };
}

/** Thrown when a server declines an unauthenticated `tools/list`. */
class AuthRequiredError extends Error {
  constructor(detail) {
    super(`The server requires authentication to read tools/list. ${detail}`.trim());
    this.name = "AuthRequiredError";
  }
}

/**
 * Does this failure mean "you need credentials" rather than "this is broken"?
 *
 * The distinction decides whether a server is recorded as `needs-snapshot` (we
 * could publish it from a snapshot its maintainers provide) or `unreachable`
 * (something is wrong at the endpoint).
 */
function isAuthFailure(error) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    /\b401\b|\b403\b/.test(message) ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("authentication") ||
    message.includes("authorization") ||
    message.includes("invalid_token") ||
    message.includes("access_denied") ||
    message.includes("www-authenticate")
  );
}

/**
 * Snapshot acquisition. A committed override always wins; it is the escape
 * hatch for servers that will not talk to us at all.
 *
 * Remote servers are always *attempted* regardless of their declared `auth`,
 * because most MCP servers answer `tools/list` to anyone and gate only
 * `tools/call`. Attempting an unauthenticated read is not authenticating: no
 * credential is ever sent, and no tool is ever invoked. A server that declines
 * tells us so in one request, which is strictly better than assuming it would.
 */
async function capture(seed) {
  if (seed.snapshot_override) {
    const file = path.resolve(DATA, seed.snapshot_override);
    if (!existsSync(file)) throw new Error(`snapshot_override not found: ${seed.snapshot_override}`);
    return SnapshotLoader.fromFile(file);
  }

  if (seed.transport === "stdio") {
    if (!seed.stdio_command) throw new Error("transport is stdio but stdio_command is null.");
    return withTimeout(
      McpCapture.fromStdio(seed.stdio_command, { ...LIMITS, env: seed.stdio_env ?? {} }),
      CAPTURE_TIMEOUT_MS + GRACE_MS,
      "stdio capture"
    );
  }

  if (!seed.endpoint) throw new Error("transport is remote but endpoint is null.");
  try {
    return await withTimeout(
      McpCapture.fromHttp(seed.endpoint, LIMITS),
      CAPTURE_TIMEOUT_MS + GRACE_MS,
      "http capture"
    );
  } catch (error) {
    if (isAuthFailure(error)) {
      throw new AuthRequiredError(error instanceof Error ? error.message.slice(0, 200) : "");
    }
    throw error;
  }
}

async function readLatest(slug) {
  const file = path.join(RESULTS, slug, "latest.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

function lint(snapshot) {
  const report = new LintEngine(RuleRegistry.all(), ConfigLoader.empty()).run(snapshot);
  return {
    server_info: {
      ...(report.server.name ? { name: report.server.name } : {}),
      ...(report.server.version ? { version: report.server.version } : {})
    },
    score: { composite: report.scores.composite, categories: report.scores.categories },
    token_footprint: { tokens: report.stats.approxTokens, tokenizer: report.stats.encoding },
    tool_count: report.stats.toolCount,
    findings: report.findings.map((f) => ({
      rule_id: f.ruleId,
      severity: f.severity,
      category: f.category,
      ...(f.toolName ? { tool_name: f.toolName } : {}),
      message: f.message,
      ...(f.evidence ? { evidence: f.evidence } : {})
    })),
    tools: snapshot.tools.map(summariseTool)
  };
}

/**
 * Everything a result says except when it was attempted.
 *
 * `last_attempt_at` moves on every run by definition, so comparing whole files
 * would report all 30 servers as changed every week: the workflow's
 * "nothing to deploy" guard would never fire and each Monday would ship a
 * no-op deploy whose diff is nothing but timestamps.
 */
function contentFingerprint(result) {
  const { last_attempt_at: _attempted, ...content } = result;
  return JSON.stringify(content);
}

async function scanOne(seed, now, options = {}) {
  const previous = await readLatest(seed.slug);
  const attemptedAt = now.toISOString();

  const settle = (outcome, result) => ({
    outcome,
    result,
    changed: previous === undefined || contentFingerprint(previous) !== contentFingerprint(result)
  });

  if (options.skipStdio && seed.transport === "stdio" && !seed.snapshot_override) {
    return { outcome: "skipped", result: previous ?? emptyResult(seed, attemptedAt), changed: false };
  }

  let snapshot;
  try {
    snapshot = await capture(seed);
  } catch (error) {
    const authRequired = error instanceof AuthRequiredError;
    const message = error instanceof Error ? error.message : String(error);
    // Keep the last good payload either way. A page that went dark for one week
    // should say "last successful scan: <date>", not lose its content.
    return settle(authRequired ? "needs-snapshot" : "unreachable", {
      ...(previous ?? emptyResult(seed, attemptedAt)),
      slug: seed.slug,
      status: authRequired ? "needs-snapshot" : "unreachable",
      last_error: authRequired
        ? `${message.slice(0, 400)} Commit a snapshot_override to include this server.`
        : message.slice(0, 500),
      last_attempt_at: attemptedAt,
      engine_version: ENGINE_VERSION
    });
  }

  const hash = snapshotHash(snapshot.tools);
  const unchanged =
    previous?.status === "ok" &&
    previous.snapshot_hash === hash &&
    previous.engine_version === ENGINE_VERSION;

  if (unchanged) {
    // Idempotence: same surface, same engine. Do not touch `scanned_at` — the
    // sitemap's lastmod is derived from it and must reflect real change.
    return settle("unchanged", { ...previous, last_attempt_at: attemptedAt, last_error: null });
  }

  return settle("ok", {
    slug: seed.slug,
    scanned_at: attemptedAt,
    engine_version: ENGINE_VERSION,
    status: "ok",
    last_error: null,
    last_attempt_at: attemptedAt,
    snapshot_hash: hash,
    ...lint(snapshot)
  });
}

function emptyResult(seed, at) {
  return {
    slug: seed.slug,
    scanned_at: at,
    engine_version: ENGINE_VERSION,
    status: "needs-snapshot",
    last_error: null,
    last_attempt_at: at,
    snapshot_hash: null,
    server_info: {},
    score: null,
    token_footprint: null,
    tool_count: null,
    findings: [],
    tools: []
  };
}

async function write(result, writeDated) {
  const dir = path.join(RESULTS, result.slug);
  await mkdir(dir, { recursive: true });
  const json = `${JSON.stringify(result, null, 2)}\n`;
  await writeFile(path.join(dir, "latest.json"), json, "utf8");
  if (writeDated) {
    const date = result.scanned_at.slice(0, 10);
    await writeFile(path.join(dir, `${date}.json`), json, "utf8");
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seeds = parse(await readFile(path.join(DATA, "seeds/servers.yaml"), "utf8"));
  const targets = args.slug ? seeds.filter((s) => s.slug === args.slug) : seeds;
  if (targets.length === 0) throw new Error(`No seed matches --slug ${args.slug}`);

  const now = new Date();
  const results = await mapWithConcurrency(targets, args.concurrency, async (seed) => {
    const started = Date.now();
    const outcome = await scanOne(seed, now, { skipStdio: args.skipStdio });
    // An unchanged result is deliberately left untouched on disk. The record
    // that we did look lives in the workflow run and the summary below; a file
    // rewritten only to bump a timestamp would force a commit and a deploy.
    if (outcome.changed) await write(outcome.result, outcome.outcome === "ok");
    const ms = Date.now() - started;
    console.log(
      `${outcome.outcome.padEnd(14)} ${seed.slug.padEnd(20)} ${String(ms).padStart(6)}ms` +
        (outcome.result.last_error ? `  ${outcome.result.last_error.split("\n")[0]}` : "")
    );
    return outcome;
  });

  const tally = results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
  const date = now.toISOString().slice(0, 10);
  const parts = Object.entries(tally).map(([k, v]) => `${v} ${k}`);
  const summary = `scan: ${date} (${parts.join(", ")})`;
  const changed = results.filter((r) => r.changed).map((r) => r.result.slug);

  console.log(`\n${summary}`);
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(
      process.env.GITHUB_OUTPUT,
      `summary=${summary}\nchanged=${changed.join(",")}\n`,
      { flag: "a" }
    );
  }
}

await main();
