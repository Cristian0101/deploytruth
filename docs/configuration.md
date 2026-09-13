# Configuration reference

DeployTruth reads `deploytruth.yml` from the current directory unless `--config <path>` is
provided. The manifest contains identifiers and expectations only. Never put tokens, passwords,
database URLs, certificates, or environment values in it.

## Minimal shape

```yaml
version: 1
project: my-app

environments:
  production:
    source:
      provider: github
      repository: acme/my-app
      branch: main
```

`version`, `project`, and at least one environment are required. Provider sections are optional;
enable only the checks for which the environment declares enough evidence.

## Top-level keys

| Key            | Required | Current value                           |
| -------------- | -------- | --------------------------------------- |
| `version`      | yes      | `1`                                     |
| `project`      | yes      | non-empty local project name            |
| `environments` | yes      | map with at least one named environment |

Unknown keys are rejected.

## Environment keys

| Key                              | Required | Meaning                                                                                                                       |
| -------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `kind`                           | no       | `production`, `preview`, `staging`, `development`, or `custom`; inferred from a matching environment name, otherwise `custom` |
| `source`                         | no       | GitHub authoritative source declaration                                                                                       |
| `deployment`                     | no       | Vercel production declaration                                                                                                 |
| `database`                       | no       | Supabase identity and migration declaration                                                                                   |
| `runtime`                        | no       | public-safe runtime attestation endpoint                                                                                      |
| `required_environment_variables` | no       | names that the runtime must report as present; values are never returned                                                      |
| `checks`                         | no       | explicit check switches; all default to disabled when omitted                                                                 |

### `source`

```yaml
source:
  provider: github
  repository: acme/my-app
  branch: main
```

- `provider` must be `github`.
- `repository` is an `owner/repo` identifier, not a URL.
- `branch` is the authoritative branch to compare.

### `deployment`

```yaml
deployment:
  provider: vercel
  project: my-app
  target: production
  scope: acme-team
  domain: app.example.com
```

- `provider` must be `vercel`.
- `project` accepts a Vercel project name or `prj_…` id.
- `target` is optional and currently supports only `production`.
- `scope` is optional and accepts a team slug or `team_…` id.
- `domain` is optional and must be a bare hostname with no scheme, port, or path.

### `database`

```yaml
database:
  provider: supabase
  project_ref: yourprojectref
  migrations:
    directory: supabase/migrations
```

- `provider` must be `supabase`.
- `project_ref` is the lowercase Supabase project ref.
- `migrations.directory` is optional and defaults to `supabase/migrations`. It must be a safe,
  repository-relative path.

### `runtime`

```yaml
runtime:
  url: https://app.example.com/api/deploytruth/runtime
  expected_environment: production
```

- `url` is required when the section exists. HTTPS is required outside localhost by the runtime
  transport.
- `expected_environment` is optional. When present, it must match the environment reported by the
  runtime.

The endpoint must implement the versioned, nonce-bound contract in [runtime truth](runtime-truth.md).

### `checks`

Every current check key is boolean:

| Key                     | Evidence family                           |
| ----------------------- | ----------------------------------------- |
| `local_git`             | local checkout state                      |
| `remote_source`         | authoritative GitHub source               |
| `deployment_sha`        | Vercel deployment and source relationship |
| `migrations`            | Supabase identity and migration history   |
| `runtime_identity`      | running SHA and fresh attestation         |
| `environment_isolation` | database/environment relationship truth   |
| `environment_variables` | allowlisted runtime variable presence     |

If an enabled check lacks the required observation, DeployTruth emits
`REQUIRED_OBSERVATION_UNAVAILABLE` instead of claiming a fully verified pass.

## Credential environment variables

| Provider                | Preferred variable                  | Accepted fallback                                                              |
| ----------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| GitHub                  | `DEPLOYTRUTH_GITHUB_TOKEN`          | `GITHUB_TOKEN`; no token is valid for public repositories at lower rate limits |
| Vercel                  | `DEPLOYTRUTH_VERCEL_TOKEN`          | `VERCEL_TOKEN`                                                                 |
| Supabase Management API | `DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN` | `SUPABASE_ACCESS_TOKEN`                                                        |
| Supabase PostgreSQL     | `DEPLOYTRUTH_SUPABASE_DATABASE_URL` | none; generic `DATABASE_URL` is deliberately ignored                           |

For a private CA chain, use Node's `NODE_EXTRA_CA_CERTS` with the provider's public CA file. TLS
verification is never disabled. Runtime application variables such as `SUPABASE_URL` are checked
by name through `required_environment_variables`; their values do not belong in the manifest or
report.

Run `deploytruth doctor --config <path>` after editing. The complete example is
[`deploytruth.example.yml`](../deploytruth.example.yml).
