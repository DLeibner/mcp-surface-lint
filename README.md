# mcp-surface-lint

Static, design-level linting for MCP tool surfaces. Deterministic, offline, and it never calls an LLM.

This is a monorepo:

| Package | What it is |
| --- | --- |
| [`packages/core`](packages/core) | The linter — 19 rules, the scoring engine, and the `mcp-surface-lint` CLI (`mcp-surface-lint` on npm). Publishable to npm. |
| [`apps/web`](apps/web) | The hosted playground and the public directory (`mcp-surface-lint-web`): paste a `tools/list` dump or point it at a remote MCP URL, get a score and an audit. |
| [`data/`](data) | The directory's inputs and outputs: a hand-maintained seed list of public MCP servers, and one scan result per server. |

## Quick start

```bash
npm install
npm run build          # builds core (the web app imports it)

npm test               # every package
npm run dev            # the web app on http://localhost:3000
```

The web app runs with no cloud accounts configured: reports are held in memory, rate limiting is off,
and no analytics are sent. Copy `apps/web/.env.example` to `.env.local` to wire up the real services.
See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the production account, migration, publishing, and smoke-test
checklist.

## The directory

`/servers` publishes an audit of every server in [`data/seeds/servers.yaml`](data/seeds/servers.yaml),
one static page each, regenerated from a weekly scan.

```bash
npm run scan -- --skip-stdio       # public HTTP endpoints only; spawns nothing
npm run scan -- --slug context7    # re-scan one server
npm run scan                       # everything (CI only — see below)
```

A full scan executes third-party packages to read their `stdio` tool surfaces. That belongs in the
throwaway runner `.github/workflows/scan.yml` provides, not on a workstation; `--skip-stdio` is the
local mode. Whatever the mode, the scanner sends `initialize` and `tools/list` and nothing else — it
never invokes a tool and never authenticates. Servers behind OAuth are recorded as
`needs-snapshot` and left out of the index.

Results are written to `data/results/{slug}/`. A scan only rewrites a result when the tool surface
or the engine version actually changed, so the dates on the pages — and in the sitemap — mean
something.

Slugs are permanent public URLs. Rename by adding an entry to
[`data/redirects.yaml`](data/redirects.yaml), which becomes a real 301; never by editing a slug.

## Releases

Production releases are semver Git tags (bare `X.Y.Z`, no `v` prefix — see `.npmrc`). From a clean
`main` branch:

```bash
npm version patch
# or: npm version minor
# or: npm version major
```

That bumps the root version, runs `preversion` (`npm run typecheck`), then the `version` lifecycle
syncs `mcp-surface-lint` and `mcp-surface-lint-web` to the same semver, stages workspace `package.json` files and
`package-lock.json`, commits, and tags. `postversion` pushes the branch and tags to `origin`.

### Advanced: bump one workspace only

When only the web app or CLI changed, you may want a partial bump. The default `version` hook syncs
**all** workspaces to the root version, so partial bumps need `--ignore-scripts` and manual staging:

```bash
npm version patch -w mcp-surface-lint-web --include-workspace-root --ignore-scripts
# or: npm version patch -w mcp-surface-lint --include-workspace-root --ignore-scripts
git add package.json apps/*/package.json packages/*/package.json package-lock.json
git commit -m "$(node -p \"require('./package.json').version\")"
git tag "$(node -p \"require('./package.json').version\")"
git push origin HEAD --follow-tags
```

The release tag still follows the root version; deploy always runs, and npm/Registry publication is
skipped when `packages/core` was not bumped.

`npm version` has no `--dry-run`; inspect `npm help version` or run on a throwaway clone before
cutting a real release.

Full runbook: [`DEPLOYMENT.md`](DEPLOYMENT.md).

## The CLI

```bash
npm run lint:surface -- --stdio "node dist/server.js"
npm run lint:surface -- https://example.com/mcp
npm run lint:surface -- snapshot.json
```

See [`packages/core/README.md`](packages/core/README.md) for the full CLI, config, and scoring model,
and [`packages/core/docs/rules.md`](packages/core/docs/rules.md) for the rule catalogue.

## Hosted MCP server

The web app also serves a stateless Streamable HTTP MCP endpoint at `/api/mcp`. It exposes one
read-only tool, `check_mcp_server`, which accepts either a public HTTPS MCP URL (plus optional
headers) or an inline `tools/list` snapshot. To audit another MCP server already installed in the
client, agents should forward that server's tool definitions as `snapshot` (MCP `name` or
Cursor-style `tool` on each entry). The result includes structured composite/category scores,
footprint stats, and findings.

Each protocol request gets a fresh MCP server and transport. Tool inputs and captured schemas are
not written to the report store. See `/install` in the running web app for current Cursor, VS Code,
Claude, Windsurf, and generic client configurations.

## What the web app does and does not do

- **Ingest** is paste-a-dump or connect-to-an-https-URL. It never spawns a process, so stdio servers
  are a job for the CLI.
- **Remote capture is SSRF-guarded** ([`apps/web/lib/ssrf.ts`](apps/web/lib/ssrf.ts)): https only, every
  resolved address must be public unicast, the socket is pinned to the vetted IP so DNS rebinding
  cannot move it, and redirects are re-validated at every hop.
- **Reports are unlisted by default** — an unguessable URL, `noindex`, deleted after 30 days unless
  the owner opts them public. Anyone with an unlisted URL can view it.
- **The MCP endpoint is stateless** — unlike the interactive report workflow, it returns a report
  directly and does not persist the input, captured schemas, or result.
- **Everything is free.** The `GATE_FINDINGS` flag and `projectReport()` exist so a paid tier *could*
  withhold the audit while leaving the score free. It is off, and no billing exists.
