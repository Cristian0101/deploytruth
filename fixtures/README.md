# Fixtures

Fixtures are sanitized, deterministic inputs only. They must never contain real tokens, database
URLs with credentials, cookie values, provider API payload dumps, or other secret material.

- Provider folders document normalized adapter outputs.
- `scenarios/` combines declared state and normalized observations for rule-engine tests.
- Tests must use fixtures or fake adapters, never live credentials.
