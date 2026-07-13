import { PrismaClient } from '@prisma/client';

export const FORBIDDEN_NUGLET_ENGINE_ENV = [
  'NUGLET_DATABASE_URL',
  'NUGLET_RUNTIME_DATABASE_URL',
  'NUGLET_DIRECT_DATABASE_URL',
  'NUGLET_SUPABASE_SERVICE_ROLE_KEY',
] as const;

export function assertEngineIsolation(env: NodeJS.ProcessEnv): void {
  const present = FORBIDDEN_NUGLET_ENGINE_ENV.filter((name) => Boolean(env[name]?.trim()));

  if (present.length) {
    throw new Error(`Forbidden Nuglet production configuration: ${present.join(', ')}`);
  }
}

export function createIsolatedPrismaClient(env: NodeJS.ProcessEnv = process.env): PrismaClient {
  assertEngineIsolation(env);
  if (env.DATABASE_URL?.trim()) {
    throw new Error('DATABASE_URL is not permitted for the workflow engine; use ENGINE_DATABASE_URL');
  }
  if (env.ENGINE_MIGRATION_DATABASE_URL?.trim()) {
    throw new Error('Migration-owner credentials are not permitted in the deployed runtime');
  }

  const databaseUrl = env.ENGINE_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('ENGINE_DATABASE_URL is required for the workflow engine');

  return new PrismaClient({
    datasources: {
      db: { url: databaseUrl },
    },
  });
}

export function migrationDatabaseEnvironment(env: NodeJS.ProcessEnv): {
  ENGINE_DATABASE_URL: string;
  ENGINE_MIGRATION_DATABASE_URL: string;
} {
  assertEngineIsolation(env);
  const runtimeUrl = env.ENGINE_DATABASE_URL?.trim();
  const migrationUrl = env.ENGINE_MIGRATION_DATABASE_URL?.trim();
  if (!runtimeUrl || !migrationUrl) {
    throw new Error('ENGINE_DATABASE_URL and ENGINE_MIGRATION_DATABASE_URL are required for migrations');
  }
  let runtimeUser: string;
  let migrationUser: string;
  try {
    runtimeUser = decodeURIComponent(new URL(runtimeUrl).username);
    migrationUser = decodeURIComponent(new URL(migrationUrl).username);
  } catch {
    throw new Error('Engine database URLs must be valid PostgreSQL URLs');
  }
  if (!runtimeUser || !migrationUser || runtimeUser === migrationUser) {
    throw new Error('Runtime and migration connections must use distinct database roles');
  }
  return {
    ENGINE_DATABASE_URL: runtimeUrl,
    ENGINE_MIGRATION_DATABASE_URL: migrationUrl,
  };
}
