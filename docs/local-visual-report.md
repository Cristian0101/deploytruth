# Local visual report

`deploytruth open` runs the normal read-only truth check and renders its normalized `TruthReport`
in a private local browser view. The Truth Map, Inspector, and Report view do not evaluate rules or
contact providers; they are projections of the same report returned by core.

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
`GET /api/session`, and authenticated `POST /api/rerun`. Reruns require the exact loopback Host and
Origin plus an ephemeral random session token. Requests cannot select paths, commands, manifests,
providers, or arbitrary environments. Traversal is rejected, report responses are `no-store`, and
defensive CSP, frame, referrer, and content-type headers are applied.

The browser receives only the already-redacted normalized report. It receives no raw provider
payload, process environment, filesystem API, shell API, provider proxy, or manifest mutation
capability.
