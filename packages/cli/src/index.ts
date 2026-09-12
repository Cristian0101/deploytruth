#!/usr/bin/env node

import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

import {
  ConfigError,
  loadDeployTruthManifest,
  supportedManifestProviders,
} from '@deploytruth/config';
import {
  redactText,
  type DatabaseObservation,
  type DeploymentObservation,
  type MigrationCatalogObservation,
  type RuntimeObservation,
  type SourceObservation,
} from '@deploytruth/core';
import {
  createGitHubProvider,
  createGitMigrationCatalogProvider,
  createSupabaseProvider,
  createRuntimeProvider,
  createVercelProvider,
  localGitProvider,
  resolveGitHubCredential,
  resolveVercelCredential,
  type GitHubSourceConfig,
  type GitMigrationCatalogConfig,
  type LocalGitConfig,
  type ProviderDiagnostic,
  type RuntimeAttestationConfig,
  type SupabaseDatabaseConfig,
  type TruthProvider,
  type VercelDeploymentConfig,
} from '@deploytruth/providers';
import {
  parseTruthReport,
  serializeTruthReport,
  writeLocalReport,
  writeReportFile,
} from '@deploytruth/reporter';
import { Command } from 'commander';
import openBrowser from 'open';

import { formatCheckReport, runEnvironmentCheck } from './check.js';
import { startLocalReportServer } from './open.js';
import { SAMPLE_MANIFEST } from './sample-manifest.js';

const FOUNDATION_MESSAGE = 'This command arrives in a later milestone.';

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

interface OpenCommandOptions {
  readonly config: string;
  readonly environment?: string;
  readonly report?: string;
  readonly port?: string;
  readonly open: boolean;
}

const parsePort = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError('--port must be an integer between 1 and 65535.', []);
  }
  return port;
};

export interface CliDependencies {
  /** Injectable providers for tests; production uses the real adapters. */
  readonly gitProvider?: TruthProvider<LocalGitConfig, SourceObservation>;
  readonly githubProvider?: TruthProvider<GitHubSourceConfig, SourceObservation>;
  readonly vercelProvider?: TruthProvider<VercelDeploymentConfig, DeploymentObservation>;
  readonly supabaseProvider?: TruthProvider<SupabaseDatabaseConfig, DatabaseObservation>;
  readonly migrationCatalogProvider?: TruthProvider<
    GitMigrationCatalogConfig,
    MigrationCatalogObservation
  >;
  readonly runtimeProvider?: TruthProvider<RuntimeAttestationConfig, RuntimeObservation>;
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

        const supabaseDiagnostics = await Promise.all(
          environmentIds
            .filter((id) => manifest.environments[id]?.database?.provider === 'supabase')
            .map(async (id) => {
              const declared = manifest.environments[id]?.database;
              const diagnostics: ProviderDiagnostic[] = [];
              if (declared === undefined) {
                return { environment: id, diagnostics };
              }
              const supabaseProvider =
                dependencies.supabaseProvider ?? createSupabaseProvider({ env });
              const catalogProvider =
                dependencies.migrationCatalogProvider ?? createGitMigrationCatalogProvider();
              try {
                const config = supabaseProvider.validateConfig({
                  projectRef: declared.projectRef,
                });
                const results = await supabaseProvider.diagnose?.({
                  project: manifest.project,
                  environment: id,
                  config,
                });
                diagnostics.push(...(results ?? []));
              } catch (error) {
                diagnostics.push({
                  code: 'SUPABASE_CONFIG',
                  title: 'Supabase configuration',
                  status: 'error',
                  message: safeErrorMessage(error),
                });
              }
              try {
                const catalogConfig = catalogProvider.validateConfig({
                  directory: dirname(configPath),
                  migrationDirectory: declared.migrationDirectory,
                });
                const results = await catalogProvider.diagnose?.({
                  project: manifest.project,
                  environment: id,
                  config: catalogConfig,
                });
                diagnostics.push(...(results ?? []));
              } catch (error) {
                diagnostics.push({
                  code: 'MIGRATION_CATALOG_CONFIG',
                  title: 'Migration catalog',
                  status: 'error',
                  message: safeErrorMessage(error),
                });
              }
              return { environment: id, diagnostics };
            }),
        );

        const runtimeDiagnostics = await Promise.all(
          environmentIds
            .filter((id) => manifest.environments[id]?.runtime !== undefined)
            .map(async (id) => {
              const declared = manifest.environments[id];
              const diagnostics: ProviderDiagnostic[] = [];
              if (declared?.runtime === undefined) {
                return { environment: id, diagnostics };
              }
              const runtimeProvider = dependencies.runtimeProvider ?? createRuntimeProvider();
              try {
                const config = runtimeProvider.validateConfig({
                  url: declared.runtime.url,
                  requiredEnvironmentVariables: declared.requiredEnvironmentVariables,
                });
                const results = await runtimeProvider.diagnose?.({
                  project: manifest.project,
                  environment: id,
                  config,
                });
                diagnostics.push(...(results ?? []));
              } catch (error) {
                diagnostics.push({
                  code: 'RUNTIME_CONFIG',
                  title: 'Runtime attestation',
                  status: 'error',
                  message: safeErrorMessage(error),
                });
              }
              return { environment: id, diagnostics };
            }),
        );

        const hasError = [
          ...gitDiagnostics,
          ...githubDiagnostics,
          ...vercelDiagnostics,
          ...supabaseDiagnostics,
          ...runtimeDiagnostics,
        ].some(({ diagnostics }) => diagnostics.some((entry) => entry.status === 'error'));
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
            supabase: supabaseDiagnostics.flatMap(({ environment, diagnostics }) =>
              diagnostics.map((entry) => ({ environment, ...entry })),
            ),
            runtime: runtimeDiagnostics.flatMap(({ environment, diagnostics }) =>
              diagnostics.map((entry) => ({ environment, ...entry })),
            ),
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
            ...supabaseDiagnostics,
            ...runtimeDiagnostics,
          ]) {
            for (const entry of diagnostics) {
              const marker =
                entry.status === 'ok' ? 'ok' : entry.status === 'warning' ? 'warn' : 'ERROR';
              console.log(`  [${marker}] ${environment}: ${entry.title} — ${entry.message}`);
            }
          }
          console.log(
            'Local Git, GitHub source, Vercel deployment, Supabase database, and runtime attestation observation are active.',
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
          ...(dependencies.supabaseProvider !== undefined
            ? { supabaseProvider: dependencies.supabaseProvider }
            : {}),
          ...(dependencies.migrationCatalogProvider !== undefined
            ? { migrationCatalogProvider: dependencies.migrationCatalogProvider }
            : {}),
          ...(dependencies.runtimeProvider !== undefined
            ? { runtimeProvider: dependencies.runtimeProvider }
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

  program
    .command('open')
    .description('Run a truth check and open its private local visual report')
    .option('-c, --config <path>', 'manifest path', 'deploytruth.yml')
    .option('-e, --environment <name>', 'declared environment')
    .option(
      '--report <path>',
      'open an existing normalized TruthReport without rerunning providers',
    )
    .option('--port <number>', 'explicit loopback port')
    .option('--no-open', 'print the URL without opening a browser')
    .action(async (options: OpenCommandOptions) => {
      let server: Awaited<ReturnType<typeof startLocalReportServer>> | undefined;
      try {
        if (options.report !== undefined && options.environment !== undefined) {
          throw new ConfigError('--report cannot be combined with --environment.', []);
        }

        const port = parsePort(options.port);
        const staticMode = options.report !== undefined;
        const configPath = resolve(options.config);
        const reportPath = options.report === undefined ? undefined : resolve(options.report);

        const runCheck = async () =>
          (
            await runEnvironmentCheck({
              configPath,
              ...(options.environment !== undefined
                ? { environmentName: options.environment }
                : {}),
              ...(dependencies.gitProvider !== undefined
                ? { gitProvider: dependencies.gitProvider }
                : {}),
              ...(dependencies.githubProvider !== undefined
                ? { githubProvider: dependencies.githubProvider }
                : {}),
              ...(dependencies.vercelProvider !== undefined
                ? { vercelProvider: dependencies.vercelProvider }
                : {}),
              ...(dependencies.supabaseProvider !== undefined
                ? { supabaseProvider: dependencies.supabaseProvider }
                : {}),
              ...(dependencies.migrationCatalogProvider !== undefined
                ? { migrationCatalogProvider: dependencies.migrationCatalogProvider }
                : {}),
              ...(dependencies.runtimeProvider !== undefined
                ? { runtimeProvider: dependencies.runtimeProvider }
                : {}),
              env,
            })
          ).report;

        const report = reportPath
          ? parseTruthReport(await readFile(reportPath, 'utf8'))
          : await runCheck();

        if (!staticMode) {
          await writeLocalReport(dirname(configPath), report);
        }

        server = await startLocalReportServer({
          report,
          ...(port !== undefined ? { port } : {}),
          staticMode,
          ...(staticMode ? {} : { rerun: runCheck }),
          ...(staticMode
            ? {}
            : {
                onReport: async (nextReport) => {
                  await writeLocalReport(dirname(configPath), nextReport);
                },
              }),
        });

        console.log('DeployTruth visual report');
        console.log(server.url);
        if (options.open) {
          console.log('Opening browser...');
          await openBrowser(server.url);
        }

        await new Promise<void>((resolveStop) => {
          const stop = (): void => {
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
            resolveStop();
          };
          process.on('SIGINT', stop);
          process.on('SIGTERM', stop);
        });
      } catch (error) {
        printConfigError(error);
        process.exitCode = 2;
      } finally {
        await server?.close();
      }
    });

  for (const commandName of ['map', 'diff']) {
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
