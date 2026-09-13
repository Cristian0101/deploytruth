# Troubleshooting

Start with:

```bash
deploytruth doctor
deploytruth check --environment production
```

DeployTruth distinguishes an execution error from honest unavailable evidence. A `WARN` or
`UNKNOWN` result often means a provider could not be observed safely; it is not silently replaced
with evidence from another layer.

## Missing provider credentials

- Public GitHub repositories may be read without a token at lower rate limits. Private GitHub
  repositories need `DEPLOYTRUTH_GITHUB_TOKEN` or `GITHUB_TOKEN`.
- Vercel needs `DEPLOYTRUTH_VERCEL_TOKEN` or `VERCEL_TOKEN`.
- Supabase control-plane truth needs `DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN` or
  `SUPABASE_ACCESS_TOKEN`.
- Database identity/history needs `DEPLOYTRUTH_SUPABASE_DATABASE_URL`; DeployTruth intentionally
  ignores generic `DATABASE_URL`.

Set the variable in the process or CI step running DeployTruth. Never paste its value into
`deploytruth.yml`, an issue, a report, or a screenshot.

## Vercel returns 403 or unavailable

Confirm that the token can read the declared project and that `deployment.scope` names the correct
team when the project is not personal. DeployTruth does not infer scope from local Vercel state.
A protected Preview URL is not the same thing as Vercel Management API access.

## GitHub is unavailable

Check the `owner/repo` and branch spelling, repository visibility, token access, and rate-limit
diagnostics from `doctor`. A local `origin/main` ref is not authoritative GitHub truth; run
`git fetch` to refresh it, but DeployTruth still observes the GitHub branch separately.

## Dirty worktree, no upstream, or stale tracking ref

These are Git truth findings, not provider outages:

- `DIRTY_WORKTREE`: commit, intentionally retain, or otherwise account for local changes.
- `NO_UPSTREAM_CONFIGURED`: configure the intended tracking branch.
- `STALE_TRACKING_REF`: run `git fetch` and compare again.
- `LOCAL_BRANCH_DIVERGED`: inspect both sides before choosing a reconciliation strategy.

DeployTruth never fetches, resets, checks out, pushes, or repairs Git state for you.

## Supabase TLS trust fails

DeployTruth requires verified TLS and refuses insecure `sslmode` options. Download the public
database root certificate from the Supabase project's Database Settings and expose it to Node
through `NODE_EXTRA_CA_CERTS`. Do not disable certificate or hostname verification, and do not
put certificate contents in the connection URL or manifest.

## Database identity is unverified

`database identity unverified` means the configured target could not be proven through a
successful verified PostgreSQL session. Check the explicit DeployTruth database URL, network
reachability, role access, TLS trust, and declared `project_ref`. A URL that merely looks like the
right project is not observed database identity.

## Migration history is unavailable

Confirm the migration directory exists in the declared source commit and that the read-only DB
role can read Supabase migration metadata. A missing history table or failed query remains
unavailable; DeployTruth never treats it as zero applied migrations.

## Runtime attestation is unavailable

Check the declared HTTPS URL, endpoint method (`GET`), JSON content type, response size, v1 shape,
nonce echo, and cache behavior. The reference contract is in [runtime truth](runtime-truth.md).
Control-plane deployment metadata is not a fallback for running-runtime truth.

## `deploytruth open` does not open a browser

Run:

```bash
deploytruth open --environment production --no-open
```

Open the printed `http://127.0.0.1:<port>` URL manually. The server intentionally binds only to
loopback, is not a network dashboard, and stops when the CLI process receives `Ctrl-C`. If the
port is occupied, omit `--port` to use an ephemeral port or choose another valid port.

## Still stuck

Search [finding codes](findings.md), then open a sanitized bug report. Include the DeployTruth
commit/version, Node version, exit code, finding codes, and a minimal redacted manifest. Never
include credentials, raw provider payloads, customer data, home-directory paths, or private
repository content.
