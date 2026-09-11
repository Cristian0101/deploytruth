import { createHash } from 'node:crypto';

import type { SafeValue } from './domain.js';

const SENSITIVE_KEY =
  /(?:token|secret|password|passphrase|api[_-]?key|service[_-]?role|private[_-]?key)/i;
const INLINE_ASSIGNMENT =
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|SERVICE_ROLE)[A-Z0-9_]*)=([^\s,;]+)/g;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+\-/]+=*/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const KNOWN_TOKEN =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk_[A-Za-z0-9_-]{8,}|vercel_[A-Za-z0-9_-]{8,}|sbp_[A-Za-z0-9_-]{8,})\b/g;
const URL_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;

/** Returns a non-reversible short identifier for an already acquired secret. */
export const fingerprintSecret = (secret: string): string => {
  const digest = createHash('sha256').update(secret).digest('hex');
  return `${digest.slice(0, 8)}…${digest.slice(-4)}`;
};

/** Redacts common secret shapes before they can cross a reporting boundary. */
export const redactText = (value: string): string =>
  value
    .replace(INLINE_ASSIGNMENT, '$1=[REDACTED]')
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(JWT, '[REDACTED_JWT]')
    .replace(KNOWN_TOKEN, '[REDACTED_TOKEN]')
    .replace(URL_CREDENTIAL, '$1[REDACTED]:[REDACTED]@');

const isSafeFingerprintField = (key: string): boolean => key.toLowerCase() === 'fingerprint';
const isSafePresenceField = (key: string): boolean =>
  ['present', 'absent'].includes(key.toLowerCase());

/**
 * Produces JSON-safe data and redacts sensitive keys and embedded secret patterns recursively.
 * Provider raw payloads must never be passed here; this is a final defensive boundary.
 */
export const sanitizeForReport = (value: unknown, parentKey?: string): SafeValue => {
  if (typeof value === 'string') {
    return parentKey && SENSITIVE_KEY.test(parentKey) && !isSafeFingerprintField(parentKey)
      ? '[REDACTED]'
      : redactText(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForReport(item, parentKey));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => {
        if (SENSITIVE_KEY.test(key) && !isSafeFingerprintField(key) && !isSafePresenceField(key)) {
          return [key, '[REDACTED]'];
        }
        return [key, sanitizeForReport(nestedValue, key)];
      }),
    );
  }

  return `[UNSERIALIZABLE:${typeof value}]`;
};
