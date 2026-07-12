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

  return new PrismaClient({
    datasources: {
      db: { url: env.DATABASE_URL },
    },
  });
}
