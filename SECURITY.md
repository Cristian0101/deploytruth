# Security Policy

## Supported versions

DeployTruth is pre-1.0. Security fixes are applied to the latest commit on `main`; no stable release
line is supported yet.

## Reporting a vulnerability

Please use GitHub private vulnerability reporting for this repository when available. Do not open
a public issue for a suspected vulnerability and do not include live credentials, customer data,
or exploit payloads in public discussion.

Include the affected component, impact, minimal reproduction, and any proposed mitigation. You
should receive an acknowledgement within seven days. Timelines for validation and remediation will
depend on severity and project maturity.

## Scope and guarantees

DeployTruth is designed for read-only observation, verified TLS, narrow fixed SQL queries, and
redacted reports. Those are design constraints, not a claim that this pre-1.0 software is free of
security defects. Operators remain responsible for using least-privilege credentials and isolated
test infrastructure.
