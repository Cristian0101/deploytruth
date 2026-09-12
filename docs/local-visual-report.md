# Local visual report

`deploytruth open` runs the normal read-only truth check and renders its normalized `TruthReport`
in a private local browser view. The Truth Map, Inspector, Report, History, and Comparison views
do not evaluate rules, compare runs, or contact providers; they are projections of reports and
`RunComparison` objects returned by core.

```bash
node packages/cli/dist/index.js open --config deploytruth.yml --environment production
node packages/cli/dist/index.js open --config deploytruth.yml --environment production --no-open
node packages/cli/dist/index.js open --report .deploytruth/reports/latest.json --no-open
```

The server binds only to `127.0.0.1` on an ephemeral port unless `--port` is supplied. Live mode
allows one constrained rerun of the same manifest and optional environment at a time. Saved-report
mode validates the report before serving it and disables reruns. `Ctrl-C` or `SIGTERM` closes the
server.

The local HTTP surface is intentionally narrow: static bundled assets, `GET /api/report`,
`GET /api/session`, `GET /api/history`, `GET /api/history/:runId`, `GET /api/compare`, and
authenticated `POST /api/rerun`. History and comparison resolve run IDs only through the report
store. Static `--report` mode returns `409` for history APIs (`Static report mode. History
unavailable.`) and does not search nearby directories. Reruns require the exact loopback Host and
Origin plus an ephemeral random session token, and they are disabled for historical snapshots.
Requests cannot select paths, commands, manifests, providers, or arbitrary environments. Traversal
is rejected, report responses are `no-store`, and defensive CSP, frame, referrer, and content-type
headers are applied. There is no history deletion or mutation endpoint.

The browser receives only already-redacted normalized reports and comparisons. It receives no raw
provider payload, process environment, filesystem API, shell API, provider proxy, or manifest
mutation capability. Historical snapshots reuse the same renderer with mode metadata (`latest`,
`historical`, `static`) and replace rerun with **Return to latest**.
