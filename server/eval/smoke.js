// Smoke-tests every registered handler against a fresh seed:
//  1. example input succeeds  2. output matches the declared output schema
//  3. writes change stored state, reads don't  4. empty input / unknown id are rejected (no silent success)
// Usage: node eval/smoke.js [moduleId]
import { actions, reset, execute, getDb, validateCatalog } from '../src/catalog/registry.js';
import { makeCtx } from '../src/store/db.js';

const only = process.argv[2];
const state = () => JSON.stringify({ ...getDb().tables, activity: undefined });
const rows = [];
let pass = 0;

for (const a of actions.values()) {
  if (only && a.module.id !== only) continue;
  const problems = [];
  reset();
  let input;
  try {
    input = a.example ? a.example(makeCtx(getDb())) : null;
  } catch (e) {
    problems.push(`example() threw: ${e.message}`);
  }
  if (!a.example) problems.push('missing example');
  if (input) {
    const before = state();
    const r = execute(a.fullId, input);
    if (!r.ok) problems.push(`example failed: ${r.error.code} ${r.error.message}`);
    else {
      const out = a.output.safeParse(r.data);
      if (!out.success) problems.push(`output schema mismatch: ${out.error.issues.slice(0, 2).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      const changed = state() !== before;
      if (a.risk === 'read' && changed) problems.push('read action mutated state');
      if (a.risk !== 'read' && !changed) problems.push('write action did not change state');
    }
    // Negative path: a bogus id must not succeed.
    const idKey = Object.keys(input).find((k) => k === 'id');
    if (idKey) {
      reset();
      const bad = execute(a.fullId, { ...input, id: 'zzz_999' });
      if (bad.ok) problems.push('accepted unknown id');
    }
  }
  const req = a.inputJson.required || [];
  if (req.length) {
    const empty = execute(a.fullId, {});
    if (empty.ok || empty.error.code !== 'VALIDATION') problems.push('empty input not rejected with VALIDATION');
  }
  if (problems.length) rows.push(`✗ ${a.fullId}: ${problems.join(' | ')}`);
  else pass++;
}

const total = pass + rows.length;
rows.forEach((r) => console.log(r));
const cat = validateCatalog();
console.log(`\nSmoke: ${pass}/${total} handlers passed` + (only ? ` (module ${only})` : ''));
if (!only && cat.length) console.log('Catalog problems:\n  ' + cat.join('\n  '));
process.exitCode = rows.length || (!only && cat.length) ? 1 : 0;
