import type { ApiEnv } from '@flexa/config';
import type { MailJob } from '@flexa/contracts';
import type { DbHandle } from '@flexa/db';
import type { KeyRing, TokenSigner } from '@flexa/security';
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
