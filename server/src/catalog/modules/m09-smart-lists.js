import { defineModule, ops, z, id, entity, fail, page, toTime } from '../kit.js';

const TABLES = ['contacts', 'leads'];
const OPS = ['eq', 'neq', 'contains', 'gt', 'lt', 'before', 'after', 'in', 'exists'];
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const rule = z.object({
  field: z.string().min(1).describe('record field; dot paths allowed, e.g. tags, source, preferences.sms, customFields.birthday'),
  op: z.enum(OPS),
  value: z.union([scalar, z.array(scalar)]).optional()
    .describe('before/after: ISO date or days relative to today (-7 = 7 days ago); in: array; exists: true/false; gt/lt: number'),
});
const rules = z.array(rule).min(1).describe('all rules must match (AND)');
const smartList = entity({ name: z.string(), targetTable: z.enum(TABLES), rules: z.array(z.looseObject({ field: z.string(), op: z.string() })) });
const DEFAULT_FIELDS = {
  contacts: ['id', 'name', 'email', 'phone', 'tags', 'lifecycleStage'],
  leads: ['id', 'name', 'email', 'phone', 'source', 'status', 'score', 'ownerId'],
};

const norm = (x) => (typeof x === 'string' ? x.toLowerCase() : x);
const get = (rec, path) => path.split('.').reduce((o, k) => o?.[k], rec);
const when = (ctx, v) => (typeof v === 'number' ? Date.parse(ctx.now) + v * 864e5 : toTime(v));
function test(ctx, rec, { field, op, value }) {
  const v = get(rec, field);
  const vals = Array.isArray(v) ? v.map(norm) : [norm(v)];
  switch (op) {
    case 'eq': return vals.includes(norm(value));
    case 'neq': return !vals.includes(norm(value));
    case 'contains': return Array.isArray(v) ? vals.includes(norm(value)) : String(v ?? '').toLowerCase().includes(String(value).toLowerCase());
    case 'gt': return typeof v === 'number' && v > value;
    case 'lt': return typeof v === 'number' && v < value;
    case 'before': return v != null && toTime(v) < when(ctx, value);
    case 'after': return v != null && toTime(v) > when(ctx, value);
    case 'in': return value.map(norm).some((x) => vals.includes(x));
    case 'exists': {
      const present = v != null && v !== '' && !(Array.isArray(v) && !v.length);
      return value === false ? !present : present;
    }
  }
}
const knownFields = (ctx, table) => new Set(['customFields', ...ctx.all(table).flatMap((r) => Object.keys(r))]);
function validateRules(ctx, table, list) {
  const known = knownFields(ctx, table);
  for (const r of list) {
    const bad = (msg) => fail('VALIDATION', `rule ${r.field} ${r.op}: ${msg}`);
    if (!known.has(r.field.split('.')[0])) bad(`unknown field on ${table}; known fields: ${[...known].join(', ')}`);
    if (r.op !== 'exists' && r.value === undefined) bad('a value is required');
    if (r.op === 'exists' && r.value !== undefined && typeof r.value !== 'boolean') bad('value must be true or false');
    if (r.op === 'in' && !Array.isArray(r.value)) bad('value must be an array');
    if (r.op !== 'in' && Array.isArray(r.value)) bad(`arrays are only allowed with op 'in'`);
    if (['gt', 'lt'].includes(r.op) && typeof r.value !== 'number') bad('value must be a number');
    if (['before', 'after'].includes(r.op) && typeof r.value !== 'number' && Number.isNaN(toTime(String(r.value)))) bad('value must be an ISO date or a day offset like -7');
  }
}
// Merged records are duplicates folded into another record, so they never count as audience members.
/** Records matching a smart list's rules (shared with campaigns' audience resolution). */
export const matching = (ctx, sl) => ctx.all(sl.targetTable).filter((r) => r.status !== 'merged' && (sl.rules || []).every((x) => test(ctx, r, x)));
const dupName = (ctx, name, selfId) => {
  const d = ctx.all('smart_lists').find((s) => s.id !== selfId && s.name.toLowerCase() === name.toLowerCase());
  if (d) fail('DUPLICATE', `a smart list named '${name}' already exists (${d.id})`);
};
const cell = (v) => {
  const s = Array.isArray(v) ? v.join(';') : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const smartListId = (ctx, name) => ctx.all('smart_lists').find((s) => s.name === name)?.id;

export default defineModule({
  id: 'smart_lists',
  code: 'M09',
  name: 'Smart Lists',
  description: 'Define dynamic audiences using saved filters.',
  tables: { smart_lists: { prefix: 'sl', schema: smartList } },
  actions: [
    {
      id: 'create_smart_list', name: 'Create smart list',
      description: 'Save a dynamic audience: a named set of filter rules over contacts or leads that is re-evaluated live every time it is used (not a static list).',
      keywords: ['saved filter', 'segment', 'audience', 'dynamic list'],
      ...ops.create('smart_lists', {
        input: z.object({ name: z.string().min(1), targetTable: z.enum(TABLES).default('contacts'), rules }),
        check: (i, ctx) => {
          dupName(ctx, i.name);
          validateRules(ctx, i.targetTable, i.rules);
        },
        build: (i, ctx) => ({ createdBy: ctx.actorId }),
      }),
      example: () => ({ name: 'Customers - SMS opted in', targetTable: 'contacts', rules: [{ field: 'lifecycleStage', op: 'eq', value: 'customer' }, { field: 'preferences.sms', op: 'eq', value: true }] }),
    },
    {
      id: 'get_smart_list', name: 'Get smart list definition', description: 'Fetch one smart list with its target table and filter rules.',
      ...ops.get('smart_lists', { what: 'smart list' }),
      example: (ctx) => ({ id: ctx.all('smart_lists')[0].id }),
    },
    {
      id: 'list_smart_lists', name: 'List smart lists', description: 'List saved smart lists (audiences), optionally by target table or name.',
      ...ops.search('smart_lists', { text: ['name'], filters: { targetTable: z.enum(TABLES).optional() } }),
      example: () => ({}),
    },
    {
      id: 'rename_smart_list', name: 'Rename smart list', description: 'Rename a smart list (names are unique).',
      ...ops.set('smart_lists', 'name', z.string().min(1), { what: 'smart list', guard: (s, i, ctx) => dupName(ctx, i.name, s.id) }),
      example: (ctx) => ({ id: ctx.all('smart_lists')[0].id, name: 'VIP Customers (all)' }),
    },
    {
      id: 'update_smart_list_rules', name: 'Update filter rules', description: 'Replace the full set of filter rules of a smart list (pass all rules, not just the changed one).',
      keywords: ['change filters', 'edit segment'],
      ...ops.set('smart_lists', 'rules', rules, { what: 'smart list', guard: (s, i, ctx) => validateRules(ctx, s.targetTable, i.rules) }),
      example: (ctx) => ({ id: ctx.all('smart_lists')[0].id, rules: [{ field: 'tags', op: 'contains', value: 'vip' }, { field: 'status', op: 'eq', value: 'active' }] }),
    },
    {
      id: 'preview_smart_list', name: 'Preview matching records', description: 'Evaluate a smart list now and return the first matching records (default 10).',
      keywords: ['who is in segment', 'sample audience'],
      risk: 'read',
      input: z.object({ id: id('smart list'), limit: z.number().int().min(1).max(100).default(10) }),
      output: z.looseObject({ total: z.number(), items: z.array(z.looseObject({ id: z.string() })) }),
      handler: ({ id: sid, limit: lim }, ctx) => {
        const sl = ctx.get('smart_lists', sid, 'smart list');
        return { smartListId: sl.id, targetTable: sl.targetTable, ...page(matching(ctx, sl), lim) };
      },
      example: (ctx) => ({ id: ctx.all('smart_lists')[0].id }),
    },
    {
      id: 'count_smart_list', name: 'Count matching records', description: 'Evaluate a smart list now and return how many records match (audience size).',
      keywords: ['audience size', 'segment size'],
      risk: 'read',
      input: z.object({ id: id('smart list') }),
      output: z.looseObject({ smartListId: z.string(), count: z.number() }),
      handler: ({ id: sid }, ctx) => {
        const sl = ctx.get('smart_lists', sid, 'smart list');
        return { smartListId: sl.id, name: sl.name, targetTable: sl.targetTable, count: matching(ctx, sl).length };
      },
      example: (ctx) => ({ id: ctx.all('smart_lists')[0].id }),
    },
    {
      id: 'export_smart_list', name: 'Export matching records', description: 'Evaluate a smart list and return the matching records as CSV text (chosen fields, or sensible defaults).',
      keywords: ['download csv', 'export audience'],
      risk: 'read',
      input: z.object({ id: id('smart list'), fields: z.array(z.string().min(1)).min(1).optional().describe('columns to export; dot paths allowed') }),
      output: z.looseObject({ count: z.number(), fields: z.array(z.string()), csv: z.string() }),
      handler: ({ id: sid, fields }, ctx) => {
        const sl = ctx.get('smart_lists', sid, 'smart list');
        const cols = fields || DEFAULT_FIELDS[sl.targetTable];
        const known = knownFields(ctx, sl.targetTable);
        const unknown = cols.filter((f) => !known.has(f.split('.')[0]));
        if (unknown.length) fail('VALIDATION', `unknown fields ${unknown.join(', ')}; known fields: ${[...known].join(', ')}`);
        const rows = matching(ctx, sl);
        const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(get(r, c))).join(','))].join('\n');
        return { smartListId: sl.id, count: rows.length, fields: cols, csv };
      },
      example: (ctx) => ({ id: ctx.all('smart_lists')[0].id }),
    },
    {
      id: 'duplicate_smart_list', name: 'Duplicate smart list', description: 'Copy a smart list (same table and rules) under a new name, e.g. to tweak filters without changing the original.',
      risk: 'write',
      input: z.object({ id: id('smart list'), name: z.string().min(1).optional().describe("defaults to '<name> (copy)'") }),
      output: smartList,
      handler: ({ id: sid, name }, ctx) => {
        const sl = ctx.get('smart_lists', sid, 'smart list');
        const newName = name || `${sl.name} (copy)`;
        dupName(ctx, newName);
        return ctx.insert('smart_lists', { name: newName, targetTable: sl.targetTable, rules: structuredClone(sl.rules), createdBy: ctx.actorId, duplicatedFrom: sl.id });
      },
      example: (ctx) => ({ id: ctx.all('smart_lists')[0].id }),
    },
    {
      id: 'delete_smart_list', name: 'Delete smart list',
      description: 'Permanently delete a smart list definition (records are untouched). Fails if an active or scheduled campaign uses it as its audience.',
      risk: 'destructive',
      input: z.object({ id: id('smart list') }),
      output: z.looseObject({ deleted: smartList }),
      handler: ({ id: sid }, ctx) => {
        const sl = ctx.get('smart_lists', sid, 'smart list');
        const users = ctx.all('campaigns').filter((c) => c.audience?.smartListId === sid && ['active', 'scheduled'].includes(c.status));
        if (users.length) fail('CONFLICT', `smart list is the audience of ${users.map((c) => `${c.id} ${c.name} (${c.status})`).join(', ')}; pause/complete those campaigns or change their audience first`);
        return { deleted: ctx.remove('smart_lists', sl.id) };
      },
      example: (ctx) => ({ id: smartListId(ctx, 'Stale Leads (30+ days)') }),
    },
  ],

  seed(ctx, h) {
    const lists = [
      ['VIP Customers', 'contacts', [{ field: 'tags', op: 'contains', value: 'vip' }]],
      ['Newsletter Subscribers', 'contacts', [{ field: 'tags', op: 'contains', value: 'newsletter' }, { field: 'preferences.email', op: 'eq', value: true }]],
      ['All Customers', 'contacts', [{ field: 'lifecycleStage', op: 'eq', value: 'customer' }, { field: 'status', op: 'eq', value: 'active' }]],
      ['Unassigned New Leads', 'leads', [{ field: 'status', op: 'eq', value: 'new' }, { field: 'ownerId', op: 'exists', value: false }]],
      ['Facebook Leads - Last 30 Days', 'leads', [{ field: 'source', op: 'eq', value: 'facebook' }, { field: 'createdAt', op: 'after', value: -30 }]],
      ['Hot Leads', 'leads', [{ field: 'score', op: 'gt', value: 70 }, { field: 'status', op: 'in', value: ['new', 'contacted', 'qualified'] }]],
      ['Stale Leads (30+ days)', 'leads', [{ field: 'status', op: 'in', value: ['new', 'contacted'] }, { field: 'createdAt', op: 'before', value: -30 }]],
    ];
    for (const [name, targetTable, r] of lists) ctx.insert('smart_lists', { name, targetTable, rules: r, createdBy: 'usr_008', createdAt: h.daysAgo(h.int(10, 120)) });
  },
});
