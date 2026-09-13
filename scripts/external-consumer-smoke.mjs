/**
 * External-consumer smoke test for the `deploytruth` npm package.
 *
 * Simulates a user with no repository access: packs packages/cli, installs the tarball into an
 * empty temporary project outside the monorepo, and drives the installed .bin entry through the
 * commands a new user would run. Any workspace or machine-local resolution breaks this test.
 *
 *   node scripts/external-consumer-smoke.mjs [path/to/deploytruth.tgz]
 *
 * Run after `pnpm build`. Requires npm and git on PATH. Exits non-zero on any failed check.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const consumer = mkdtempSync(join(tmpdir(), 'deploytruth-external-consumer-'));
const binPath = join(consumer, 'node_modules', '.bin', 'deploytruth');
const reportsDir = join(consumer, '.deploytruth', 'reports', 'consumer-app', 'staging');
const failures = [];

const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const run = (command, args, options = {}) =>
  spawnSync(command, args, { cwd: consumer, encoding: 'utf8', ...options });

const bin = (...args) => run(binPath, args);
const git = (...args) => run('git', args);

const packTarball = () => {
  const destination = mkdtempSync(join(tmpdir(), 'deploytruth-pack-'));
  execFileSync('pnpm', ['--filter', './packages/cli', 'pack', '--pack-destination', destination], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
  return join(destination, 'deploytruth-0.1.0.tgz');
};

// --- Install ---------------------------------------------------------------------
const tarball = process.argv[2] ?? packTarball();
console.log(`consumer: ${consumer}`);
console.log(`tarball:  ${tarball}`);

run('npm', ['init', '-y']);
const install = run('npm', ['install', tarball]);
check('npm install tarball succeeds', install.status === 0, install.stderr?.trim());
check(
  'installs exactly one package (zero runtime deps)',
  (install.stdout ?? '').includes('added 1 package'),
  install.stdout?.trim().split('\n').at(-1),
);
check('bin linked in node_modules/.bin', existsSync(binPath));
const installedManifest = JSON.parse(
  readFileSync(join(consumer, 'node_modules', 'deploytruth', 'package.json'), 'utf8'),
);
check(
  'installed manifest carries no workspace: specifiers',
  !JSON.stringify(installedManifest).includes('workspace:'),
);
check(
  'installed package ships the report web assets',
  existsSync(join(consumer, 'node_modules', 'deploytruth', 'dist', 'web', 'index.html')),
);

// --- Basic commands ----------------------------------------------------------------
const version = bin('--version');
check('deploytruth --version prints 0.1.0', version.stdout?.trim() === '0.1.0', version.stderr);
const help = bin('--help');
check(
  'deploytruth --help lists every command',
  ['init', 'doctor', 'check', 'open', 'history', 'diff'].every((cmd) => help.stdout?.includes(cmd)),
);

// --- init --------------------------------------------------------------------------
const init = bin('init');
check(
  'deploytruth init creates deploytruth.yml',
  init.status === 0 && existsSync(join(consumer, 'deploytruth.yml')),
);
check(
  'generated manifest is v1 shape',
  readFileSync(join(consumer, 'deploytruth.yml'), 'utf8').includes('version: 1'),
);
const reinit = bin('init');
check(
  'init refuses to overwrite an existing manifest',
  reinit.status === 1 && (reinit.stderr ?? '').includes('already exists'),
  `status=${reinit.status} stderr=${reinit.stderr}`,
);

// --- Error paths ---------------------------------------------------------------------
const missing = bin('check', '-c', 'absent.yml');
check(
  'missing manifest exits 2 with a concise error',
  missing.status === 2 && (missing.stderr ?? '').includes('Unable to read manifest'),
  missing.stderr,
);
writeFileSync(join(consumer, 'broken.yml'), 'environments: [unclosed\n');
const malformed = bin('check', '-c', 'broken.yml');
check(
  'malformed YAML exits 2 without a stack trace',
  malformed.status === 2 &&
    (malformed.stderr ?? '').includes('invalid YAML') &&
    !(malformed.stderr ?? '').includes('    at '),
);
rmSync(join(consumer, 'broken.yml'));

// --- Deterministic check ---------------------------------------------------------------
const remoteDir = join(consumer, '.remote.git');
git('init', '-q', '--bare', remoteDir);
git('init', '-q', '.');
git('config', 'user.email', 'smoke@example.invalid');
git('config', 'user.name', 'DeployTruth Smoke');
writeFileSync(join(consumer, '.gitignore'), 'node_modules/\n.remote.git/\npackage*.json\n');
writeFileSync(
  join(consumer, 'deploytruth.yml'),
  [
    'version: 1',
    'project: consumer-app',
    'environments:',
    '  staging:',
    '    kind: staging',
    '    source:',
    '      provider: github',
    '      repository: octocat/hello-world',
    '      branch: main',
    '    checks:',
    '      local_git: true',
    '      remote_source: false',
    '',
  ].join('\n'),
);
git('add', 'deploytruth.yml', '.gitignore');
git('commit', '-qm', 'smoke');
git('remote', 'add', 'origin', remoteDir);
git('push', '-q', 'origin', 'HEAD:main');
git('branch', '--set-upstream-to=origin/main');

const checkRun = bin('check', '-e', 'staging');
check(
  'deploytruth check runs against local Git only',
  checkRun.status === 0 && checkRun.stdout?.includes('VERDICT'),
  `status=${checkRun.status} stderr=${checkRun.stderr}`,
);
check(
  'deterministic local_git verdict is PASS',
  checkRun.stdout?.includes('PASS') === true,
  checkRun.stdout?.split('\n').at(-3),
);
check(
  'check stores a local report',
  existsSync(reportsDir) && readdirSync(reportsDir).includes('latest.json'),
);

const second = bin('check', '-e', 'staging');
check('second check run stores history', second.status === 0);
const history = bin('history', '-e', 'staging');
check(
  'deploytruth history lists stored runs',
  history.status === 0 &&
    (history.stdout ?? '').split('\n').filter((l) => /[0-9A-HJKMNP-TV-Z]{26}/.test(l)).length >= 2,
  history.stdout,
);
const diff = bin('diff', '-e', 'staging');
check(
  'deploytruth diff compares the two stored runs',
  diff.status === 0 && diff.stdout?.includes('DeployTruth Diff'),
  diff.stderr,
);
const unknownEnv = bin('check', '-e', 'missing');
check(
  'unknown environment errors with declared names',
  unknownEnv.status === 2 && (unknownEnv.stderr ?? '').includes('staging'),
);

// --- open (static report mode, loopback only) -------------------------------------------
const openResult = await new Promise((resolvePromise) => {
  const child = spawn(binPath, ['open', '--report', join(reportsDir, 'latest.json'), '--no-open'], {
    cwd: consumer,
  });
  let stdout = '';
  const finish = (value) => {
    child.kill('SIGINT');
    resolvePromise(value);
  };
  child.stdout.on('data', async (chunk) => {
    stdout += chunk;
    const url = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (url === undefined) return;
    try {
      const [index, api] = await Promise.all([
        fetch(url).then((r) => r.status),
        fetch(`${url}/api/report`).then((r) => r.status),
      ]);
      finish({ index, api });
    } catch {
      finish({ index: 0, api: 0 });
    }
  });
  child.on('exit', () => resolvePromise({ index: -1, api: -1, stdout }));
  setTimeout(() => finish({ index: -2, api: -2 }), 15_000);
});
check(
  'deploytruth open serves the report UI and API on loopback',
  openResult.index === 200 && openResult.api === 200,
  JSON.stringify(openResult),
);

// --- Summary -----------------------------------------------------------------------------
console.log('');
if (failures.length > 0) {
  console.error(`external-consumer-smoke: FAIL (${failures.length} failed)`);
  process.exit(1);
}
console.log('external-consumer-smoke: PASS');
rmSync(consumer, { recursive: true, force: true });
process.exit(0);
