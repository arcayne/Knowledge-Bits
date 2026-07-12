import { createHash, timingSafeEqual } from 'node:crypto';

import type { Context } from 'hono';

export type EngineScope = 'api' | 'worker' | 'review';

export interface EngineAuthEnv {
  ENGINE_API_TOKEN?: string;
  ENGINE_REVIEW_TOKEN?: string;
  ENGINE_WORKER_CREDENTIALS?: string;
}

export interface WorkerPrincipal {
  workerId: string;
  capabilities: string[];
}

export interface EngineAuthConfig {
  apiToken?: string;
  reviewToken?: string;
  workersByToken: Map<string, WorkerPrincipal>;
}

interface WorkerCredential extends WorkerPrincipal {
  token: string;
}

export function createEngineAuthConfig(env: EngineAuthEnv): EngineAuthConfig {
  const credentials = parseWorkerCredentials(env.ENGINE_WORKER_CREDENTIALS);
  const tokens = [env.ENGINE_API_TOKEN, env.ENGINE_REVIEW_TOKEN, ...credentials.map(({ token }) => token)]
    .map((token) => token?.trim())
    .filter((token): token is string => Boolean(token));
  if (new Set(tokens).size !== tokens.length) {
    throw new Error('Engine API, review, and worker credentials must use distinct tokens');
  }

  return {
    apiToken: env.ENGINE_API_TOKEN?.trim(),
    reviewToken: env.ENGINE_REVIEW_TOKEN?.trim(),
    workersByToken: new Map(credentials.map(({ token, workerId, capabilities }) => [token, {
      workerId,
      capabilities,
    }])),
  };
}

export function requireEngineScope(
  context: Context,
  config: EngineAuthConfig,
  scope: EngineScope,
): Response | null {
  const header = context.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return context.json({ error: 'Authentication is required' }, 401);
  }
  const token = header.slice('Bearer '.length);
  if (!tokensMatch(token, tokenForScope(config, scope))) {
    return context.json({ error: 'Token does not have this scope' }, 403);
  }
  return null;
}

export function requireWorkerPrincipal(
  context: Context,
  config: EngineAuthConfig,
): WorkerPrincipal | Response {
  const header = context.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return context.json({ error: 'Authentication is required' }, 401);
  }
  const token = header.slice('Bearer '.length);
  const principal = [...config.workersByToken.entries()].find(([candidate]) => tokensMatch(token, candidate))?.[1];
  if (!principal) return context.json({ error: 'Token does not have this scope' }, 403);
  return principal;
}

function tokenForScope(config: EngineAuthConfig, scope: EngineScope): string | undefined {
  switch (scope) {
    case 'api':
      return config.apiToken;
    case 'worker':
      return undefined;
    case 'review':
      return config.reviewToken;
  }
}

function parseWorkerCredentials(value: string | undefined): WorkerCredential[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('ENGINE_WORKER_CREDENTIALS must be valid JSON');
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error('ENGINE_WORKER_CREDENTIALS must contain at least one worker credential');
  }

  const credentials = parsed.map((candidate) => {
    if (!isWorkerCredential(candidate)) {
      throw new Error('ENGINE_WORKER_CREDENTIALS contains an invalid worker credential');
    }
    return {
      token: candidate.token.trim(),
      workerId: candidate.workerId.trim(),
      capabilities: candidate.capabilities.map((capability) => capability.trim()),
    };
  });
  if (new Set(credentials.map(({ token }) => token)).size !== credentials.length
    || new Set(credentials.map(({ workerId }) => workerId)).size !== credentials.length) {
    throw new Error('ENGINE_WORKER_CREDENTIALS must not duplicate worker tokens or worker ids');
  }
  return credentials;
}

function isWorkerCredential(value: unknown): value is WorkerCredential {
  return typeof value === 'object'
    && value !== null
    && 'token' in value
    && 'workerId' in value
    && 'capabilities' in value
    && typeof value.token === 'string'
    && Boolean(value.token.trim())
    && typeof value.workerId === 'string'
    && Boolean(value.workerId.trim())
    && Array.isArray(value.capabilities)
    && value.capabilities.length > 0
    && value.capabilities.every((capability) => typeof capability === 'string' && Boolean(capability.trim()));
}

function tokensMatch(provided: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}
