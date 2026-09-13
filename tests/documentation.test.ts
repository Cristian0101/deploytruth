import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { parseDeployTruthManifest, supportedManifestProviders } from '@deploytruth/config';
import { defaultRules } from '@deploytruth/core';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const requireFromConfig = createRequire(join(root, 'packages/config/package.json'));
const { parseDocument } = requireFromConfig('yaml') as {
  parseDocument: (source: string) => { readonly errors: readonly unknown[] };
};

const markdownFilesUnder = (directory: string): string[] =>
  readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFilesUnder(relative);
    return entry.name.endsWith('.md') ? [relative] : [];
  });

const fencedBetween = (source: string, start: string, end: string): string => {
  const body = source.split(start)[1]?.split(end)[0];
  if (body === undefined) throw new Error(`Missing documentation marker ${start}`);
  const match = body.match(/```(?:yaml|yml)\n([\s\S]*?)```/);
  if (match?.[1] === undefined) throw new Error(`Missing YAML fence after ${start}`);
  return match[1];
};

const assertExactCasePath = (relativePath: string): void => {
  let current = root;
  for (const segment of relativePath.split('/')) {
    expect(readdirSync(current)).toContain(segment);
    current = join(current, segment);
  }
  expect(existsSync(current)).toBe(true);
};

describe('public documentation', () => {
  it('keeps the quick-start manifest parseable by the current schema', () => {
    const yaml = fencedBetween(
      read('README.md'),
      '<!-- docs-test:quick-config:start -->',
      '<!-- docs-test:quick-config:end -->',
    );
    expect(() => parseDeployTruthManifest(yaml)).not.toThrow();
  });

  it('keeps the GitHub Action example valid YAML and release-honest', () => {
    const yaml = fencedBetween(
      read('README.md'),
      '<!-- docs-test:action-example:start -->',
      '<!-- docs-test:action-example:end -->',
    );
    expect(parseDocument(yaml).errors).toEqual([]);
    expect(read('README.md')).toContain('Use the moving `v0` ref for compatible pre-1.0 releases');
  });

  it('documents every current CLI command and check key', () => {
    const cli = read('docs/cli.md');
    for (const command of ['init', 'doctor', 'check', 'open', 'history', 'diff']) {
      expect(cli).toContain(`## \`${command}\``);
    }
    const configuration = read('docs/configuration.md');
    for (const check of [
      'local_git',
      'remote_source',
      'deployment_sha',
      'migrations',
      'runtime_identity',
      'environment_isolation',
      'environment_variables',
    ]) {
      expect(configuration).toContain(`\`${check}\``);
    }
  });

  it('keeps provider support aligned with the manifest implementation', () => {
    expect(supportedManifestProviders).toEqual(['github', 'vercel', 'supabase']);
    const readme = read('README.md');
    for (const provider of ['Local Git', 'GitHub', 'Vercel', 'Runtime attestation', 'Supabase']) {
      expect(readme).toMatch(new RegExp(`^\\|\\s*${provider}\\s*\\|`, 'm'));
    }
  });

  it('keeps the finding reference exactly aligned with the rule registry', () => {
    const docsCodes = [...read('docs/findings.md').matchAll(/^\|\s*`([A-Z0-9_]+)`\s*\|/gm)]
      .map((match) => match[1]!)
      .sort();
    const registryCodes = defaultRules.map((rule) => rule.code).sort();
    expect(new Set(docsCodes).size).toBe(docsCodes.length);
    expect(docsCodes).toEqual(registryCodes);
  });

  it('resolves repository-relative Markdown links and asset paths with exact case', () => {
    const markdownFiles = ['README.md', 'CONTRIBUTING.md', ...markdownFilesUnder('docs')];
    for (const file of markdownFiles) {
      const source = read(file);
      for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1]!;
        if (/^(?:https?:|#|mailto:)/.test(target)) continue;
        const clean = target.split('#')[0]!;
        const absolute = resolve(root, dirname(file), clean);
        expect(existsSync(absolute), `${file} -> ${target}`).toBe(true);
        if (lstatSync(absolute).isFile()) {
          assertExactCasePath(absolute.slice(root.length + 1));
        }
      }
    }
  });

  it('contains no hardcoded home paths or common secret-value shapes in public text', () => {
    const files = ['README.md', 'CONTRIBUTING.md', ...markdownFilesUnder('docs')];
    const publicText = files.map(read).join('\n');
    expect(publicText).not.toMatch(/\/Users\/[A-Za-z0-9._-]+|[A-Z]:\\Users\\/);
    expect(publicText).not.toMatch(
      /gh[pousr]_[A-Za-z0-9]{20,}|postgres(?:ql)?:\/\/[^\s`]+:[^\s`]+@/i,
    );
  });
});
