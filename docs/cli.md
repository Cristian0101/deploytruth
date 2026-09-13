# CLI reference

The published `deploytruth` package exposes one binary: `deploytruth`. It requires Node.js 22 or
later. Run `npx deploytruth@0.1.0 --version` to verify the current v0.1.0 release, or
`npx deploytruth --help` to use the latest compatible release without a global install.

## Common flow

```bash
deploytruth init
deploytruth doctor
deploytruth check --environment production
deploytruth open --environment production
```

Every command that reads a manifest accepts `-c, --config <path>` and defaults to
`deploytruth.yml`.

## `init`

Writes a safe starter manifest and refuses to overwrite an existing file.

```bash
deploytruth init
deploytruth init --config config/deploytruth.yml
```

## `doctor`

Validates the manifest, local Git access, declared provider configuration, credentials, and
provider diagnostics without producing a truth verdict.

```bash
deploytruth doctor
deploytruth doctor --json
```

Exit `0` means no diagnostic errors; exit `1` means the preflight or configuration failed.
Warnings such as absent optional/public-repository credentials remain visible.

## `check`

Runs the declared environment through local Git, enabled providers, the deterministic rules, and
the report writer.

```bash
deploytruth check --environment production
deploytruth check --environment production --strict
deploytruth check --environment production --json
deploytruth check --environment production --output deploytruth-report.json
```

Flags:

| Flag                       | Meaning                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| `-e, --environment <name>` | choose one declared environment; required when the manifest has more than one |
| `--strict`                 | convert warning-only truth to a failing verdict                               |
| `--json`                   | print the normalized serialized report instead of the human summary           |
| `--output <path>`          | write a copy of the normalized report; local history is still written once    |

Exit `0` means a valid `PASS` or non-strict `WARN`; exit `1` means a valid `FAIL`; exit `2` means
execution/configuration failed before a valid verdict. A missing observation is truth evidence,
not automatically an execution error.

## `open`

Runs a check, stores it in local history, and serves the visual report on `127.0.0.1`.

```bash
deploytruth open --environment production
deploytruth open --environment production --no-open
deploytruth open --environment production --port 43120
deploytruth open --report .deploytruth/reports/latest.json --no-open
```

`--report` opens a validated saved report without contacting providers. It cannot be combined
with `--environment`; History and reruns are unavailable in static-report mode. Stop the local
server with `Ctrl-C`. Startup or configuration errors exit `2`.

## `history`

Lists environment-scoped local runs, newest first.

```bash
deploytruth history --environment production
deploytruth history --environment production --limit 10
```

`--limit` must be a positive integer and defaults to `20`. Errors exit `2`.

## `diff`

Compares two normalized stored reports without contacting providers.

```bash
deploytruth diff --environment production
deploytruth diff --environment production --from <runId> --to <runId>
deploytruth diff --environment production --from <runId> --to latest
```

Without IDs, DeployTruth compares the latest two usable runs. Run IDs are resolved only inside
the selected project/environment history namespace. Errors exit `2`.

Use `deploytruth <command> --help` as the final authority for the installed binary's flags.
