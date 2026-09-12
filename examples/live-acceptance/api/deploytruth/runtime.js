import process from 'node:process';
import { URL } from 'node:url';

const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const PROJECT_REF_PATTERN = /^[a-z0-9]{6,64}$/;
const CONNECTION_TIMEOUT_MS = 5_000;

const present = (value) => typeof value === 'string' && value.length > 0;

const deriveSupabaseProjectRef = (value) => {
  if (!present(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
      return undefined;
    }
    const match = /^([a-z0-9]{6,64})\.supabase\.co$/.exec(url.hostname.toLowerCase());
    return match?.[1] && PROJECT_REF_PATTERN.test(match[1]) ? match[1] : undefined;
  } catch {
    return undefined;
  }
};

const publicSettingsUrl = (value) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
      return undefined;
    }
    return new URL('/auth/v1/settings', url.origin).toString();
  } catch {
    return undefined;
  }
};

const discard = async (response) => {
  try {
    await response.body?.cancel();
  } catch {
    // Probe bodies are never inspected or returned.
  }
};

const isTlsFailure = (error) => {
  const candidate =
    typeof error === 'object' && error !== null ? (error.cause?.code ?? error.code) : undefined;
  return (
    typeof candidate === 'string' &&
    (candidate.startsWith('CERT_') ||
      candidate.startsWith('ERR_TLS_') ||
      candidate === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      candidate === 'DEPTH_ZERO_SELF_SIGNED_CERT')
  );
};

const probeSupabase = async (supabaseUrl, publishableKey, targetProjectRef) => {
  const url = publicSettingsUrl(supabaseUrl);
  const identity = targetProjectRef === undefined ? 'unverified' : 'verified';
  if (url === undefined || !present(publishableKey)) {
    return {
      provider: 'supabase',
      ...(targetProjectRef !== undefined ? { targetProjectRef } : {}),
      identity,
      status: 'unavailable',
      reason: 'missing_configuration',
    };
  }

  const timeout = globalThis.AbortSignal.timeout(CONNECTION_TIMEOUT_MS);
  try {
    const result = await globalThis.fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json', apikey: publishableKey },
      signal: timeout,
    });
    await discard(result);
    if (result.ok) {
      return {
        provider: 'supabase',
        ...(targetProjectRef !== undefined ? { targetProjectRef } : {}),
        identity,
        status: 'connected',
        ...(identity === 'unverified' ? { reason: 'identity_unverified' } : {}),
      };
    }
    return {
      provider: 'supabase',
      ...(targetProjectRef !== undefined ? { targetProjectRef } : {}),
      identity,
      status: 'unavailable',
      reason:
        result.status === 401 || result.status === 403
          ? 'credentials_rejected'
          : 'unexpected_status',
    };
  } catch (error) {
    return {
      provider: 'supabase',
      ...(targetProjectRef !== undefined ? { targetProjectRef } : {}),
      identity,
      status: 'unavailable',
      reason: timeout.aborted ? 'timeout' : isTlsFailure(error) ? 'tls_error' : 'network_error',
    };
  }
};

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  const nonce = typeof request.query?.nonce === 'string' ? request.query.nonce : undefined;
  if (nonce === undefined || !NONCE_PATTERN.test(nonce)) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    return response.status(400).json({ error: 'invalid_nonce' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const targetProjectRef = deriveSupabaseProjectRef(supabaseUrl);
  const database = await probeSupabase(supabaseUrl, publishableKey, targetProjectRef);
  const commit = process.env.VERCEL_GIT_COMMIT_SHA;
  const environment = present(process.env.VERCEL_ENV) ? process.env.VERCEL_ENV : 'local';

  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  return response.status(200).json({
    version: 1,
    nonce,
    ...(present(commit) && COMMIT_SHA_PATTERN.test(commit) ? { commit } : {}),
    environment,
    environmentVariables: {
      SUPABASE_URL: present(supabaseUrl),
      SUPABASE_PUBLISHABLE_KEY: present(publishableKey),
    },
    connections: { database },
  });
}
