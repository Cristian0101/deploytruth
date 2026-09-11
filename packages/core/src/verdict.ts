import type { TruthFinding, Verdict } from './domain.js';

export const aggregateVerdict = (
  findings: readonly TruthFinding[],
  options: { readonly strict?: boolean | undefined } = {},
): Verdict => {
  if (findings.some((finding) => finding.status === 'FAIL')) {
    return 'FAIL';
  }

  if (findings.some((finding) => finding.status === 'WARN')) {
    return options.strict ? 'FAIL' : 'WARN';
  }

  return 'PASS';
};
