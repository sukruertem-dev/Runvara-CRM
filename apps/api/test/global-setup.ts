import { startTestDatabase, type TestDatabase } from '@flexa/db/testing';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

let db: TestDatabase | undefined;
let redis: StartedTestContainer | undefined;
let s3: StartedTestContainer | undefined;

/** One PostgreSQL 18 + Redis 7 + S3-compatible store (SeaweedFS) for the whole integration run; URLs are
 *  handed to workers via env. */
export async function setup(): Promise<void> {
  [db, redis, s3] = await Promise.all([
    startTestDatabase(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    new GenericContainer('chrislusf/seaweedfs:3.80')
      .withCommand(['server', '-s3', '-dir=/data', '-volume.max=20', '-master.volumeSizeLimitMB=32'])
      .withExposedPorts(8333)
      .withWaitStrategy(Wait.forLogMessage(/S3 API Server/))
      .start(),
  ]);
  const endpoint = `http://${s3.getHost()}:${s3.getMappedPort(8333)}`;
  const client = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  for (let i = 0; ; i++) {
    try {
      await client.send(new CreateBucketCommand({ Bucket: 'flexa-test' }));
      break;
    } catch (e) {
      if (i > 30) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  process.env.TEST_S3_ENDPOINT = endpoint;
  process.env.TEST_DATABASE_URL = db.appUrl;
  process.env.TEST_SUPER_DATABASE_URL = db.superUrl;
  process.env.TEST_REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
}

export async function teardown(): Promise<void> {
  await Promise.all([db?.stop(), redis?.stop(), s3?.stop()]);
}
