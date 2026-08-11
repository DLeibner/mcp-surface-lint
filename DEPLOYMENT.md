# Production release runbook

Production releases are immutable Git tags. `.github/workflows/release.yml` verifies the tag,
deploys and smoke-tests the web app, publishes the npm package with provenance, and then publishes
the remote server metadata to the official MCP Registry. A failure stops every downstream job.

## Release order

1. **Verify** — require a `<semver>` tag on `main` that exactly matches the root
   `package.json` version; install the frozen npm lockfile; typecheck; run all Vitest
   unit/protocol tests; run Playwright Chromium; build; render and validate release-specific
   `server.json` metadata; run npm pack/publish dry runs; and save both verified artifacts.
2. **Deploy** — pull the linked Vercel production settings, build with pinned Vercel CLI 56.3.2,
   deploy the prebuilt output, and smoke-test the actual production origin.
3. **Publish npm** — publish the verified `mcp-surface-lint` tarball as public with GitHub OIDC and npm
   provenance. If that exact immutable version already exists, a rerun skips it.
4. **Publish MCP Registry metadata** — revalidate the rendered `server.json` artifact, authenticate
   the `io.github.DLeibner` namespace with GitHub OIDC, and publish that exact artifact. An existing
   exact version is skipped, so reruns never overwrite registry metadata.

The npm and MCP Registry jobs cannot run until the production deployment and its `/`, `/install`,
`/rules`, MCP `initialize`, `tools/list`, and snapshot `tools/call` checks have passed.

## One-time GitHub setup

Create a GitHub Environment named exactly `Production` in `DLeibner/mcp-surface-lint`:

- Add a required reviewer.
- Prevent self-review if another maintainer is available.
- Restrict deployment tags to `*.*.*` (bare semver tags such as `0.1.1`, not `v0.1.1`).
- Keep the `main` branch protected and require CI before release commits are pushed.

Add these **Environment secrets** to `Production` (not repository variables and never committed):

| Name | Value |
| --- | --- |
| `VERCEL_TOKEN` | A least-privilege Vercel access token that can deploy this project |
| `VERCEL_ORG_ID` | The linked Vercel team/account ID |
| `VERCEL_PROJECT_ID` | The linked Vercel project ID |

Add this **Environment variable**:

| Name | Value |
| --- | --- |
| `NEXT_PUBLIC_SITE_URL` | The canonical HTTPS production origin, currently `https://mcplint-web.vercel.app` |

`NEXT_PUBLIC_SITE_URL` must be an origin only: no path, query, fragment, or trailing route. The
release smoke test also requires `server.json` to advertise this same origin.

Do not add `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or an MCP Registry token. The two publishing jobs use
short-lived GitHub OIDC credentials and request `id-token: write` only on those jobs.

## One-time Vercel and data-service setup

A Vercel project must be imported and linked once **before** `VERCEL_ORG_ID` and
`VERCEL_PROJECT_ID` exist. From the monorepo root:

```bash
npx vercel@56.3.2 login
npx vercel@56.3.2 link --repo
cat .vercel/project.json
```

Select the `DLeibner/mcp-surface-lint` repository and the web project. `.vercel/project.json` supplies
`orgId` and `projectId`; copy those values to the GitHub Environment secrets above. `.vercel/` is
gitignored and must stay uncommitted.

Configure the Vercel project:

- Root Directory: `apps/web`
- Include source files outside the Root Directory: enabled
- Framework: Next.js
- Node.js: 24
- Install Command: `cd ../.. && npm ci`
- Build Command:
  `cd ../.. && npm run build -w mcp-surface-lint && npm run build -w mcp-surface-lint-web`
- Output Directory: `.next`

Configure these Vercel **Production** environment variables:

```text
NEXT_PUBLIC_SITE_URL=https://mcplint-web.vercel.app
DATABASE_URL=...
UPSTASH_REDIS_REST_URL=...   # must be a real https://... Upstash REST URL (not a placeholder)
UPSTASH_REDIS_REST_TOKEN=...
IP_HASH_SALT=...
CRON_SECRET=...
GATE_FINDINGS=false
NEXT_PUBLIC_POSTHOG_KEY=...       # optional
NEXT_PUBLIC_POSTHOG_HOST=...      # optional
```

Create the Neon database and apply the checked-in schema once:

```bash
export DATABASE_URL='the Neon connection string'
npm run db:migrate -w mcp-surface-lint-web
```

Create Upstash Redis and generate independent secrets:

```bash
openssl rand -hex 32 # IP_HASH_SALT
openssl rand -hex 32 # CRON_SECRET
```

Remote URL audits intentionally fail closed without Upstash. Report persistence falls back to
memory without Neon and is not durable. Apply future production database migrations before tagging
a release; the release workflow deliberately does not mutate the database.

The CLI workflow performs the production deployment. Git auto-deploy is disabled in
`apps/web/vercel.json` (`"git": { "deploymentEnabled": false }`) so pushes do not create a second,
unverified production path. The Vercel UI toggle for this varies by plan; the checked-in config is
the source of truth.

## One-time npm setup

The package `mcp-surface-lint` does not yet exist on npm. npm cannot attach a Trusted Publisher to a package
until a package record exists, so a one-time interactive bootstrap publish is unavoidable. Do this
from a disposable copy and publish version `0.0.0`, leaving this repository at `0.1.0`:

```bash
tmp="$(mktemp -d)"
git clone --local . "$tmp/mcplint"
cd "$tmp/mcplint"
npm ci
npm version 0.0.0 -w mcp-surface-lint --no-git-tag-version
npm run build -w mcp-surface-lint
npm login
npm publish ./packages/core --access public
npm deprecate mcp-surface-lint@0.0.0 "Bootstrap release; use 0.1.0 or newer."
npm logout
cd -
rm -rf "$tmp"
```

This uses an interactive npm session, not a long-lived CI token. Confirm the package owner is the
npm account that will administer releases.

Then open the `mcp-surface-lint` package settings on npmjs.com and configure its one Trusted Publisher:

- Provider: GitHub Actions
- Organization or user: `DLeibner`
- Repository: `mcp-surface-lint`
- Workflow filename: `release.yml` — filename only, exact case, including `.yml`
- Environment: `Production` — exact case (must match the GitHub Environment name)
- Allowed action: `npm publish`

Trusted Publisher configuration must point to the exact workflow filename and Environment or OIDC
authentication will fail. The workflow uses a GitHub-hosted runner, npm 12.0.1, `id-token: write`,
public access, and provenance. Do not store an npm token in GitHub.

## One-time MCP Registry setup

No Registry secret is required. The official Registry supports GitHub Actions OIDC for the personal
`io.github.DLeibner/*` namespace. The repository owner must be the `DLeibner` GitHub account; the
registry `name` must use that exact casing (GitHub OIDC permissions are case-sensitive). The workflow uses the checksum-verified
`mcp-publisher` v1.8.0 binary and runs:

```bash
mcp-publisher validate server.json
mcp-publisher login github-oidc
mcp-publisher publish server.json
```

The Registry is still in preview and may make breaking schema/API changes or reset data. If its
OIDC or schema behavior changes, update and re-verify the pinned publisher and checksum before the
next release. Registry publication is downstream of both the live endpoint smoke test and npm.

## Create a release

Start clean and up to date on the release branch:

```bash
git switch main
git pull --ff-only origin main
git status --short
```

### Default: bump every package and tag

One command bumps the root, syncs `mcp-surface-lint` and `mcp-surface-lint-web` to the same version, creates the
version commit, tags, and pushes — triggering `.github/workflows/release.yml`:

```bash
npm version patch
# or: npm version minor
# or: npm version major
```

Lifecycle hooks in root `package.json`:

- **`preversion`** — runs `npm run typecheck` before any version bump is committed.
- **`version`** — after npm bumps the root, runs
  `npm version "$npm_package_version" --workspaces --no-git-tag-version --allow-same-version --ignore-scripts`
  to align every workspace with the root semver, then stages workspace `package.json` files and
  `package-lock.json`. The nested `npm version` uses `--ignore-scripts` so the hook does not recurse.
- **`postversion`** — `git push origin $(git rev-parse --abbrev-ref HEAD) --tags`.

Tags are bare semver such as `0.1.5` (see `.npmrc`; `tag-version-prefix` is empty, not `v0.1.5`).

`npm version` has no `--dry-run` flag; use `npm help version` or a throwaway clone to verify behavior
before cutting a release.

### Advanced: bump one workspace only

When only the web app or only the CLI package changed, bump just that package plus the root. The
default `version` hook syncs **all** workspaces to the root version, which would also bump
`mcp-surface-lint` on a web-only release — so partial bumps must skip lifecycle scripts and finish manually.

The release tag still follows the root version, deploy always runs, and npm/Registry publication is
skipped automatically when `packages/core` was not bumped:

```bash
npm version patch -w mcp-surface-lint-web --include-workspace-root --ignore-scripts
# or: npm version patch -w mcp-surface-lint --include-workspace-root --ignore-scripts
# or: npm version minor|major -w mcp-surface-lint-web|mcp-surface-lint --include-workspace-root --ignore-scripts
git add package.json apps/*/package.json packages/*/package.json package-lock.json
git commit -m "$(node -p \"require('./package.json').version\")"
git tag "$(node -p \"require('./package.json').version\")"
git push origin HEAD --follow-tags
```

Review before pushing:

```bash
git show --stat --decorate HEAD
git tag --sort=-v:refname | head -n 3
```

Never create or force-move a release tag by hand. Never rerun a release command after a partial
failure; rerun the existing GitHub Actions workflow instead. npm and Registry exact versions are
immutable and the workflow safely skips versions that already exist.

## Post-release checks

The workflow performs automated route and MCP protocol smoke tests. After it succeeds:

```bash
npx mcp-surface-lint@<version> --help
npx mcp-surface-lint@<version> /path/to/a-sanitised-snapshot.json
```

Also confirm the npm package page shows provenance, the Vercel production alias targets the new
deployment, and the exact `io.github.DLeibner/mcp-surface-lint` version appears in the official MCP Registry.
Do not announce a release until all three external systems agree.

### Registry server id (`name`)

The MCP Registry treats `server.json` `name` as a stable server id (for example
`io.github.DLeibner/mcp-surface-lint`). Changing `name` publishes under a **new** id; it does not
rename or replace an existing listing. Published versions are immutable, so reruns skip an id/version
pair that already exists.

If you previously published under a different id (such as `io.github.DLeibner/mcplint`), that entry
can remain visible alongside the new one until the Registry offers an official delete, deprecate, or
redirect workflow. This repo does not automate that step — check the current
[Model Context Protocol Registry](https://github.com/modelcontextprotocol/registry) documentation or
support channels for what is available in preview. Keep `name` aligned with npm (`mcp-surface-lint`)
and the GitHub repo; keep `DLeibner` casing exactly as shown for GitHub OIDC.
