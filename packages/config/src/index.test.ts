import { describe, expect, it } from 'vitest';
import { apiEnvSchema, EnvValidationError, loadEnv } from './index';

const valid = {
  DATABASE_URL: 'postgres://flexa_app:x@localhost:5432/flexa',
  REDIS_URL: 'redis://localhost:6379',
  FLEXA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  API_PUBLIC_URL: 'http://localhost:4000',
  WEB_BASE_URL: 'http://localhost:3000',
  CORS_ORIGINS: 'http://localhost:3000, http://localhost:3001',
  JWT_PRIVATE_KEY_B64: 'x'.repeat(64),
  CSRF_SECRET: 's'.repeat(32),
  COOKIE_SECURE: 'false',
};

describe('loadEnv', () => {
  it('parses and applies defaults and transforms', () => {
    const env = loadEnv(apiEnvSchema, valid);
    expect(env.API_PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000', 'http://localhost:3001']);
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(600);
  });

  it('lists every invalid key without leaking values', () => {
    const secret = 'super-secret-value';
    try {
      loadEnv(apiEnvSchema, { ...valid, FLEXA_MASTER_KEY: secret, DATABASE_URL: 'mysql://x' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const msg = (e as Error).message;
      expect(msg).toContain('FLEXA_MASTER_KEY');
      expect(msg).toContain('DATABASE_URL');
      expect(msg).not.toContain(secret);
    }
  });
});
