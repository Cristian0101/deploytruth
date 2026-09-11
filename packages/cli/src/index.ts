#!/usr/bin/env node

import { access, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import {
  ConfigError,
  loadDeployTruthManifest,
  supportedManifestProviders,
} from '@deploytruth/config';
import { redactText } from '@deploytruth/core';
import { Command } from 'commander';

import { SAMPLE_MANIFEST } from './sample-manifest.js';

const FOUNDATION_MESSAGE =
  'Live observations are intentionally unavailable in the foundation. Implement M1–M4 adapters before treating check output as deployment truth.';

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
    .description('Validate the manifest and show the currently available foundation capabilities')
    .option('-c, --config <path>', 'manifest path', 'deploytruth.yml')
    .option('--json', 'write a machine-readable preflight result')
    .action(async (options: { readonly config: string; readonly json?: boolean }) => {
      try {
        const manifest = await loadDeployTruthManifest(resolve(options.config));
        const result = {
          status: 'VALID',
          project: manifest.project,
          environments: Object.keys(manifest.environments).sort(),
          supportedProviders: [...supportedManifestProviders],
          liveObservationStatus: 'NOT_IMPLEMENTED',
        };
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Manifest valid for ${result.project}.`);
          console.log(`Environments: ${result.environments.join(', ')}`);
          console.log(`Declared provider families: ${result.supportedProviders.join(', ')}`);
          console.log(FOUNDATION_MESSAGE);
        }
      } catch (error) {
        printConfigError(error);
        process.exitCode = 1;
      }
    });

  for (const commandName of ['check', 'map', 'diff', 'open']) {
    program
      .command(commandName)
      .description(
        `${commandName} command shell; live observation support starts after the foundation milestone`,
      )
      .option('-c, --config <path>', 'manifest path', 'deploytruth.yml')
      .option('-e, --environment <name>', 'declared environment')
      .option('--strict', 'treat warnings as failures when truth evaluation is implemented')
      .option('--json', 'use JSON output when truth evaluation is implemented')
      .option('--output <path>', 'write a report when truth evaluation is implemented')
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
