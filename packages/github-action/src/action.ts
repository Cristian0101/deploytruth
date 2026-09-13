import { tmpdir } from 'node:os';
import { dirname } from 'node:path';

import type { CheckExecution, CheckOptions } from '@deploytruth/cli/check';
import { redactText, type TruthReport } from '@deploytruth/core';
import {
  buildTruthSummaryMarkdown,
  reportFindingCounts,
  serializeTruthReport,
} from '@deploytruth/reporter';

import { writeCiBundle, type CiBundlePaths } from './bundle.js';
import { buildCiMetadata } from './ci-metadata.js';
import { ActionInputError, parseActionInputs, resolveConfigPath } from './inputs.js';

/** Narrow IO surface — the entry binds it to @actions/core; tests bind in-memory fakes. */
export interface ActionIO {
  readonly info: (message: string) => void;
  readonly warning: (message: string) => void;
  readonly setOutput: (name: string, value: string) => void;
  readonly writeSummary: (markdown: string) => Promise<void>;
  readonly fail: (message: string) => void;
}

export interface RawActionInputs {
  readonly environment?: string | undefined;
  readonly config?: string | undefined;
  readonly failOn?: string | undefined;
}

export interface ActionDeps {
  readonly inputs: RawActionInputs;
  /** Process environment: provider credentials and GitHub context live here, never in inputs. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The existing certified orchestration — one call produces the single TruthReport. */
  readonly runCheck: (options: CheckOptions) => Promise<CheckExecution>;
  /** Local M7 history write; identical to what `deploytruth check` does after evaluation. */
  readonly persistReport?: (rootDirectory: string, report: TruthReport) => Promise<unknown>;
  readonly io: ActionIO;
  /** Explicit workspace override for harnesses; real runs use GITHUB_WORKSPACE. */
  readonly workspace?: string | undefined;
  /** Explicit temp-root override for harnesses; real runs use RUNNER_TEMP. */
  readonly tempRoot?: string | undefined;
  readonly now?: () => Date;
}

export type ActionOutcome =
  | {
      readonly status: 'success';
      readonly report: TruthReport;
      readonly bundle: CiBundlePaths;
      readonly environment: string;
    }
  | { readonly status: 'failed'; readonly report?: TruthReport; readonly message: string };

/** Action output names declared in action.yml; every name must be emitted for a valid run. */
export const ACTION_OUTPUT_NAMES = [
  'verdict',
  'run-id',
  'verified',
  'warnings',
  'failures',
  'findings',
  'report-path',
  'summary-path',
  'metadata-path',
  'artifact-directory',
  'environment',
] as const;

/** Events that must never execute secret-bearing certification. */
const REFUSED_EVENTS: Readonly<Record<string, string>> = {
  pull_request_target:
    'pull_request_target runs workflows from the trusted branch but can check out untrusted fork code while repository secrets remain exposed. Secret-bearing infrastructure certification must run from trusted events (workflow_dispatch, push to a protected branch, or a trusted post-deployment workflow).',
};

const executionFailureSummary = (message: string): string =>
  `# DeployTruth\n\n**ERROR**\n\nDeployTruth execution failed before certification.\n\n${message
    // eslint-disable-next-line no-control-regex -- deliberately strips control characters
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .replace(/([\\`*_[\]|])/g, '\\$1')
    .replace(/\r?\n/g, ' ')
    .slice(0, 500)}\n`;

export const runAction = async (deps: ActionDeps): Promise<ActionOutcome> => {
  const { io } = deps;
  try {
    const eventName = deps.env['GITHUB_EVENT_NAME'];
    if (eventName !== undefined && REFUSED_EVENTS[eventName] !== undefined) {
      throw new ActionInputError(
        `Refusing to run under the "${eventName}" event. ${REFUSED_EVENTS[eventName]}`,
      );
    }

    const inputs = parseActionInputs(deps.inputs);
    const workspace = deps.workspace ?? deps.env['GITHUB_WORKSPACE'];
    if (workspace === undefined || workspace.trim().length === 0) {
      throw new ActionInputError(
        'GITHUB_WORKSPACE is not set; the Action requires a checked-out repository workspace.',
      );
    }
    const configPath = resolveConfigPath(workspace, inputs.config);

    io.info(`DeployTruth: certifying environment "${inputs.environment}" (${inputs.config})`);
    const execution = await deps.runCheck({
      configPath,
      environmentName: inputs.environment,
      env: deps.env,
    });
    const report = execution.report;
    await deps.persistReport?.(dirname(configPath), report);

    const summaryMarkdown = buildTruthSummaryMarkdown(report);
    const metadata = buildCiMetadata({
      env: deps.env,
      report,
      environment: execution.environmentId,
      generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    });
    const bundle = await writeCiBundle({
      tempRoot: deps.tempRoot ?? deps.env['RUNNER_TEMP'] ?? tmpdir(),
      runId: report.runId,
      reportJson: serializeTruthReport(report),
      summaryMarkdown,
      metadata,
    });

    // Summary and outputs are always written before the fail policy so a failed
    // certification still leaves complete, safe evidence behind.
    await io.writeSummary(summaryMarkdown);
    const counts = reportFindingCounts(report);
    const outputs: Record<(typeof ACTION_OUTPUT_NAMES)[number], string> = {
      verdict: report.verdict,
      'run-id': report.runId,
      verified: String(counts.verified),
      warnings: String(counts.warnings),
      failures: String(counts.failures),
      findings: String(counts.findings),
      'report-path': bundle.reportPath,
      'summary-path': bundle.summaryPath,
      'metadata-path': bundle.metadataPath,
      'artifact-directory': bundle.directory,
      environment: execution.environmentId,
    };
    for (const [name, value] of Object.entries(outputs)) {
      io.setOutput(name, value);
    }
    io.info(
      `DeployTruth verdict: ${report.verdict} (${counts.verified} verified, ${counts.warnings} warnings, ${counts.failures} failures) — run ${report.runId}`,
    );

    if (report.verdict === 'FAIL') {
      if (inputs.failOn === 'never') {
        io.warning('DeployTruth verdict is FAIL; fail-on=never keeps this step successful.');
      } else {
        io.fail('DeployTruth verdict is FAIL.');
        return { status: 'failed', report, message: 'verdict FAIL' };
      }
    } else if (report.verdict === 'WARN') {
      if (inputs.failOn === 'warn') {
        io.fail('DeployTruth verdict is WARN; fail-on=warn treats warnings as failures.');
        return { status: 'failed', report, message: 'verdict WARN' };
      }
      io.warning('DeployTruth verdict is WARN.');
    }
    return { status: 'success', report, bundle, environment: execution.environmentId };
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : 'Unknown action error');
    try {
      await io.writeSummary(executionFailureSummary(message));
    } catch {
      // A Job Summary that cannot be written must not mask the original failure.
    }
    io.fail(`DeployTruth execution failed before certification. ${message}`);
    return { status: 'failed', message };
  }
};
