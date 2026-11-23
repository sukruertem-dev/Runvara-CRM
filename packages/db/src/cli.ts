import { loadEnv, migrateEnvSchema } from '@flexa/config';
import { migrate } from './migrate';
import { copyTenant, setOperator } from './ops';

// node dist/cli.js                              apply migrations (DATABASE_OWNER_URL)
// node dist/cli.js operator grant|revoke <email> mark an account as platform operator (DATABASE_OWNER_URL)
// node dist/cli.js restore-tenant <tenant id>    copy one tenant from RESTORE_SOURCE_URL to RESTORE_TARGET_URL
//                                               (both superuser connections; docs/ops/tenant-restore.md)

function postgresUrl(name: string): string {
  const v = process.env[name];
  if (!v || !/^postgres(ql)?:\/\//.test(v)) throw new Error(`${name} must be a postgres:// URL`);
  return v;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined) {
    const env = loadEnv(migrateEnvSchema);
    const result = await migrate(env.DATABASE_OWNER_URL);
    process.stdout.write(`migrations: ${String(result.applied.length)} applied (${result.applied.join(', ') || '-'}), ${String(result.skipped.length)} already applied\n`);
    return;
  }
  if (command === 'operator') {
    const [action, email] = args;
    if ((action !== 'grant' && action !== 'revoke') || !email) throw new Error('usage: operator grant|revoke <email>');
    const env = loadEnv(migrateEnvSchema);
    process.stdout.write(`operator ${email}: ${await setOperator(env.DATABASE_OWNER_URL, email, action === 'grant')}\n`);
    return;
  }
  if (command === 'restore-tenant') {
    const [tenantId] = args;
    if (!tenantId || !UUID.test(tenantId)) throw new Error('usage: restore-tenant <tenant id>');
    const counts = await copyTenant(postgresUrl('RESTORE_SOURCE_URL'), postgresUrl('RESTORE_TARGET_URL'), tenantId);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    process.stdout.write(`tenant ${tenantId} restored: ${String(total)} rows in ${String(Object.keys(counts).length)} tables\n`);
    return;
  }
  throw new Error(`unknown command ${command}`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
