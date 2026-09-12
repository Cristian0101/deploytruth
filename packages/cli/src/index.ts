#!/usr/bin/env node

import { access, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

import {
  ConfigError,
  loadDeployTruthManifest,
  supportedManifestProviders,
} from '@deploytruth/config';
import { redactText, type DeploymentObservation, type SourceObservation } from '@deploytruth/core';
import {
  createGitHubProvider,
  createVercelProvider,
  localGitProvider,
  resolveGitHubCredential,
  resolveVercelCredential,
  type GitHubSourceConfig,
  type LocalGitConfig,
  type ProviderDiagnostic,
  type TruthProvider,
  type VercelDeploymentConfig,
} from '@deploytruth/providers';
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

export interface CliDependencies {
  /** Injectable providers for tests; production uses the real adapters. */
  readonly gitProvider?: TruthProvider<LocalGitConfig, SourceObservation>;
  readonly githubProvider?: TruthProvider<GitHubSourceConfig, SourceObservation>;
  readonly vercelProvider?: TruthProvider<VercelDeploymentConfig, DeploymentObservation>;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const createCli = (dependencies: CliDependencies = {}): Command => {
  const program = new Command();
  const env = dependencies.env ?? process.env;

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
        const gitProvider = dependencies.gitProvider ?? localGitProvider;
        const githubProvider = dependencies.githubProvider ?? createGitHubProvider({ env });
        const vercelProvider = dependencies.vercelProvider ?? createVercelProvider({ env });

        const gitDiagnostics = await Promise.all(
          environmentIds
            .filter((id) => manifest.environments[id]?.source !== undefined)
            .map(async (id) => {
              const config = gitProvider.validateConfig({
                directory: dirname(configPath),
              });
              const results = await gitProvider.diagnose?.({
                project: manifest.project,
                environment: id,
                config,
              });
              return { environment: id, diagnostics: results ?? [] };
            }),
        );

        const credential = resolveGitHubCredential(env);
        const githubDiagnostics = await Promise.all(
          environmentIds
            .filter((id) => manifest.environments[id]?.source?.provider === 'github')
            .map(async (id) => {
              const declared = manifest.environments[id]?.source;
              const diagnostics: ProviderDiagnostic[] = [
                {
                  code: 'GITHUB_CREDENTIALS',
                  title: 'GitHub credentials',
                  status: credential === undefined ? 'warning' : 'ok',
                  message:
                    credential === undefined
                      ? 'none — unauthenticated access only (public repositories, low rate limits)'
                      : `available (${credential.variable})`,
                },
              ];
              if (declared?.repository === undefined || declared.branch === undefined) {
                diagnostics.push({
                  code: 'GITHUB_CONFIG',
                  title: 'GitHub configuration',
                  status: 'error',
                  message: 'source declarations require repository (owner/repo) and branch.',
                });
                return { environment: id, diagnostics };
              }
              try {
                const config = githubProvider.validateConfig({
                  repository: declared.repository,
                  branch: declared.branch,
                });
                const results = await githubProvider.diagnose?.({
                  project: manifest.project,
                  environment: id,
                  config,
                });
                diagnostics.push(...(results ?? []));
              } catch (error) {
                diagnostics.push({
                  code: 'GITHUB_CONFIG',
                  title: 'GitHub configuration',
                  status: 'error',
                  message: safeErrorMessage(error),
                });
              }
              return { environment: id, diagnostics };
            }),
        );

        const vercelCredential = resolveVercelCredential(env);
        const vercelDiagnostics = await Promise.all(
          environmentIds
            .filter((id) => manifest.environments[id]?.deployment?.provider === 'vercel')
            .map(async (id) => {
              const declared = manifest.environments[id]?.deployment;
              const diagnostics: ProviderDiagnostic[] = [
                {
                  code: 'VERCEL_CREDENTIALS',
                  title: 'Vercel credentials',
                  status: vercelCredential === undefined ? 'warning' : 'ok',
                  message:
                    vercelCredential === undefined
                      ? 'none — set DEPLOYTRUTH_VERCEL_TOKEN or VERCEL_TOKEN to observe deployment truth'
                      : `available (${vercelCredential.variable})`,
                },
              ];
              if (declared === undefined) {
                return { environment: id, diagnostics };
              }
              try {
                const config = vercelProvider.validateConfig({
                  project: declared.project,
                  ...(declared.target !== undefined ? { target: declared.target } : {}),
                  ...(declared.scope !== undefined ? { scope: declared.scope } : {}),
                  ...(declared.domain !== undefined ? { domain: declared.domain } : {}),
                });
                const results = await vercelProvider.diagnose?.({
                  project: manifest.project,
                  environment: id,
                  config,
                });
                diagnostics.push(...(results ?? []));
              } catch (error) {
                diagnostics.push({
                  code: 'VERCEL_CONFIG',
                  title: 'Vercel configuration',
                  status: 'error',
                  message: safeErrorMessage(error),
                });
              }
              return { environment: id, diagnostics };
            }),
        );

        const hasError = [...gitDiagnostics, ...githubDiagnostics, ...vercelDiagnostics].some(
          ({ diagnostics }) => diagnostics.some((entry) => entry.status === 'error'),
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
            github: githubDiagnostics.flatMap(({ environment, diagnostics }) =>
              diagnostics.map((entry) => ({ environment, ...entry })),
            ),
            vercel: vercelDiagnostics.flatMap(({ environment, diagnostics }) =>
              diagnostics.map((entry) => ({ environment, ...entry })),
            ),
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
          for (const { environment, diagnostics } of [
            ...gitDiagnostics,
            ...githubDiagnostics,
            ...vercelDiagnostics,
          ]) {
            for (const entry of diagnostics) {
              const marker =
                entry.status === 'ok' ? 'ok' : entry.status === 'warning' ? 'warn' : 'ERROR';
              console.log(`  [${marker}] ${environment}: ${entry.title} — ${entry.message}`);
            }
          }
          console.log(
            'Local Git, GitHub source, and Vercel deployment observation are active. Database and runtime providers are not implemented yet.',
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
    .description(
      'Evaluate declared truth for one environment against local Git and GitHub evidence',
    )
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
          ...(dependencies.gitProvider !== undefined
            ? { gitProvider: dependencies.gitProvider }
            : {}),
          ...(dependencies.githubProvider !== undefined
            ? { githubProvider: dependencies.githubProvider }
            : {}),
          ...(dependencies.vercelProvider !== undefined
            ? { vercelProvider: dependencies.vercelProvider }
            : {}),
          env,
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
