import { startTestDatabase, type TestDatabase } from '@runvara/db/testing';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

let db: TestDatabase | undefined;
let redis: StartedTestContainer | undefined;

/** One PostgreSQL 18 + Redis 7 pair for the whole integration run; URLs are handed to workers via env. */
export async function setup(): Promise<void> {
  [db, redis] = await Promise.all([
    startTestDatabase(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  ]);
  process.env.TEST_DATABASE_URL = db.appUrl;
  process.env.TEST_SUPER_DATABASE_URL = db.superUrl;
  process.env.TEST_REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
}

export async function teardown(): Promise<void> {
  await Promise.all([db?.stop(), redis?.stop()]);
}
