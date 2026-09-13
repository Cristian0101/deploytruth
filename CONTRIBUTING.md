# Contributing to DeployTruth

DeployTruth is early and pre-1.0. Focused issues and pull requests that preserve its local-first,
read-only, deterministic, and secret-safe model are welcome.

## Development setup

Use Node.js 22 or later and the pnpm version pinned in `package.json`.

```bash
git clone https://github.com/Cristian0101/deploytruth.git
cd deploytruth
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

Create a focused branch and keep unrelated work out of the pull request. DeployTruth uses
protected `main`; changes are reviewed and merged through normal pull requests after CI passes.

`pnpm build` also rebuilds `packages/github-action/dist/index.js` — the committed bundle the
root `action.yml` executes. CI fails if the committed bundle drifts from its sources, so always
rebuild and commit it after touching anything the Action can reach
(`packages/github-action`, `cli`, `reporter`, `core`, `config`, `providers`).

Before opening a pull request, run every command above plus `pnpm test:e2e`. For release-sensitive
packaging or Action changes, run `pnpm release:check`. Describe the behavior change, evidence, and
security implications. Add or update tests for changed truth semantics.

## Choose the right contribution path

- Use the bug template for a reproducible defect with a sanitized reproduction.
- Use the provider request template for a new integration and identify the authoritative,
  read-only evidence source.
- Use the feature request template for a truth capability that is not provider-specific.
- Report vulnerabilities privately through `SECURITY.md`, never in a public issue.

Documentation, fixture, and test improvements are welcome when they describe real current
behavior. Do not manufacture certainty, provider support, benchmarks, or roadmap promises.

## Changing a rule

Keep evidence collection in provider adapters and deterministic evaluation in `packages/core`.
Add scenario/unit coverage for PASS, contradiction, missing evidence, and topology attribution as
applicable. Update `docs/findings.md`; its drift test must still match the rule registry exactly.

## Changing or adding a provider

Read [`docs/provider-authoring.md`](docs/provider-authoring.md) first. A provider must have a
narrow authoritative source, a read-only transport, normalized observations, safe failure modes,
and negative secret-leakage tests. Provider access failure must produce honest unavailable
evidence rather than a fallback claim.

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
