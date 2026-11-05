// Validates the eval set WITHOUT an LLM:
//  - every expected/forbidden action id exists
//  - running the scenario's reference solution (oracle) makes all assertions pass
//  - on the untouched seed, the state assertion FAILS (so it actually measures something)
// Usage: node eval/oracle.js [filter]
import { actions, reset, execute, validateCatalog } from '../src/catalog/registry.js';
import { loadScenarios, seedIds, stateHelpers, checkScenario } from './lib.js';

const scenarios = await loadScenarios(process.argv[2]);
const modulesCovered = new Set();
const cats = {};
let bad = 0;

for (const s of scenarios) {
  const errs = [];
  for (const a of [...(s.expect?.actions || []).flat(), ...(s.expect?.forbid || []), ...(s.expect?.allow || []), ...Object.keys(s.expect?.params || {})])
    if (!actions.has(a)) errs.push(`unknown action ${a}`);
  (s.modules || []).forEach((m) => modulesCovered.add(m));
  cats[s.category] = (cats[s.category] || 0) + 1;
  if (!s.turns?.length) errs.push('no turns');

  // 1) assertions must fail on the untouched seed (unless the scenario expects no change)
  reset();
  let seed = seedIds();
  if (s.expect?.state && !s.expect.noWrites && !s.expect.clarify && !s.invariant) {
    const r = checkScenario({ expect: { state: s.expect.state } }, { calls: [], h: stateHelpers(seed) });
    if (r.pass) errs.push('state assertion already passes on fresh seed (tautological)');
  }
  // 2) oracle solution must satisfy every assertion
  reset();
  seed = seedIds();
  const calls = [];
  const call = (action, input) => {
    const r = execute(action, input);
    calls.push({ action, input, ok: r.ok });
    if (!r.ok && !s.oracleAllowsFailure) throw new Error(`oracle call ${action} failed: ${r.error.code} ${r.error.message}`);
    return r.data;
  };
  if (s.oracle) {
    try {
      await s.oracle(call, stateHelpers(seed));
    } catch (e) {
      errs.push(e.message);
    }
  }
  const r = checkScenario(s, { calls, finalText: s.oracleReply || (s.expect?.clarify ? 'Which one do you mean?' : ''), confirmRequested: !!s.expect?.confirmRequested, h: stateHelpers(seed) });
  for (const c of r.checks) if (!c.pass) errs.push(`oracle fails check '${c.name}' ${c.detail}`);
  if (errs.length) {
    bad++;
    console.log(`✗ ${s.id} (${s.file})\n    ${errs.join('\n    ')}`);
  }
}

const allModules = new Set([...actions.values()].map((a) => a.module.id));
const missing = [...allModules].filter((m) => !modulesCovered.has(m));
console.log(`\nOracle: ${scenarios.length - bad}/${scenarios.length} scenarios valid`);
console.log('By category:', JSON.stringify(cats));
console.log(`Modules covered: ${modulesCovered.size}/${allModules.size}` + (missing.length ? ` — missing: ${missing.join(', ')}` : ''));
const cat = validateCatalog();
if (cat.length) console.log('Catalog problems: ' + cat.join('; '));
process.exitCode = bad ? 1 : 0;
