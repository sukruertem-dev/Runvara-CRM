// Generates src/generated/matrix.json from docs/enterprise/permission-matrix.yaml (single source, ADR-0004).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../../docs/enterprise/permission-matrix.yaml');
const out = resolve(here, '../src/generated/matrix.json');
const m = parse(readFileSync(source, 'utf8'));

const rows = [...m.matrix_a, ...m.matrix_ai].map((r) => ({ id: r.id, module: r.module, permissions: r.permissions, grants: r.grants ?? {} }));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify({ version: m.version, roles: Object.keys(m.roles), protected: m.protected_permissions, policies: m.policies, constraints: m.constraints, rows }, null, 2)}\n`,
);
process.stdout.write(`authz matrix: ${rows.length} rows → ${out}\n`);
