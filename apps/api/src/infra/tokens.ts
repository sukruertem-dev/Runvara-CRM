import type { ApiEnv } from '@flexa/config';
import type { MailJob } from '@flexa/contracts';
import type { DbHandle } from '@flexa/db';
import type { KeyRing, TokenSigner } from '@flexa/security';
import type { Redis } from 'ioredis';
import type { AttachmentScanner } from './scanner';
import type { ObjectStorage } from './storage';

export const ENV = Symbol('ENV');
export const DB = Symbol('DB');
export const REDIS = Symbol('REDIS');
export const MAILER = Symbol('MAILER');
export const SIGNER = Symbol('SIGNER');
export const KEYRING = Symbol('KEYRING');
export const STORAGE = Symbol('STORAGE');
export const SCANNER = Symbol('SCANNER');

export interface Mailer {
  /** `jobId` makes the enqueue idempotent (the same id is not queued twice). */
  send(job: MailJob, opts?: { jobId?: string }): Promise<void>;
}

export interface ApiDeps {
  env: ApiEnv;
  db: DbHandle;
  redis: Redis;
  mailer: Mailer;
  /** Overrides for tests; by default built from the environment (infra/storage.ts, infra/scanner.ts). */
  storage?: ObjectStorage | null;
  scanner?: AttachmentScanner | null;
}

export type { ApiEnv, DbHandle, KeyRing, Redis, TokenSigner };
