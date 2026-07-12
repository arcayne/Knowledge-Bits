import { execFileSync } from 'node:child_process';

import { assertEngineIsolation } from '../src/config.js';

assertEngineIsolation(process.env);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for a local test migration');

const database = new URL(databaseUrl);
const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
if (!localHosts.has(database.hostname)) {
  throw new Error('DATABASE_URL must point to a local PostgreSQL database');
}

if (!database.pathname.toLowerCase().includes('test')) {
  throw new Error('DATABASE_URL must name a test database');
}

execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { stdio: 'inherit' });
