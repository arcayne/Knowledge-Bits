import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { createRemoteJWKSet, jwtVerify } from 'jose';

export const REVIEW_CSRF_COOKIE = 'kb_review_csrf';

export class OperatorAuthError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OperatorAuthError';
    this.status = status;
  }
}

export async function authenticateOperator(request, env, dependencies = {}) {
  const localOperatorId = configured(env.REVIEW_LOCAL_OPERATOR_ID ?? process.env.REVIEW_LOCAL_OPERATOR_ID);
  if (dependencies.allowLocalOperator && localOperatorId) {
    return { reviewerId: localOperatorId };
  }

  const jwksUrl = configured(env.REVIEW_AUTH_JWKS_URL);
  const issuer = configured(env.REVIEW_AUTH_ISSUER);
  const audience = configured(env.REVIEW_AUTH_AUDIENCE);
  if (!jwksUrl || !issuer || !audience) {
    throw new OperatorAuthError('Review operator authentication is not configured', 503);
  }
  const headerName = configured(env.REVIEW_AUTH_HEADER) ?? 'Cf-Access-Jwt-Assertion';
  const token = request.headers.get(headerName)?.trim();
  if (!token) throw new OperatorAuthError('Review operator authentication is required', 401);

  try {
    const jwks = dependencies.jwks ?? createRemoteJWKSet(new URL(jwksUrl));
    const { payload } = await jwtVerify(token, jwks, { issuer, audience });
    if (!payload.sub?.trim()) throw new OperatorAuthError('Review identity has no subject', 403);
    const requiredGroup = configured(env.REVIEW_AUTH_REQUIRED_GROUP);
    if (requiredGroup && !claimValues(payload.groups).includes(requiredGroup)) {
      throw new OperatorAuthError('Review identity is not authorized', 403);
    }
    return { reviewerId: payload.sub.trim() };
  } catch (error) {
    if (error instanceof OperatorAuthError) throw error;
    throw new OperatorAuthError('Review operator authentication is invalid', 401);
  }
}

export function createCsrfToken() {
  return randomBytes(32).toString('base64url');
}

export function validateReviewMutation(request, { expectedOrigin, cookieToken }) {
  let configuredOrigin;
  try {
    configuredOrigin = new URL(expectedOrigin).origin;
  } catch {
    throw new OperatorAuthError('Review public origin is not configured', 503);
  }
  if (request.headers.get('Origin') !== configuredOrigin) {
    throw new OperatorAuthError('Review request origin is not allowed', 403);
  }
  const headerToken = request.headers.get('X-CSRF-Token')?.trim();
  if (!headerToken || !cookieToken || !tokensMatch(headerToken, cookieToken)) {
    throw new OperatorAuthError('Review CSRF token is invalid', 403);
  }
}

export function csrfCookieFromRequest(request) {
  const cookies = request.headers.get('Cookie')?.split(';') ?? [];
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === REVIEW_CSRF_COOKIE) {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    }
  }
  return undefined;
}

export function operatorErrorResponse(error) {
  if (error instanceof OperatorAuthError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

function tokensMatch(left, right) {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function claimValues(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
}

function configured(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
