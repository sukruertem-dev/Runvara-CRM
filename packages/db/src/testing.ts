import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { migrate, rolesSql } from './migrate';

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  /** flexa_app — the role the application uses (RLS enforced). */
  appUrl: string;
  /** flexa_owner — migrations and SECURITY DEFINER owner. */
  ownerUrl: string;
  /** flexa_relay (outbox relay, BYPASSRLS). */
  relayUrl: string;
  /** Superuser, for assertions that must see everything. */
  superUrl: string;
  stop(): Promise<void>;
}

const PASSWORDS = { owner_password: 'owner_test_pw', app_password: 'app_test_pw', relay_password: 'relay_test_pw' };

/** Starts PostgreSQL 18 in a container, creates the Flexa roles exactly as production does and migrates. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('flexa')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();
  const host = container.getHost();
  const port = container.getPort();
  const superUrl = `postgres://postgres:postgres@${host}:${port}/flexa`;
  const su = new pg.Client({ connectionString: superUrl });
  await su.connect();
  try {
    await su.query(rolesSql({ ...PASSWORDS, db_name: 'flexa' }));
  } finally {
    await su.end();
  }
  const ownerUrl = `postgres://flexa_owner:${PASSWORDS.owner_password}@${host}:${port}/flexa`;
  const appUrl = `postgres://flexa_app:${PASSWORDS.app_password}@${host}:${port}/flexa`;
  const relayUrl = `postgres://flexa_relay:${PASSWORDS.relay_password}@${host}:${port}/flexa`;
  await migrate(ownerUrl);
  return {
    container,
    appUrl,
    ownerUrl,
    relayUrl,
    superUrl,
    stop: async () => {
      await container.stop();
    },
  };
}

/** Runs one statement as superuser (test assertions only). */
export async function superQuery<R extends pg.QueryResultRow = pg.QueryResultRow>(
  superUrl: string,
  text: string,
  values: unknown[] = [],
): Promise<R[]> {
  const c = new pg.Client({ connectionString: superUrl });
  await c.connect();
  try {
    return (await c.query<R>(text, values)).rows;
  } finally {
    await c.end();
  }
}

/** Opens a raw flexa_app connection (for proving RLS cannot be bypassed without the helpers). */
export async function rawAppClient(appUrl: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: appUrl });
  await c.connect();
  return c;
}
