# Fixtures

Fixtures are sanitized, deterministic inputs only. They must never contain real tokens, database
URLs with credentials, cookie values, provider API payload dumps, or other secret material.

- Provider folders document normalized adapter outputs.
- `scenarios/` combines declared state and normalized observations for rule-engine tests.
- Local Git behavior is tested against real temporary repositories created by
  `tests/git-test-utils.ts` — never against this repository and never over the network.
- Tests must use fixtures or fake adapters, never live credentials.
