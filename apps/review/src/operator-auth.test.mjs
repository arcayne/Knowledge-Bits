import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
} from 'jose';

import {
  authenticateOperator,
  createCsrfToken,
  validateReviewMutation,
} from './operator-auth.mjs';

const issuer = 'https://identity.example.test';
const audience = 'knowledge-bits-review';

test('authenticates a review operator from a verified upstream OIDC token', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'review-key-1';
  const token = await new SignJWT({ groups: ['content-reviewers'] })
    .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('operator-123')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

  const principal = await authenticateOperator(new Request('https://review.example.test/runs/1', {
    headers: { 'Cf-Access-Jwt-Assertion': token },
  }), authEnv(), { jwks: createLocalJWKSet({ keys: [publicJwk] }) });

  assert.deepEqual(principal, { reviewerId: 'operator-123' });
});

test('fails closed for missing identity configuration, missing tokens, and unauthorized groups', async () => {
  await assert.rejects(
    authenticateOperator(new Request('https://review.example.test'), {}),
    (error) => error instanceof Error && 'status' in error && error.status === 503,
  );
  await assert.rejects(
    authenticateOperator(new Request('https://review.example.test'), authEnv(), { jwks: async () => { throw new Error('not used'); } }),
    (error) => error instanceof Error && 'status' in error && error.status === 401,
  );
});

test('reads production identity configuration from the server runtime environment', async () => {
  const keys = [
    'REVIEW_AUTH_JWKS_URL',
    'REVIEW_AUTH_ISSUER',
    'REVIEW_AUTH_AUDIENCE',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    REVIEW_AUTH_JWKS_URL: 'https://identity.example.test/.well-known/jwks.json',
    REVIEW_AUTH_ISSUER: issuer,
    REVIEW_AUTH_AUDIENCE: audience,
  });

  try {
    await assert.rejects(
      authenticateOperator(new Request('https://review.example.test'), {}),
      (error) => error instanceof Error
        && 'status' in error
        && error.status === 401
        && /required/i.test(error.message),
    );
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('accepts an explicit local operator only when the caller enables local mode', async () => {
  const env = { REVIEW_LOCAL_OPERATOR_ID: 'local-reviewer' };
  const request = new Request('http://127.0.0.1:4321/runs/local');

  const principal = await authenticateOperator(request, env, { allowLocalOperator: true });
  assert.deepEqual(principal, { reviewerId: 'local-reviewer' });

  await assert.rejects(
    authenticateOperator(request, env, { allowLocalOperator: false }),
    (error) => error instanceof Error && 'status' in error && error.status === 503,
  );
});

test('requires exact origin and CSRF token binding for review mutations', () => {
  const token = createCsrfToken();
  const valid = new Request('https://review.example.test/api/review', {
    method: 'POST',
    headers: { Origin: 'https://review.example.test', 'X-CSRF-Token': token },
  });
  assert.doesNotThrow(() => validateReviewMutation(valid, {
    expectedOrigin: 'https://review.example.test',
    cookieToken: token,
  }));

  const crossOrigin = new Request('https://review.example.test/api/review', {
    method: 'POST',
    headers: { Origin: 'https://attacker.example', 'X-CSRF-Token': token },
  });
  assert.throws(() => validateReviewMutation(crossOrigin, {
    expectedOrigin: 'https://review.example.test',
    cookieToken: token,
  }), /origin/i);
  assert.throws(() => validateReviewMutation(valid, {
    expectedOrigin: 'https://review.example.test',
    cookieToken: 'different-token',
  }), /CSRF/i);
});

function authEnv() {
  return {
    REVIEW_AUTH_JWKS_URL: 'https://identity.example.test/.well-known/jwks.json',
    REVIEW_AUTH_ISSUER: issuer,
    REVIEW_AUTH_AUDIENCE: audience,
    REVIEW_AUTH_REQUIRED_GROUP: 'content-reviewers',
  };
}
