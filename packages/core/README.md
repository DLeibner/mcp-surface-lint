# mcplint

**Lighthouse for MCP servers.** A local-first, static linter for [Model Context Protocol](https://modelcontextprotocol.io) tool surfaces — deterministic, fast, free, and offline. No LLM calls, ever.

Existing MCP linters check hygiene: "description too short", "missing schema". mcplint checks **design**: is your tool surface something an agent can actually use well?

- **`design/overlap-cluster`** — six `get_hotel_*` tools that are really one tool with include-flags
- **`design/crud-mirror`** — a get/create/update/delete family per noun, the fingerprint of OpenAPI autogen
- **`design/client-directives`** — "ALWAYS RENDER RESULTS IMMEDIATELY" blocks copy-pasted across tools, with their token cost
- **`design/confusable-params`** — `hotel_id` vs `hotelId` vs `id` across tools
- …plus the full hygiene tier (budgets, naming, annotations, loose schemas). See the [rule catalog](docs/rules.md).

And one headline stat that is not a score:

```
tools/list footprint: ~11,204 tokens per conversation (64 tools)
```

That payload is injected into **every conversation** that connects your server, before the first user message.

## Usage

```bash
npx mcp-surface-lint --stdio "node dist/server.js"      # spawn + connect via stdio
npx mcp-surface-lint https://mcp.example.com/mcp        # streamable HTTP
npx mcp-surface-lint snapshot.json                      # offline: a saved tools/list dump
npx mcp-surface-lint --stdio "…" --dump snapshot.json   # capture a snapshot, then exit
```

Offline snapshots are first-class, not a fallback: they make CI trivial, work for private servers, and your schemas never leave the machine. Dumps may use MCP `tools[].name` or the Cursor-style `tools[].tool` alias — both normalize to the same snapshot.

### Options

| Flag | Effect |
|---|---|
| `--json` / `--md` | machine-readable / PR-comment-friendly output |
| `--fail-under <score>` | non-zero exit if the composite score is lower (CI gate) |
| `--explain <ruleId>` | print a rule's rationale and docs link |
| `--config <path>` | explicit config path (default: `./.mcplintrc.json`) |
| `--dump <file>` | write the captured snapshot and exit |

### Configuration

`.mcplintrc.json`:

```json
{
  "failUnder": 80,
  "rules": {
    "surface/tool-budget": { "options": { "warnAt": 15, "errorAt": 30 } },
    "descriptions/too-short": "error",
    "design/enum-combination-unencoded": "off"
  }
}
```

Each rule takes `"off"`, a severity override (`"info"` / `"warn"` / `"error"`), or `{ severity?, options? }`.

## Scoring

Lighthouse-style: six category scores (surface, naming, descriptions, schemas, annotations, design) from weighted, per-rule-capped deductions, averaged into one composite. Deterministic and explainable — `--explain <ruleId>` shows why any rule exists. `info` findings (including positive checks like `design/negative-guidance-present`) never deduct.

Token counts use the `o200k_base` encoding via [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) and are labelled approximate — different models tokenize differently, but the order of magnitude is what matters.

## Programmatic API

```ts
import { SnapshotLoader, LintEngine, RuleRegistry, ConfigLoader } from "mcp-surface-lint";

const snapshot = await SnapshotLoader.fromFile("snapshot.json");
const report = new LintEngine(RuleRegistry.all(), ConfigLoader.empty()).run(snapshot);
console.log(report.scores.composite, report.findings.length);
```

Rules are pure functions over a plain snapshot object — adding one means implementing `check(snapshot, options): Finding[]` and registering it. See [docs/rules.md](docs/rules.md).

## Development

```bash
npm install
npm test           # vitest, includes golden-report snapshots over the fixtures
npm run build      # tsup → dist/
npm run lint:bad   # demo run against the seeded-bad fixture
```

## Boundaries

- **Static analysis only.** mcplint reads `tools/list`; it never invokes a tool.
- **No LLM calls in the CLI.** Behavioral evaluation is a separate concern, out of scope here.
- Snapshots under `fixtures/private/` are gitignored — put customer/production dumps there.

## Status

Published on npm as [`mcp-surface-lint`](https://www.npmjs.com/package/mcp-surface-lint). The CLI command remains `mcplint`.
