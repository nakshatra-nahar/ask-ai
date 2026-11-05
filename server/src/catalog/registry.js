// Action registry: auto-loads every file in ./modules, validates the catalog, and executes actions.
// Adding a capability = adding/editing a module file. The agent core never changes.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z, ActionError, listOf, RISKS } from './kit.js';
import { reset as resetStore, makeCtx, registerTable } from '../store/db.js';
import * as store from '../store/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(path.join(here, 'modules')).filter((f) => /^m\d\d-.*\.js$/.test(f)).sort();
export const modules = [];
for (const f of files) modules.push((await import(`./modules/${f}`)).default);

// Dependency-aware seed order: shared records first, everything else in catalog order.
const SEED_FIRST = ['users', 'teams', 'contacts', 'companies', 'campaigns', 'leads', 'pipelines', 'opportunities', 'calendars', 'availability', 'appointments', 'conversations', 'templates', 'sms', 'email', 'products', 'prices', 'tax_rules', 'invoices', 'payments'];
const seedOrder = [...modules].sort((a, b) => rank(a) - rank(b));
function rank(m) {
  const i = SEED_FIRST.indexOf(m.id);
  return i < 0 ? 100 + modules.indexOf(m) : i;
}

export const actions = new Map(); // fullId -> action
const tableSchemas = {};
for (const m of modules) {
  for (const [t, def] of Object.entries(m.tables || {})) {
    registerTable(t, def.prefix);
    tableSchemas[t] = def.schema;
  }
}
for (const m of modules) {
  for (const a of m.actions) {
    const fullId = `${m.id}.${a.id}`;
    if (actions.has(fullId)) throw new Error(`duplicate action ${fullId}`);
    if (!RISKS.includes(a.risk)) throw new Error(`${fullId}: bad risk '${a.risk}'`);
    if (!a.input || !a.handler || !a.description) throw new Error(`${fullId}: missing input/handler/description`);
    const tableSchema = a.table && tableSchemas[a.table];
    const output = a.output || (tableSchema ? (a.kind === 'search' ? listOf(tableSchema) : tableSchema) : null);
    if (!output) throw new Error(`${fullId}: no output schema`);
    const inputJson = z.toJSONSchema(a.input, { io: 'input', unrepresentable: 'any' });
    delete inputJson.$schema;
    actions.set(fullId, { ...a, fullId, module: m, output, inputJson, card: card(fullId, a, m, inputJson) });
  }
}

/** Compact one-line signature the model sees (≈40-80 tokens instead of a full JSON schema). */
function card(fullId, a, m, js) {
  const req = new Set(js.required || []);
  const params = Object.entries(js.properties || {}).map(([k, p]) => `${k}${req.has(k) ? '' : '?'}: ${typeStr(p)}`);
  return `${fullId}(${params.join(', ')}) [${a.risk}] — ${m.name}: ${a.name}. ${a.description}`;
}
function typeStr(p) {
  if (p.enum) return p.enum.map((v) => JSON.stringify(v)).join('|');
  if (p.anyOf) return p.anyOf.map(typeStr).join('|');
  if (p.type === 'array') return `${p.items ? typeStr(p.items) : 'any'}[]`;
  if (p.type === 'object' && p.properties)
    return `{${Object.entries(p.properties).map(([k, v]) => `${k}${(p.required || []).includes(k) ? '' : '?'}: ${typeStr(v)}`).join(', ')}}`;
  return p.type || 'any';
}

export function validateCatalog() {
  const problems = [];
  if (modules.length !== 50) problems.push(`expected 50 modules, found ${modules.length}`);
  for (const m of modules) if (m.actions.length !== 10) problems.push(`${m.id}: ${m.actions.length} actions (need 10)`);
  return problems;
}

export const reset = (seed) => resetStore(seedOrder, seed);
export const getDb = () => store.db;

/** Validate input, run handler, return {ok,data}|{ok:false,error}. Never throws for business errors. */
export function execute(fullId, rawInput, { actorId } = {}) {
  const a = actions.get(fullId);
  if (!a) return { ok: false, error: { code: 'UNKNOWN_ACTION', message: `No action '${fullId}'. Use search_actions to find valid action ids.` } };
  const parsed = a.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: 'VALIDATION', message: parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ') },
    };
  }
  const ctx = makeCtx(store.db, { actorId });
  // Writes are atomic: a handler that fails half-way must not leave the store partially updated.
  // shortcut: snapshots the whole in-memory store (~1k rows, ~1 ms); with a real DB this becomes a transaction.
  const before = a.risk === 'read' ? null : structuredClone({ tables: store.db.tables, seq: store.db.seq });
  try {
    const data = structuredClone(a.handler(parsed.data, ctx));
    if (a.risk !== 'read') logActivity(ctx, a, parsed.data, data);
    return { ok: true, data };
  } catch (e) {
    if (before) Object.assign(store.db, before);
    if (e instanceof ActionError) return { ok: false, error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } };
    console.warn(`[handler bug] ${fullId}:`, e.stack?.split('\n').slice(0, 2).join(' '));
    return { ok: false, error: { code: 'HANDLER_ERROR', message: e.message } };
  }
}

const REF = /^[a-z]{2,4}_\d{3,}$/;
function logActivity(ctx, a, input, data) {
  const refs = new Set();
  const scan = (o, depth = 0) => {
    if (!o || depth > 2) return;
    for (const v of Object.values(o)) {
      if (typeof v === 'string' && REF.test(v)) refs.add(v);
      else if (Array.isArray(v)) v.forEach((x) => (typeof x === 'string' && REF.test(x) ? refs.add(x) : depth < 1 && scan(x, depth + 1)));
    }
  };
  scan(input);
  if (data && typeof data === 'object') {
    if (typeof data.id === 'string') refs.add(data.id);
    for (const k of ['contactId', 'companyId', 'leadId', 'opportunityId', 'invoiceId', 'userId'])
      if (typeof data[k] === 'string') refs.add(data[k]);
  }
  (ctx.db.tables.activity ||= []).push({
    id: ctx.newId('act'), at: ctx.now, actorId: ctx.actorId, action: a.fullId,
    summary: a.name, refs: [...refs],
  });
}

