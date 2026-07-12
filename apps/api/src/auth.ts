import { createHash, timingSafeEqual } from 'node:crypto';

import type { Context } from 'hono';

export type EngineScope = 'api' | 'worker' | 'review';

export interface EngineAuthEnv {
  ENGINE_API_TOKEN?: string;
  ENGINE_WORKER_TOKEN?: string;
  ENGINE_REVIEW_TOKEN?: string;
}

export function requireEngineScope(
  context: Context,
  env: EngineAuthEnv,
  scope: EngineScope,
): Response | null {
  const header = context.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return context.json({ error: 'Authentication is required' }, 401);
  }
  const token = header.slice('Bearer '.length);
  if (!tokensMatch(token, tokenForScope(env, scope))) {
    return context.json({ error: 'Token does not have this scope' }, 403);
  }
  return null;
}

function tokenForScope(env: EngineAuthEnv, scope: EngineScope): string | undefined {
  switch (scope) {
    case 'api':
      return env.ENGINE_API_TOKEN;
    case 'worker':
      return env.ENGINE_WORKER_TOKEN;
    case 'review':
      return env.ENGINE_REVIEW_TOKEN;
  }
}

function tokensMatch(provided: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}
