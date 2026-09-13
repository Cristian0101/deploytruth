# DeployTruth documentation

Start here after the root [README](../README.md). User guides come first; implementation and
release-maintainer material are separated below.

## Use DeployTruth

| Guide                                         | Use it when you need to…                                              |
| --------------------------------------------- | --------------------------------------------------------------------- |
| [Configuration](configuration.md)             | declare an environment and provide credential variable names          |
| [CLI reference](cli.md)                       | run `init`, `doctor`, `check`, `open`, `history`, or `diff`           |
| [Finding reference](findings.md)              | understand a finding code and what to investigate                     |
| [Troubleshooting](troubleshooting.md)         | resolve provider, Git, TLS, runtime, migration, or local UI problems  |
| [GitHub Action](github-action.md)             | certify in CI and upload the sanitized evidence bundle                |
| [Security model](security.md)                 | understand read-only access, redaction, storage, and trust boundaries |
| [Local visual report](local-visual-report.md) | use the Truth Map, Inspector, Report, and History views               |
| [Report history](report-history.md)           | inspect local storage and semantic run comparison                     |

## Provider truth

- [Local Git truth](git-truth.md)
- [GitHub authoritative source truth](github-truth.md)
- [Vercel production truth](vercel-truth.md)
- [Runtime connection truth](runtime-truth.md)
- [Supabase identity and migration truth](supabase-truth.md)

These pages describe the evidence DeployTruth can and cannot establish. Missing evidence remains
`UNKNOWN`/`WARN`; it is not replaced with a guess from another provider.

## Architecture and contributors

- [Architecture](architecture.md)
- [Provider authoring](provider-authoring.md)
- [Architecture decision records](adr/)
- [Contributing](../CONTRIBUTING.md)
- [Security reporting](../SECURITY.md)

## Maintainer and acceptance material

- [Controlled live acceptance](live-acceptance.md)
- [Release process](releasing.md)

The acceptance fixture is a technical dogfood target, not a user template. Release instructions
are for maintainers and never authorize publishing, tagging, or moving release refs on their own.
