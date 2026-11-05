// Property test for every search/list action's filters (catches filters that are declared but ignored or mis-wired):
//  boolean b:  total(b=true) + total(b=false) === total(no b)          (partition)
//  enum e:     every returned item has item[e] === value (when items expose that field)
//  field f:    filtering by a value seen in the unfiltered results returns ≥1 item, all carrying that value
// Usage: node eval/filters.test.js [moduleId]
import { actions, reset, execute, getDb } from '../src/catalog/registry.js';
import { makeCtx } from '../src/store/db.js';

const only = process.argv[2];
const problems = [];
const warnings = [];
let checked = 0;
const total = (r) => (r.ok && typeof r.data?.total === 'number' ? r.data.total : null);
// Flags that widen rather than filter are not partitions.
const WIDENING = /^(include|show|with|force|all)/i;

for (const a of actions.values()) {
  if (a.risk !== 'read' || !/^(search|list)_/.test(a.id) || (only && a.module.id !== only)) continue;
  reset();
  const ex = a.example ? a.example(makeCtx(getDb())) : {};
  const req = new Set(a.inputJson.required || []);
  const baseInput = Object.fromEntries(Object.entries(ex).filter(([k]) => req.has(k)));
  const props = a.inputJson.properties || {};
  if (props.limit) baseInput.limit = 100;
  const base = execute(a.fullId, baseInput);
  const baseTotal = total(base);
  if (baseTotal == null) continue;
  const items = base.data.items || [];

  for (const [k, p] of Object.entries(props)) {
    if (req.has(k) || k === 'limit' || k === 'query') continue;
    const types = [].concat(p.type || (p.anyOf || []).map((x) => x.type));
    if (types.includes('boolean')) {
      checked++;
      const t = total(execute(a.fullId, { ...baseInput, [k]: true }));
      const f = total(execute(a.fullId, { ...baseInput, [k]: false }));
      if (t == null || f == null) problems.push(`${a.fullId} ${k}: boolean filter call failed`);
      else if (t + f !== baseTotal) (WIDENING.test(k) ? warnings : problems).push(`${a.fullId} ${k}: true(${t}) + false(${f}) != unfiltered(${baseTotal})`);
    } else if (p.enum || p.anyOf?.some((x) => x.enum)) {
      const values = p.enum || p.anyOf.find((x) => x.enum).enum;
      for (const v of values) {
        checked++;
        const r = execute(a.fullId, { ...baseInput, [k]: v });
        if (!r.ok) problems.push(`${a.fullId} ${k}=${v}: ${r.error.code} ${r.error.message}`);
        else {
          const bad = r.data.items.filter((it) => k in it && !(Array.isArray(it[k]) ? it[k].includes(v) : it[k] === v));
          if (bad.length) problems.push(`${a.fullId} ${k}=${v}: returned ${bad.length} item(s) with other values (e.g. ${bad[0][k]})`);
        }
      }
    } else if (types.includes('string') && !/(After|Before)$/.test(k)) {
      const sample = items.find((it) => typeof it[k] === 'string' && it[k]);
      if (!sample) continue;
      checked++;
      const r = execute(a.fullId, { ...baseInput, [k]: sample[k] });
      if (!r.ok) problems.push(`${a.fullId} ${k}: ${r.error.code} ${r.error.message}`);
      else if (!r.data.total) problems.push(`${a.fullId} ${k}='${sample[k]}': no results although an unfiltered item has it`);
      else if (r.data.items.some((it) => k in it && it[k] !== sample[k] && typeof it[k] === 'string' && it[k].toLowerCase() !== sample[k].toLowerCase()))
        problems.push(`${a.fullId} ${k}='${sample[k]}': returned items with a different ${k}`);
    }
  }
}
warnings.forEach((w) => console.log('  (warn) ' + w));
problems.forEach((p) => console.log('✗ ' + p));
console.log(`\nFilter properties: ${checked - problems.length}/${checked} checks passed` + (warnings.length ? `, ${warnings.length} widening-flag warnings` : ''));
process.exitCode = problems.length ? 1 : 0;
