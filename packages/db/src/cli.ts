import { loadEnv, migrateEnvSchema } from '@runvara/config';
import { migrate } from './migrate';

async function main(): Promise<void> {
  const env = loadEnv(migrateEnvSchema);
  const result = await migrate(env.DATABASE_OWNER_URL);
  process.stdout.write(
    `migrations: ${result.applied.length} applied (${result.applied.join(', ') || '-'}), ${result.skipped.length} already applied\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
