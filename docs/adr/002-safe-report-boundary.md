# ADR 002: Reports are normalized and sanitized twice

## Status

Accepted

## Decision

Raw provider payloads are never report inputs. `reporter` validates a `TruthReport` and applies
recursive sanitization again before JSON serialization.

## Consequences

Reports can be stored locally and passed to the future viewer or CI without intentional secret
values. This defense does not replace adapter discipline; all adapter work requires leakage tests.
