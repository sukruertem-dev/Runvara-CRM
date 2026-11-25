#!/usr/bin/env node
// Writes .env for the local Docker Compose stack with freshly generated secrets.
// Refuses to overwrite an existing .env unless --force is given.
import { createECDH, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(target) && !process.argv.includes('--force')) {
  console.log('.env already exists (use --force to regenerate; this invalidates sessions and encrypted data)');
  process.exit(0);
}
const pw = () => randomBytes(24).toString('base64url');
const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const vapid = createECDH('prime256v1');
vapid.generateKeys();
const env = {
  POSTGRES_PASSWORD: pw(),
  FLEXA_OWNER_PASSWORD: pw(),
  FLEXA_APP_PASSWORD: pw(),
  FLEXA_RELAY_PASSWORD: pw(),
  FLEXA_MASTER_KEY: randomBytes(32).toString('base64'),
  JWT_PRIVATE_KEY_B64: Buffer.from(pem).toString('base64'),
  CSRF_SECRET: randomBytes(32).toString('hex'),
  VAPID_PUBLIC_KEY: vapid.getPublicKey().toString('base64url'),
  // The private number may come without its leading zero bytes.
  VAPID_PRIVATE_KEY: Buffer.concat([Buffer.alloc(32), vapid.getPrivateKey()]).subarray(-32).toString('base64url'),
};
writeFileSync(target, `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 });
console.log(`wrote ${target}`);
