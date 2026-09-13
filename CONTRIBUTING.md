# Contributing to DeployTruth

DeployTruth is early and pre-1.0. Focused issues and pull requests that preserve its local-first,
read-only, deterministic, and secret-safe model are welcome.

## Development setup

Use Node.js 22 or later and the pnpm version pinned in `package.json`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

`pnpm build` also rebuilds `packages/github-action/dist/index.js` — the committed bundle the
root `action.yml` executes. CI fails if the committed bundle drifts from its sources, so always
rebuild and commit it after touching anything the Action can reach
(`packages/github-action`, `cli`, `reporter`, `core`, `config`, `providers`).

Before opening a pull request, run every command above and describe the behavior change, evidence,
and security implications. Add or update tests for changed truth semantics.

## Project expectations

- Keep provider access read-only and narrowly scoped.
- Preserve `UNKNOWN` when evidence is unavailable.
- Never place credentials, customer data, or machine-specific paths in code, fixtures, reports,
  commits, issues, or pull requests.
- Use sanitized fixtures and isolated development resources.
- Keep rule evaluation deterministic and separate from provider transport.
- Do not add telemetry or hosted-account dependencies.

Security vulnerabilities should be reported privately as described in `SECURITY.md`, not in a
public issue.
