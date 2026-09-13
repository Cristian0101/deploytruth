# DeployTruth

**git status for your deployed application.**

DeployTruth compares the deployment topology you declare (`deploytruth.yml`) with the state your
providers actually report — local Git, GitHub source, Vercel deployments, Supabase database
identity and migrations, and a runtime attestation endpoint — and returns one honest verdict:
PASS, WARN, or FAIL. It reports `UNKNOWN` when evidence is missing instead of fabricating
certainty.

DeployTruth is an early, pre-1.0 open-source release. Interfaces, configuration, and report
schemas may still change.

> Release-candidate note: the `deploytruth` npm package is not published yet. The install commands
> below are the intended v0.1 syntax; evaluate the current candidate from the repository source
> checkout until publication.

## Install

Requires Node.js 22 or later.

```bash
npm install -g deploytruth
deploytruth --help
```

or run it without installing:

```bash
npx deploytruth --help
```

## Get started

```bash
deploytruth init                       # writes a starter deploytruth.yml (never overwrites)
deploytruth doctor                     # validates the manifest and provider access
deploytruth check -e production        # PASS / WARN / FAIL with evidence-backed findings
deploytruth open -e production         # private loopback visual Truth Map report
deploytruth history -e production      # stored local runs
deploytruth diff -e production         # semantic comparison of two runs
```

Credentials come from environment variables — never from the manifest. See
[`deploytruth.example.yml`](https://github.com/Cristian0101/deploytruth/blob/main/deploytruth.example.yml)
for the full declaration shape and the
[repository README](https://github.com/Cristian0101/deploytruth#readme) for the security model.

## GitHub Action

The same truth engine runs in CI as a self-contained JavaScript Action:

```yaml
- uses: Cristian0101/deploytruth@v0 # pre-1.0
  with:
    environment: production
```

The moving `v0` Action ref is also created only during the release phase; it does not resolve yet.

## License

[Apache-2.0](https://github.com/Cristian0101/deploytruth/blob/main/LICENSE)
