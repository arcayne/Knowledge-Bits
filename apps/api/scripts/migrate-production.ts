import { execFileSync } from 'node:child_process';

import { migrationDatabaseEnvironment } from '../src/config.js';

const databaseEnvironment = migrationDatabaseEnvironment(process.env);

execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL: '',
    ...databaseEnvironment,
  },
});
