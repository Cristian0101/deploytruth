# Fixtures

Fixtures are sanitized, deterministic inputs only. They must never contain real tokens, database
URLs with credentials, cookie values, provider API payload dumps, or other secret material.

- Provider folders document normalized adapter outputs. `github/` fixtures are the normalized
  `remoteSource` observations — fabricated minimal API payloads live in `tests/github-test-utils.ts`
  so raw provider responses are never persisted here.
- `scenarios/` combines declared state and normalized observations for rule-engine tests.
- Local Git behavior is tested against real temporary repositories created by
  `tests/git-test-utils.ts` — never against this repository and never over the network.
- GitHub truth is tested through a static read-only transport (`tests/github-test-utils.ts`) —
  never over the network.
- Tests must use fixtures or fake adapters, never live credentials.
