// Shared eval helpers: scenario loading, state helpers, assertion checking, stats.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actions, getDb } from '../src/catalog/registry.js';
import { NOW } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function loadScenarios(filter) {
  const dir = path.join(here, 'scenarios');
  const all = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    for (const s of (await import(path.join(dir, f))).default) all.push({ ...s, file: f });
  }
  const ids = new Set();
  for (const s of all) {
    if (ids.has(s.id)) throw new Error(`duplicate scenario id ${s.id}`);
    ids.add(s.id);
  }
  return filter ? all.filter((s) => s.id.includes(filter) || s.file.includes(filter) || s.category === filter || s.modules?.includes(filter)) : all;
}

/** Ids present right after seeding, so assertions can ask "what did this scenario create?". */
export const seedIds = () => Object.fromEntries(Object.entries(getDb().tables).map(([t, rows]) => [t, new Set(rows.map((r) => r.id))]));

export function stateHelpers(seed) {
  const all = (t) => getDb().tables[t] || [];
  return {
    all,
    get: (t, id) => all(t).find((r) => r.id === id),
    find: (t, pred) => all(t).find(pred),
    created: (t) => all(t).filter((r) => !seed[t]?.has(r.id)),
    changed: (t) => all(t).filter((r) => seed[t]?.has(r.id) && r.updatedAt === NOW.toISOString()),
    day: (n) => new Date(Date.parse(NOW.toISOString().slice(0, 10)) + n * 864e5).toISOString().slice(0, 10),
  };
}

const lc = (v) => (typeof v === 'string' ? v.toLowerCase().trim() : v);
/** Expected params are a subset match; strings compare case-insensitively; dates compare on YYYY-MM-DD prefix. */
export function paramsMatch(actual, expected) {
  for (const [k, ev] of Object.entries(expected)) {
    const av = actual?.[k];
    if (ev instanceof RegExp) {
      if (!ev.test(String(av ?? ''))) return false;
    } else if (Array.isArray(ev)) {
      if (!Array.isArray(av) || ev.some((x) => !av.map(lc).includes(lc(x)))) return false;
    } else if (ev && typeof ev === 'object') {
      if (!paramsMatch(av, ev)) return false;
    } else if (typeof ev === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ev)) {
      if (typeof av !== 'string' || av.slice(0, 10) !== ev) return false;
    } else if (lc(av) !== lc(ev)) return false;
  }
  return true;
}

/**
 * Check a scenario run. `calls` = [{action, input, ok}], `finalText`, `confirmRequested`, `h` = stateHelpers.
 * Returns { pass, checks: [{name, pass, detail}], selection: {expected, hit, forbiddenHit, unexpectedWrites}, params: {total, hit} }
 */
export function checkScenario(s, { calls, finalText = '', confirmRequested = false, h }) {
  const e = s.expect || {};
  const okCalls = calls.filter((c) => c.ok);
  const okIds = new Set(okCalls.map((c) => c.action));
  const checks = [];
  const add = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

  const expected = e.actions || [];
  const hit = expected.filter((a) => okIds.has(a) || (Array.isArray(a) && a.some((x) => okIds.has(x))));
  for (const a of expected) add(`action ${[].concat(a).join('|')}`, [].concat(a).some((x) => okIds.has(x)));
  const forbiddenHit = (e.forbid || []).filter((a) => okIds.has(a));
  for (const a of e.forbid || []) add(`forbid ${a}`, !okIds.has(a));
  const allowed = new Set([...expected.flat(), ...(e.allow || [])]);
  const isWrite = (id) => actions.get(id)?.risk !== 'read';
  const unexpectedWrites = [...okIds].filter((a) => isWrite(a) && !allowed.has(a));
  if (e.strictWrites !== false && expected.length) add('no unexpected writes', !unexpectedWrites.length, unexpectedWrites.join(', '));

  let pTotal = 0, pHit = 0;
  for (const [a, exp] of Object.entries(e.params || {})) {
    for (const one of [].concat(exp)) {
      pTotal++;
      const ok = okCalls.some((c) => c.action === a && paramsMatch(c.input, one));
      if (ok) pHit++;
      add(`params ${a}`, ok, JSON.stringify(one, (k, v) => (v instanceof RegExp ? String(v) : v)));
    }
  }
  if (e.noWrites) add('no writes', !okCalls.some((c) => isWrite(c.action)), okCalls.filter((c) => isWrite(c.action)).map((c) => c.action).join(', '));
  if (e.clarify) add('asks clarification', /\?/.test(finalText) && !okCalls.some((c) => isWrite(c.action)));
  if (e.confirmRequested) add('confirmation requested', confirmRequested);
  if (e.reply) add(`reply ${e.reply}`, e.reply.test(finalText));
  if (e.state) {
    let r;
    try {
      r = e.state(h);
    } catch (err) {
      r = `state check threw: ${err.message}`;
    }
    add('final state', r === true, r === true ? '' : String(r || 'false'));
  }
  return {
    pass: checks.every((c) => c.pass),
    checks,
    selection: { expected: expected.length, hit: hit.length, forbiddenHit: forbiddenHit.length, unexpectedWrites: unexpectedWrites.length },
    params: { total: pTotal, hit: pHit },
  };
}

export function pct(xs, p) {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
}
