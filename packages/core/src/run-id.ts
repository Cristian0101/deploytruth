import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Crockford Base32 ULID: 48-bit timestamp + 80-bit cryptographically random entropy. */
export const RUN_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const encodeCrockford = (value: bigint, length: number): string => {
  const chars: string[] = [];
  let remaining = value;
  for (let index = 0; index < length; index += 1) {
    chars.push(ENCODING[Number(remaining & 31n)] ?? '0');
    remaining >>= 5n;
  }
  return chars.reverse().join('');
};

const bytesToBigInt = (bytes: Uint8Array): bigint => {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) + BigInt(byte);
  }
  return value;
};

export const isRunId = (value: string): boolean => RUN_ID_PATTERN.test(value);

export const createRunId = (
  timestampMs = Date.now(),
  entropy: Uint8Array = randomBytes(10),
): string => {
  if (!Number.isInteger(timestampMs) || timestampMs < 0) {
    throw new Error('Run ID timestamp must be a non-negative integer.');
  }
  if (entropy.length < 10) {
    throw new Error('Run ID entropy must be at least 10 bytes.');
  }
  return `${encodeCrockford(BigInt(timestampMs), 10)}${encodeCrockford(bytesToBigInt(entropy.subarray(0, 10)), 16)}`;
};

/** Deterministic identity for a known legacy report body. Not used for live checks. */
export const createLegacyRunId = (contents: string): string => {
  const bytes = new Uint8Array(10);
  const encoded = new TextEncoder().encode(contents);
  for (let index = 0; index < encoded.length; index += 1) {
    bytes[index % 10] = (bytes[index % 10] ?? 0) ^ (encoded[index] ?? 0);
    bytes[(index + 3) % 10] = ((bytes[(index + 3) % 10] ?? 0) + (encoded[index] ?? 0)) & 0xff;
  }
  return createRunId(0, bytes);
};
