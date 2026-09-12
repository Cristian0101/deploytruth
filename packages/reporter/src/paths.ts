import { relative, resolve, sep } from 'node:path';

export class HistoryPathError extends Error {
  readonly code = 'invalid_path' as const;

  constructor(message: string) {
    super(message);
    this.name = 'HistoryPathError';
  }
}

const SAFE_KEY = /^[A-Za-z0-9._-]{1,120}$/;

/** Filesystem-safe project/environment key. Never used as a raw path fragment. */
export const filesystemKey = (value: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new HistoryPathError('Project and environment names must be safe path identifiers.');
  }
  if (value.includes('/') || value.includes('\\') || value.includes(':')) {
    throw new HistoryPathError('Project and environment names cannot contain path separators.');
  }
  if (value.includes('..') || value === '.' || value === '..') {
    throw new HistoryPathError('Project and environment names cannot traverse directories.');
  }
  if (value.startsWith('/') || value.startsWith('\\')) {
    throw new HistoryPathError('Project and environment names cannot be absolute paths.');
  }
  const key = value
    .trim()
    .replaceAll(/\s+/g, '-')
    .replaceAll(/[^A-Za-z0-9._-]/g, '-');
  if (!SAFE_KEY.test(key) || key === '.' || key === '..' || key.startsWith('.')) {
    throw new HistoryPathError(
      'Project and environment names must be filesystem-safe identifiers.',
    );
  }
  return key;
};

export const assertInside = (rootDirectory: string, candidate: string): string => {
  const root = resolve(rootDirectory);
  const resolved = resolve(candidate);
  const relativePath = relative(root, resolved);
  if (
    relativePath.startsWith('..') ||
    relativePath.includes(`..${sep}`) ||
    resolve(root, relativePath) !== resolved
  ) {
    throw new HistoryPathError('Path escapes the local report store.');
  }
  return resolved;
};
