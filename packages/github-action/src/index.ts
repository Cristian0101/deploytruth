/**
 * M9 boundary: the action will invoke the CLI's safe JSON report mode rather than duplicate
 * provider orchestration or verdict logic. This package intentionally contains no action runtime
 * until the CLI can perform live observations.
 */
export interface DeployTruthActionInputs {
  readonly config: string;
  readonly environment?: string;
  readonly strict?: boolean;
}

export interface DeployTruthActionOutputs {
  readonly verdict: 'PASS' | 'WARN' | 'FAIL';
  readonly reportPath: string;
}
