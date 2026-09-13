/**
 * Release packaging gate for the `deploytruth` npm package.
 *
 * Packs packages/cli, then certifies the tarball an external user would receive:
 *   - the file allowlist is exactly dist/**, package.json, README.md, LICENSE
 *   - no credential-shaped or machine-specific content ships
 *   - the bin entry is executable and runs with no installed dependencies
 *   - packed/unpacked sizes are reported
 *
 * Run after `pnpm build`. Exits non-zero on any failed check.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPackage = fileURLToPath(new URL('../packages/cli', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'deploytruth-pack-check-'));

const fail = (message) => {
  console.error(`pack-check: FAIL — ${message}`);
  process.exit(1);
};

const listTarEntries = (tarball) =>
  execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const walkFiles = (directory) => {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  walk(directory);
  return files;
};

try {
  execFileSync('pnpm', ['--filter', './packages/cli', 'pack', '--pack-destination', work], {
    cwd: resolve(cliPackage, '..', '..'),
    stdio: 'pipe',
  });
} catch (error) {
  const detail =
    error instanceof Error && 'stderr' in error
      ? String(error.stderr)
      : error instanceof Error
        ? error.message
        : String(error);
  fail(`pnpm pack failed: ${detail}`);
}

const tarballs = readdirSync(work).filter((name) => name.endsWith('.tgz'));
if (tarballs.length !== 1 || tarballs[0] !== 'deploytruth-0.1.0.tgz') {
  fail(`unexpected tarball name(s): ${tarballs.join(', ')}`);
}
const tarball = join(work, tarballs[0]);

// --- File allowlist -----------------------------------------------------------
const ALLOWED = new Set(['LICENSE', 'README.md', 'package.json']);
const entries = listTarEntries(tarball);
const relative = entries
  .map((entry) => entry.replace(/^package\//, ''))
  .filter((entry) => entry !== '' && !entry.endsWith('/'));
for (const entry of relative) {
  if (!ALLOWED.has(entry) && !entry.startsWith('dist/')) {
    fail(`tarball ships a file outside the allowlist: ${entry}`);
  }
}
for (const required of ['dist/index.js', 'dist/web/index.html', 'LICENSE', 'README.md']) {
  if (!relative.includes(required)) fail(`tarball is missing required file: ${required}`);
}
for (const banned of ['.env', '.git', 'node_modules', 'test', 'src/', 'scripts/']) {
  if (relative.some((entry) => entry.includes(banned))) {
    fail(`tarball contains a development artifact matching "${banned}"`);
  }
}

// --- Content scan ---------------------------------------------------------------
execFileSync('tar', ['-xzf', tarball, '-C', work], { stdio: 'pipe' });
const packageDir = join(work, 'package');
const extracted = walkFiles(packageDir);

const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sbp_[A-Za-z0-9]{20,}/,
  /sb_secret_[A-Za-z0-9_]+/,
  /PRIVATE KEY/,
  /postgres(ql)?:\/\/[^/\s'"]+:[^/@\s'"]+@/,
  /DATABASE_URL=\S/,
  /SUPABASE_SERVICE_ROLE_KEY=\S/,
];
// Substrings a runtime string may legitimately describe; only full credential values trip these.
const MACHINE_PATTERNS = [/\/Users\/[A-Za-z0-9._-]+\//, /Documents\/Apps\//];

for (const file of extracted) {
  const contents = readFileSync(file, 'utf8');
  const rel = file.slice(packageDir.length + 1);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(contents)) fail(`credential-shaped content in ${rel}: ${pattern}`);
  }
  for (const pattern of MACHINE_PATTERNS) {
    if (pattern.test(contents)) fail(`machine-specific path in ${rel}: ${pattern}`);
  }
}

// --- Manifest sanity ------------------------------------------------------------
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
if (manifest.name !== 'deploytruth') fail(`package name is ${manifest.name}`);
if (manifest.version !== '0.1.0') fail(`package version is ${manifest.version}`);
if (manifest.bin?.deploytruth !== './dist/index.js') fail('bin entry is not ./dist/index.js');
if (manifest.private === true) fail('package is still marked private');
if (manifest.dependencies !== undefined && Object.keys(manifest.dependencies).length > 0) {
  fail('bundled CLI must not declare runtime dependencies');
}
for (const value of Object.values(manifest.dependencies ?? {})) {
  if (String(value).includes('workspace:')) fail('workspace: protocol leaked into manifest');
}

// --- Self-contained executable ---------------------------------------------------
const binPath = join(packageDir, 'dist', 'index.js');
if (!readFileSync(binPath, 'utf8').startsWith('#!/usr/bin/env node')) {
  fail('dist/index.js lost its shebang');
}
let version;
try {
  version = execFileSync(process.execPath, [binPath, '--version'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  }).trim();
} catch (error) {
  fail(`bin --version failed with no installed dependencies: ${error.message}`);
}
if (version !== '0.1.0') fail(`bin --version printed "${version}"`);

let help;
try {
  help = execFileSync(process.execPath, [binPath, '--help'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
} catch (error) {
  fail(`bin --help failed: ${error.message}`);
}
for (const command of ['init', 'doctor', 'check', 'open', 'history', 'diff']) {
  if (!help.includes(command)) fail(`--help is missing the ${command} command`);
}

// --- Sizes -----------------------------------------------------------------------
const packedBytes = statSync(tarball).size;
const unpackedBytes = extracted.reduce((total, file) => total + statSync(file).size, 0);

console.log('pack-check: PASS');
console.log(`  tarball: ${tarballs[0]} (${(packedBytes / 1024).toFixed(1)} KiB packed)`);
console.log(
  `  contents: ${relative.length} files, ${(unpackedBytes / 1024).toFixed(1)} KiB unpacked`,
);
console.log(`  bin: --version ${version}, --help lists all commands, zero runtime deps`);

rmSync(work, { recursive: true, force: true });
