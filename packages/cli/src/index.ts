#!/usr/bin/env node

import { access, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

import {
  ConfigError,
  loadDeployTruthManifest,
  supportedManifestProviders,
} from '@deploytruth/config';
import { redactText } from '@deploytruth/core';
import { localGitProvider } from '@deploytruth/providers';
import { serializeTruthReport, writeReportFile } from '@deploytruth/reporter';
import { Command } from 'commander';

import { formatCheckReport, runEnvironmentCheck } from './check.js';
import { SAMPLE_MANIFEST } from './sample-manifest.js';

const FOUNDATION_MESSAGE =
  'This command is not implemented yet. `deploytruth check` currently evaluates local Git truth; deployment, database, and runtime providers land in later milestones.';

const safeErrorMessage = (error: unknown): string =>
  redactText(error instanceof Error ? error.message : 'Unknown error');

const printConfigError = (error: unknown): void => {
  if (error instanceof ConfigError) {
    console.error(redactText(error.message));
    for (const detail of error.details) {
      console.error(`  - ${redactText(detail)}`);
    }
    return;
  }
  console.error(safeErrorMessage(error));
};

const assertMissing = async (filePath: string): Promise<void> => {
  try {
    await access(filePath);
  } catch {
    return;
  }
  throw new Error(`${filePath} already exists; DeployTruth will not overwrite configuration.`);
};

interface CheckCommandOptions {
  readonly config: string;
  readonly environment?: string;
  readonly strict?: boolean;
  readonly json?: boolean;
  readonly output?: string;
}

export const createCli = (): Command => {
  const program = new Command();

  program
    .name('deploytruth')
    .description('Deterministic deployment topology verification')
    .version('0.1.0');

  program
    .command('init')
    .description('Create a safe starter deploytruth.yml without overwriting an existing file')
    .option('-c, --config <path>', 'target manifest path', 'deploytruth.yml')
    .action(async (options: { readonly config: string }) => {
      const filePath = resolve(options.config);
      try {
        await assertMissing(filePath);
        await writeFile(filePath, SAMPLE_MANIFEST, { encoding: 'utf8', flag: 'wx' });
        console.log(`Created ${filePath}`);
      } catch (error) {
        console.error(safeErrorMessage(error));
        process.exitCode = 1;
      }
    });

  program
    .command('doctor')
    .description('Diagnose manifest validity, Git availability, and repository state')
    .option('-c, --config <path>', 'manifest path', 'deploytruth.yml')
    .option('--json', 'write a machine-readable preflight result')
    .action(async (options: { readonly config: string; readonly json?: boolean }) => {
      try {
        const configPath = resolve(options.config);
        const manifest = await loadDeployTruthManifest(configPath);
        const environmentIds = Object.keys(manifest.environments).sort();

        const gitDiagnostics = await Promise.all(
          environmentIds
            .filter((id) => manifest.environments[id]?.source !== undefined)
            .map(async (id) => {
              const config = localGitProvider.validateConfig({
                directory: dirname(configPath),
              });
              const results = await localGitProvider.diagnose?.({
                project: manifest.project,
                environment: id,
                config,
              });
              return { environment: id, diagnostics: results ?? [] };
            }),
        );

        const hasError = gitDiagnostics.some(({ diagnostics }) =>
          diagnostics.some((entry) => entry.status === 'error'),
        );
        const result = {
          status: hasError ? 'DEGRADED' : 'VALID',
          project: manifest.project,
          environments: environmentIds,
          supportedProviders: [...supportedManifestProviders],
          observations: {
            localGit: gitDiagnostics.flatMap(({ environment, diagnostics }) =>
              diagnostics.map((entry) => ({ environment, ...entry })),
            ),
            deployment: 'NOT_IMPLEMENTED',
            database: 'NOT_IMPLEMENTED',
            runtime: 'NOT_IMPLEMENTED',
          },
        };

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(
            `Manifest ${result.status === 'VALID' ? 'valid' : 'valid with warnings'} for ${result.project}.`,
          );
          console.log(`Environments: ${result.environments.join(', ')}`);
          console.log(`Declared provider families: ${result.supportedProviders.join(', ')}`);
          for (const { environment, diagnostics } of gitDiagnostics) {
            for (const entry of diagnostics) {
              const marker =
                entry.status === 'ok' ? 'ok' : entry.status === 'warning' ? 'warn' : 'ERROR';
              console.log(`  [${marker}] ${environment}: ${entry.title} — ${entry.message}`);
            }
          }
          console.log(
            'Local Git observation is active. Deployment, database, and runtime providers are not implemented yet.',
          );
        }
        if (hasError) {
          process.exitCode = 1;
        }
      } catch (error) {
        printConfigError(error);
        process.exitCode = 1;
      }
    });

  program
    .command('check')
    .description('Evaluate declared truth for one environment against local Git evidence')
    .option('-c, --config <path>', 'manifest path', 'deploytruth.yml')
    .option('-e, --environment <name>', 'declared environment')
    .option('--strict', 'treat warnings as failures')
    .option('--json', 'print the serialized truth report')
    .option('--output <path>', 'write the serialized report to a file')
    .action(async (options: CheckCommandOptions) => {
      try {
        const execution = await runEnvironmentCheck({
          configPath: resolve(options.config),
          ...(options.environment !== undefined ? { environmentName: options.environment } : {}),
          ...(options.strict !== undefined ? { strict: options.strict } : {}),
        });

        if (options.output !== undefined) {
          await writeReportFile(resolve(options.output), execution.report);
        }
        if (options.json) {
          console.log(serializeTruthReport(execution.report));
        } else {
          console.log(formatCheckReport(execution));
        }
        process.exitCode = execution.report.verdict === 'FAIL' ? 1 : 0;
      } catch (error) {
        printConfigError(error);
        process.exitCode = 2;
      }
    });

  for (const commandName of ['map', 'diff', 'open']) {
    program
      .command(commandName)
      .description(`${commandName} command shell; arrives in a later milestone`)
      .option('-c, --config <path>', 'manifest path', 'deploytruth.yml')
      .option('-e, --environment <name>', 'declared environment')
      .action(() => {
        console.error(FOUNDATION_MESSAGE);
        process.exitCode = 2;
      });
  }

  return program;
};

const invokedAsCli = process.argv[1]?.endsWith('index.js') ?? false;
if (invokedAsCli) {
  await createCli().parseAsync(process.argv);
}
