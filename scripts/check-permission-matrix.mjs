#!/usr/bin/env node
// Verifies docs/enterprise/permission-matrix.yaml against the source tables in
// CRM_TASK_PLATFORM_PROMPT.md (§10.4.3 Matrix A, §11.4 AI matrix) and internal consistency.
// Usage: node scripts/check-permission-matrix.mjs [--root <repo root>]
// Requires the `yaml` package (root devDependency from Faz 1). Exit code 1 on any mismatch.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const rootArg = process.argv.indexOf('--root');
const root = rootArg > -1 ? resolve(process.argv[rootArg + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spec = readFileSync(resolve(root, 'CRM_TASK_PLATFORM_PROMPT.md'), 'utf8');
const matrix = parse(readFileSync(resolve(root, 'docs/enterprise/permission-matrix.yaml'), 'utf8'));
const ROLES = ['admin', 'manager', 'sales_rep', 'call_agent', 'analyst'];
const errors = [];

const norm = (s) => s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();

function tableAfter(heading) {
  const start = spec.indexOf(heading);
  if (start < 0) throw new Error(`Heading not found: ${heading}`);
  const lines = spec.slice(start).split('\n');
  const rows = [];
  let inTable = false;
  for (const line of lines.slice(1)) {
    if (line.startsWith('|')) {
      inTable = true;
      const cells = line.split('|').slice(1, -1).map(norm);
      if (cells.every((c) => /^-+$/.test(c))) continue;
      rows.push(cells);
    } else if (inTable) break;
  }
  return rows.slice(1); // drop header row
}

function compare(name, specRows, yamlRows) {
  if (specRows.length !== yamlRows.length) errors.push(`${name}: spec has ${specRows.length} rows, yaml has ${yamlRows.length}`);
  specRows.forEach((cells, i) => {
    const row = yamlRows[i];
    if (!row) return;
    const [label, ...roleCells] = cells;
    if (norm(row.label) !== label) errors.push(`${name} ${row.id}: label "${row.label}" ≠ spec "${label}"`);
    ROLES.forEach((role, j) => {
      const y = norm(row.cells?.[role] ?? '');
      if (y !== roleCells[j]) errors.push(`${name} ${row.id}.${role}: "${y}" ≠ spec "${roleCells[j]}"`);
      const g = row.grants?.[role];
      if (roleCells[j] === '—' && g) errors.push(`${name} ${row.id}.${role}: cell is "—" but a grant exists`);
      if (roleCells[j] !== '—' && !g) errors.push(`${name} ${row.id}.${role}: cell "${roleCells[j]}" has no grant`);
      if (g) {
        if (roleCells[j].startsWith('R') && g.mode !== 'read') errors.push(`${name} ${row.id}.${role}: R cell must be mode read`);
        if (roleCells[j].startsWith('T') && g.mode !== 'request') errors.push(`${name} ${row.id}.${role}: T cell must be mode request`);
        if (roleCells[j].startsWith('✓') && g.mode !== 'approve') errors.push(`${name} ${row.id}.${role}: ✓ cell must be mode approve`);
        if (/politika/.test(roleCells[j]) && !g.policy) errors.push(`${name} ${row.id}.${role}: policy-bound cell has no policy`);
        if (g.policy && !(g.policy in matrix.policies)) errors.push(`${name} ${row.id}.${role}: unknown policy ${g.policy}`);
        for (const c of g.constraints ?? []) if (!(c in matrix.constraints)) errors.push(`${name} ${row.id}.${role}: unknown constraint ${c}`);
      }
    });
  });
}

compare('matrix_a', tableAfter('#### 10.4.3 Matris A'), matrix.matrix_a);
compare('matrix_ai', tableAfter('### 11.4 Yetki ve gizlilik matrisi (AI)'), matrix.matrix_ai);

for (const p of matrix.protected_permissions) {
  const held = matrix.matrix_a.some((r) => r.permissions.includes(p) && r.grants.admin?.mode === 'full');
  if (!held) errors.push(`protected permission ${p} is not granted to admin`);
}

const users = matrix.users;
const specUsers = tableAfter('#### 10.4.4 Matris B');
if (specUsers.length !== Object.keys(users).length) errors.push(`matrix_b: spec ${specUsers.length} users, yaml ${Object.keys(users).length}`);
for (const [name, , b2b, b2c] of specUsers) {
  const u = Object.values(users).find((x) => x.name === name);
  if (!u) { errors.push(`matrix_b: user ${name} missing`); continue; }
  if ((b2b === '●') !== u.b2b) errors.push(`matrix_b ${name}: b2b mismatch`);
  if ((b2c === '●') !== u.b2c) errors.push(`matrix_b ${name}: b2c mismatch`);
}

const scenarioCounts = { base: tableAfter('**Örnek karar senaryoları (testlere dönüştürülecek):**').length };
const aiStart = spec.indexOf('### 11.4');
const aiScenarioRows = (() => {
  const idx = spec.indexOf('**Örnek karar senaryoları (testlere dönüştürülecek):**', aiStart);
  const sub = spec.slice(idx).split('\n').slice(1);
  let n = 0, inT = false;
  for (const l of sub) { if (l.startsWith('|')) { inT = true; n++; } else if (inT) break; }
  return n - 2;
})();
const yBase = matrix.scenarios.filter((s) => /^SCN-\d+$/.test(s.id)).length;
const yAi = matrix.scenarios.filter((s) => s.id.startsWith('SCN-AI-')).length;
if (yBase !== scenarioCounts.base) errors.push(`scenarios: spec §10.4.4 has ${scenarioCounts.base}, yaml ${yBase}`);
if (yAi !== aiScenarioRows) errors.push(`scenarios: spec §11.4 has ${aiScenarioRows}, yaml ${yAi}`);

console.log(errors.length ? `FAIL (${errors.length})\n${errors.join('\n')}` : `PASS matrix_a=${matrix.matrix_a.length} matrix_ai=${matrix.matrix_ai.length} users=${Object.keys(users).length} scenarios=${yBase}+${yAi}`);
process.exit(errors.length ? 1 : 0);
