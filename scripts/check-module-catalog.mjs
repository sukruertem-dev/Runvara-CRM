#!/usr/bin/env node
// Validates docs/enterprise/module-catalog.json: JSON Schema, dependency graph (unknown ids, cycles),
// §10.3.1 dependency table, and that every permission key used in permission-matrix.yaml belongs to its module.
// Usage: node scripts/check-module-catalog.mjs [--root <repo root>]   (requires ajv, ajv-formats, yaml)
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

const rootArg = process.argv.indexOf('--root');
const root = rootArg > -1 ? resolve(process.argv[rootArg + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const schema = JSON.parse(read('docs/enterprise/module-manifest.schema.json'));
const { modules } = JSON.parse(read('docs/enterprise/module-catalog.json'));
const matrix = parse(read('docs/enterprise/permission-matrix.yaml'));
const errors = [];

const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
for (const m of modules) if (!validate(m)) errors.push(`${m.id}: ${JSON.stringify(validate.errors)}`);

const ids = new Set(modules.map((m) => m.id));
if (ids.size !== modules.length) errors.push('duplicate module ids');

// §10.3.1 dependency table (CNF): must match exactly
const expected = {
  core: [], crm: [['core']], sales_b2b: [['crm']], sales_b2c: [['crm']], sales_tracking: [['sales_b2b', 'sales_b2c']],
  call_center: [['crm']], dialer: [['call_center'], ['sales_b2b', 'sales_b2c']], call_qa: [['call_center']], data_service: [['crm']],
  automation_sla: [['core']], reporting_advanced: [['core']], api_webhooks: [['core']], ai_assistant: [['core']],
};
for (const [id, deps] of Object.entries(expected)) {
  const m = modules.find((x) => x.id === id);
  if (!m) { errors.push(`missing module ${id}`); continue; }
  if (JSON.stringify(m.dependsOn) !== JSON.stringify(deps)) errors.push(`${id}: dependsOn ${JSON.stringify(m.dependsOn)} ≠ §10.3.1 ${JSON.stringify(deps)}`);
}
if (modules.length !== Object.keys(expected).length) errors.push(`catalog has ${modules.length} modules, §10.3.1 has ${Object.keys(expected).length}`);

// cycle detection over the union of all dependency edges
const edges = new Map(modules.map((m) => [m.id, m.dependsOn.flat()]));
const state = new Map();
const visit = (id, path) => {
  if (state.get(id) === 2) return;
  if (state.get(id) === 1) { errors.push(`dependency cycle: ${[...path, id].join(' → ')}`); return; }
  state.set(id, 1);
  for (const d of edges.get(id) ?? []) { if (!ids.has(d)) errors.push(`${id}: unknown dependency ${d}`); else visit(d, [...path, id]); }
  state.set(id, 2);
};
for (const id of ids) visit(id, []);

// permission ownership
const owned = new Map(modules.flatMap((m) => m.permissions.map((p) => [p.key, m.id])));
for (const row of [...matrix.matrix_a, ...matrix.matrix_ai]) {
  for (const k of row.permissions) {
    if (owned.get(k) !== row.module) errors.push(`${row.id}: permission ${k} owned by ${owned.get(k) ?? 'nobody'}, matrix says ${row.module}`);
  }
}

console.log(errors.length ? `FAIL (${errors.length})\n${errors.join('\n')}` : `PASS modules=${modules.length} permissions=${owned.size}`);
process.exit(errors.length ? 1 : 0);
