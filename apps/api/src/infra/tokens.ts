import type { ApiEnv } from '@runvara/config';
import type { MailJob } from '@runvara/contracts';
import type { DbHandle } from '@runvara/db';
import type { KeyRing, TokenSigner } from '@runvara/security';
import type { Redis } from 'ioredis';

export const ENV = Symbol('ENV');
export const DB = Symbol('DB');
export const REDIS = Symbol('REDIS');
export const MAILER = Symbol('MAILER');
export const SIGNER = Symbol('SIGNER');
export const KEYRING = Symbol('KEYRING');

export interface Mailer {
  send(job: MailJob): Promise<void>;
}

export interface ApiDeps {
  env: ApiEnv;
  db: DbHandle;
  redis: Redis;
  mailer: Mailer;
}

export type { ApiEnv, DbHandle, KeyRing, Redis, TokenSigner };
