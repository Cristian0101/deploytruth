import process from 'node:process';

const safeValue = (value, fallback) =>
  typeof value === 'string' && value.length > 0 ? value : fallback;

export default function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  response.setHeader('Cache-Control', 'no-store');
  return response.status(200).json({
    commit: safeValue(process.env.VERCEL_GIT_COMMIT_SHA, 'local'),
    environment: safeValue(process.env.VERCEL_ENV, 'local'),
  });
}
