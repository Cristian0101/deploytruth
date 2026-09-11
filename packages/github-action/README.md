# DeployTruth GitHub Action boundary

This package deliberately does not ship a runnable action yet. M9 must call the CLI in JSON mode,
upload only the already-sanitized `TruthReport`, and map `FAIL` to a non-zero step result. It must
not replicate rules, call mutation-capable endpoints, or upload raw provider payloads.

The repository-level CI workflow in `.github/workflows/ci.yml` is active now and verifies the
foundation itself.
