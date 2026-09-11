import type { EnvironmentTruth, TruthContext, TruthFinding, TruthReport } from './domain.js';
import { REPORT_SCHEMA_VERSION, truthReportSchema } from './domain.js';
import { evaluateRules, type TruthRule } from './rules.js';
import { buildEnvironmentTopology, mergeTopologies } from './topology.js';
import { aggregateVerdict } from './verdict.js';

const sortedEntries = <T>(record: Readonly<Record<string, T>>): readonly [string, T][] =>
  Object.entries(record).sort(([left], [right]) => left.localeCompare(right));

export interface EvaluateTruthOptions {
  /**
   * Restricts evaluation to these environment ids. Cross-environment declarations and
   * observations remain fully visible to rules via `allDeclarations`/`allObservations`.
   */
  readonly environments?: readonly string[];
}

export const evaluateTruth = (
  context: TruthContext,
  rules?: readonly TruthRule[],
  options?: EvaluateTruthOptions,
): TruthReport => {
  const environments: EnvironmentTruth[] = [];
  const allFindings: TruthFinding[] = [];
  const topologies = [];

  const selected = options?.environments;
  for (const [environmentId, declaration] of sortedEntries(context.declaration.environments)) {
    if (selected !== undefined && !selected.includes(environmentId)) {
      continue;
    }
    const observation = context.observations.environments[environmentId];
    const findings = evaluateRules(
      {
        project: context,
        environment: declaration,
        ...(observation ? { observation } : {}),
        allDeclarations: context.declaration.environments,
        allObservations: context.observations.environments,
      },
      rules,
    );
    const verdict = aggregateVerdict(findings, { strict: context.strict });
    environments.push({
      environment: environmentId,
      declaration,
      ...(observation ? { observation } : {}),
      findings: [...findings],
      verdict,
    });
    allFindings.push(...findings);
    topologies.push(buildEnvironmentTopology(declaration, observation, findings));
  }

  const report: TruthReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: context.generatedAt,
    project: context.declaration.project,
    strict: context.strict ?? false,
    verdict: aggregateVerdict(allFindings, { strict: context.strict }),
    environments,
    findings: allFindings.sort((left, right) => {
      const environmentOrder = left.affectedComponents[0]?.environment.localeCompare(
        right.affectedComponents[0]?.environment ?? '',
      );
      return environmentOrder === 0 ? left.code.localeCompare(right.code) : (environmentOrder ?? 0);
    }),
    topology: mergeTopologies(topologies),
    metadata: {
      engine: 'deploytruth-core',
      reportSchemaVersion: REPORT_SCHEMA_VERSION,
    },
  };

  return truthReportSchema.parse(report);
};
