# ADR 001: Keep provider APIs outside core

## Status

Accepted

## Decision

`@deploytruth/core` owns only provider-neutral declared state, observations, rules, reports, and
topology. Provider adapters translate their APIs before returning to core.

## Consequences

Rules remain deterministic and fixture-testable without credentials. Provider changes are localized
to adapters. The intentional mapping code is preferable to spreading SDK assumptions through the
product.
