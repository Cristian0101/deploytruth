# DeployTruth M6 Design QA

## Review setup

- Reference 1: `Screenshot 2026-09-12 at 3.12.29 PM.png` — healthy Truth Map.
- Reference 2: `Screenshot 2026-09-12 at 3.12.38 PM.png` — deployment mismatch Truth Map.
- Reference 3: `Screenshot 2026-09-12 at 3.12.45 PM.png` — Report view.
- Reference 4: `Screenshot 2026-09-12 at 3.12.55 PM.png` — Inspector composition.
- Implementation captures: `output/playwright/m6/healthy-map.png`, `sha-mismatch.png`,
  `report.png`, and `inspector.png`.
- Comparison viewport: 1680 × 1260 CSS pixels for all four implementation captures.

## Reference 1 — healthy Truth Map

The implementation matches the reference's dark local-tool shell, compact project context, strong
Truth Map heading, five-stage vertical evidence chain, visible relationship labels, status legend,
and persistent summary. All labels and facts come from the normalized fixture report. Relative to
the reference, cards intentionally omit URLs, timestamps, and branded provider marks that are not
guaranteed by the report schema.

## Reference 2 — deployment mismatch Truth Map

The failed GitHub → Vercel relationship is isolated and selectable. GitHub remains operational,
Vercel remains `READY`, and the matching Vercel → Runtime relationship remains verified. The
topology correction removed the duplicate downstream failure exposed by the earlier halted QA.
The implementation uses the finding's normalized title instead of inventing a second explanatory
sentence inside the edge card.

## Reference 3 — Report view

The implementation preserves the reference hierarchy: environment heading, prominent verdict,
verified count, structured check rows, findings summary, evidence-source rail, and run summary. It
shows only evidence sources actually present in the `TruthReport`; duration, scheduling, full logs,
and push/deployment times are intentionally absent because the schema does not provide them.

## Reference 4 — Inspector

The implementation follows the reference's fixed right rail, finding code, status and severity,
plain-language explanation, expected/observed contrast, evidence list, and remediation. The status
legend is hidden while the rail is open so it cannot overlap evidence. The Inspector deliberately
deviates from the reference's stale semantic placement: the reference visually failed the Vercel
node/downstream edge, while the certified implementation keeps Vercel `READY` and opens the finding
from the failed GitHub → Vercel relationship. Provider endpoints, response codes, timestamps, and
external action links are omitted unless present in the normalized report.

## State certification

- Healthy: PASS, five healthy stages, both SHA relationships verified.
- Deployment mismatch: FAIL only on source → deployment; deployment → runtime stays verified.
- Runtime mismatch: FAIL only on deployment → runtime.
- Warning: visually distinct amber warning count and relationship state.
- Unknown: missing evidence stays UNKNOWN rather than being promoted to verified.
- Multiple findings: source → deployment fails, deployment → runtime stays verified, and runtime →
  database warns independently.
- Inspector: opens only from a finding-bearing relationship and closes with Escape.
- Report: renders the same verdict, counts, findings, observations, and evidence sources as the map.

## Follow-up polish

- Product-specific provider logos can replace the local icon set if canonical, redistributable
  assets are added later.
- A bundled product font can replace the current local system/mono stack if DeployTruth adopts one.

final result: pass
