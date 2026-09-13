import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDeployTruthManifest } from '@deploytruth/config';
import { afterEach, describe, expect, it } from 'vitest';

import { createCli } from '../packages/cli/src/index.js';
import { SAMPLE_MANIFEST } from '../packages/cli/src/sample-manifest.js';
import { cleanupTempDirs, tempDir } from './git-test-utils.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = (relativePath: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, relativePath), 'utf8')) as Record<string, unknown>;
const readText = (relativePath: string): string => readFileSync(join(root, relativePath), 'utf8');

const cliPackage = readJson('packages/cli/package.json');

afterEach(cleanupTempDirs);

describe('release packaging metadata', () => {
  it('publishes the CLI as deploytruth with the v0.1.0 surface', () => {
    expect(cliPackage['name']).toBe('deploytruth');
    expect(cliPackage['version']).toBe('0.1.0');
    expect(cliPackage['private']).not.toBe(true);
    expect(cliPackage['license']).toBe('Apache-2.0');
    expect(cliPackage['bin']).toEqual({ deploytruth: './dist/index.js' });
    expect(cliPackage['files']).toEqual(['dist']);
    expect(cliPackage['engines']).toMatchObject({ node: '>=22.0.0' });
    expect(cliPackage['repository']).toMatchObject({
      type: 'git',
      url: 'git+https://github.com/Cristian0101/deploytruth.git',
      directory: 'packages/cli',
    });
  });

  it('ships no runtime dependencies — the bundle is self-contained', () => {
    const dependencies = cliPackage['dependencies'] ?? {};
    expect(Object.keys(dependencies as object)).toEqual([]);
  });

  it('keeps every workspace package on the same product version', () => {
    for (const manifestPath of [
      'package.json',
      'packages/cli/package.json',
      'packages/config/package.json',
      'packages/core/package.json',
      'packages/github-action/package.json',
      'packages/providers/package.json',
      'packages/reporter/package.json',
      'apps/web/package.json',
    ]) {
      expect(readJson(manifestPath)['version'], manifestPath).toBe('0.1.0');
    }
  });

  it('returns the package version from --version through a single source', () => {
    expect(createCli().version()).toBe(cliPackage['version']);
  });

  it('ships the Apache-2.0 license text inside the package', () => {
    expect(readText('packages/cli/LICENSE')).toBe(readText('LICENSE'));
  });
});

describe('generated configuration', () => {
  it('deploytruth init output parses as a valid v1 manifest', async () => {
    const directory = tempDir('dt-init-manifest-');
    const manifestPath = join(directory, 'deploytruth.yml');
    writeFileSync(manifestPath, SAMPLE_MANIFEST);
    const manifest = await loadDeployTruthManifest(manifestPath);
    expect(manifest.project).toBe('my-app');
    expect(Object.keys(manifest.environments)).toContain('production');
  });

  it('the example manifest parses as a valid v1 manifest', async () => {
    const manifest = await loadDeployTruthManifest(join(root, 'deploytruth.example.yml'));
    expect(manifest.project).toBe('example-app');
    expect(Object.keys(manifest.environments).sort()).toEqual(['preview', 'production']);
  });
});

describe('GitHub Action release surface', () => {
  it('points action.yml at a committed Node 24 bundle', () => {
    const actionYml = readText('action.yml');
    expect(actionYml).toContain('using: node24');
    expect(actionYml).toContain('main: packages/github-action/dist/index.js');
    expect(readFileSync(join(root, 'packages/github-action/dist/index.js'), 'utf8')).toContain(
      'runEnvironmentCheck',
    );
  });

  it('keeps RC distribution certification remote and incapable of publishing', () => {
    const workflow = readText('.github/workflows/release-candidate.yml');
    expect(workflow).toContain('ubuntu-latest');
    expect(workflow).toContain('macos-latest');
    expect(workflow).toContain('actions/upload-artifact@v7');
    expect(workflow).toContain('actions/download-artifact@v7');
    expect(workflow).toContain('scripts/external-consumer-smoke.mjs');
    expect(workflow).toContain('retention-days: 7');
    expect(workflow).not.toMatch(/id-token:\s*write/);
    expect(workflow).not.toMatch(/npm\s+(?:stage\s+)?publish/);
    expect(workflow).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN/);
  });
});
