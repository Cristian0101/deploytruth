import { isAbsolute, resolve, sep } from 'node:path';

/** Action input names declared in action.yml; the runtime parser must match them exactly. */
export const ACTION_INPUT_NAMES = ['environment', 'config', 'fail-on'] as const;

export const FAIL_ON_VALUES = ['fail', 'warn', 'never'] as const;
export type FailOn = (typeof FAIL_ON_VALUES)[number];

export interface ActionInputs {
  readonly environment: string;
  readonly config: string;
  readonly failOn: FailOn;
}

export class ActionInputError extends Error {
  readonly code = 'invalid_input' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ActionInputError';
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const INPUT_LIMIT = 512;
// eslint-disable-next-line no-control-regex -- deliberately detects control characters
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/** Inputs are never sanitized into different values — unsafe content is rejected outright. */
const read = (value: string | undefined, name: string): string => {
  const raw = value ?? '';
  if (CONTROL_CHARS.test(raw)) {
    throw new ActionInputError(`The "${name}" input contains control characters.`);
  }
  const trimmed = raw.trim();
  if (trimmed.length > INPUT_LIMIT) {
    throw new ActionInputError(`The "${name}" input is too long.`);
  }
  return trimmed;
};

/**
 * Validates raw Action input strings. `config` must be a repository-relative path: no absolute
 * paths, no `.`/`..`/empty segments, no backslashes, no NUL or control characters. Resolution
 * under the workspace happens separately in `resolveConfigPath`.
 */
export const parseActionInputs = (raw: {
  readonly environment?: string | undefined;
  readonly config?: string | undefined;
  readonly failOn?: string | undefined;
}): ActionInputs => {
  const environment = read(raw.environment, 'environment');
  if (environment.length === 0) {
    throw new ActionInputError('The "environment" input is required.');
  }

  const config = read(raw.config, 'config') || 'deploytruth.yml';
  if (
    isAbsolute(config) ||
    /^[A-Za-z]:[\\/]/.test(config) ||
    config.startsWith('~') ||
    config.includes('\\')
  ) {
    throw new ActionInputError('The "config" input must be a repository-relative path.');
  }
  const segments = config.split('/');
  if (
    segments.some(
      (segment) =>
        segment === '' || segment === '.' || segment === '..' || !SAFE_SEGMENT.test(segment),
    )
  ) {
    throw new ActionInputError(
      'The "config" input must be a repository-relative path of safe segments.',
    );
  }

  const failOn = read(raw.failOn, 'fail-on') || 'fail';
  if (!(FAIL_ON_VALUES as readonly string[]).includes(failOn)) {
    throw new ActionInputError(`The "fail-on" input must be one of: ${FAIL_ON_VALUES.join(', ')}.`);
  }

  return { environment, config, failOn: failOn as FailOn };
};

/**
 * Resolves the validated repository-relative config path under the trusted workspace root.
 * The result is provably inside the workspace or the call throws — an Action input can never
 * become arbitrary filesystem access.
 */
export const resolveConfigPath = (workspace: string, config: string): string => {
  const root = resolve(workspace);
  const resolved = resolve(root, config);
  if (resolved === root || !resolved.startsWith(`${root}${sep}`)) {
    throw new ActionInputError('The "config" input resolves outside the workspace.');
  }
  return resolved;
};
