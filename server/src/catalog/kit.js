// Module-authoring kit: every one of the 500 actions is declared with this.
// An action = { id, name, description, risk, input (zod), output (zod), handler(input, ctx), example(ctx), keywords? }.
// Factories below cover the common CRUD/state-machine shapes; anything else is a custom handler.
import { z } from 'zod';

export { z };

export class ActionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
export const fail = (code, message, details) => {
  throw new ActionError(code, message, details);
};

// Risk levels drive the confirmation gate in the agent executor.
// read: no state change. write: reversible internal change.
// destructive: delete/archive/void/cancel/merge/revoke. external: visible outside the account (send/publish/charge).
export const RISKS = ['read', 'write', 'destructive', 'external'];

// ---------- shared zod building blocks ----------
export const id = (what = 'record') => z.string().min(1).describe(`${what} ID`);
export const isoDate = (d = 'ISO date or datetime, e.g. 2026-11-05 or 2026-11-05T15:00:00Z') =>
  z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO date/datetime').describe(d);
export const limit = z.number().int().min(1).max(100).default(25).describe('max items to return');
export const money = z.number().nonnegative();
/** Round money to cents (EPSILON fixes 1.005 -> 1.01). */
export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const entity = (shape) => z.looseObject({ id: z.string(), ...shape });
export const listOf = (schema) =>
  z.looseObject({ total: z.number(), items: z.array(schema), truncated: z.boolean().optional() });

// ---------- date helpers ----------
export const toTime = (v, endOfDay = false) => {
  if (v == null) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return Date.parse(v + (endOfDay ? 'T23:59:59.999Z' : 'T00:00:00Z'));
  return Date.parse(v);
};
/** Parse a datetime; if it has no Z/offset and a timezone is given, read it as wall-clock time in that zone. */
export const toTimeIn = (v, tz) => {
  if (!tz || /(Z|[+-]\d\d:?\d\d)$/.test(v) || /^\d{4}-\d{2}-\d{2}$/.test(v)) return toTime(v);
  const asUtc = Date.parse(v + 'Z');
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const offsetAt = (ms) => {
    const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, x.value]));
    return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) - ms;
  };
  // Two passes: the offset must be the one in force at the real instant, not at the naive guess (DST edges).
  return asUtc - offsetAt(asUtc - offsetAt(asUtc));
};
export const addDays = (iso, n) => new Date(Date.parse(iso) + n * 864e5).toISOString();
export const daysBetween = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 864e5);

// ---------- generic filter semantics used by search() ----------
// key      -> equality (case-insensitive); if record value is an array -> includes
// keyAfter / keyBefore -> date range on record[key]
// keyMin / keyMax -> numeric range on record[key]
// keyIds (array input) -> record[key + 'Id'] in list
// key (array input) -> record[key] in list
export function matchFilters(rec, filters) {
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || (Array.isArray(v) && !v.length) || k === 'query' || k === 'limit' || k === 'offset') continue;
    if (k.endsWith('After')) {
      const f = k.slice(0, -5);
      if (!rec[f] || toTime(rec[f]) < toTime(v)) return false;
    } else if (k.endsWith('Before')) {
      const f = k.slice(0, -6);
      if (!rec[f] || toTime(rec[f]) > toTime(v, true)) return false;
    } else if (k.endsWith('Min') && typeof v === 'number') {
      if (!(rec[k.slice(0, -3)] >= v)) return false;
    } else if (k.endsWith('Max') && typeof v === 'number') {
      if (!(rec[k.slice(0, -3)] <= v)) return false;
    } else if (k.endsWith('Ids') && Array.isArray(v)) {
      if (!v.includes(rec[k.slice(0, -3) + 'Id'])) return false;
    } else if (Array.isArray(v)) {
      if (!v.map(norm).includes(norm(rec[k]))) return false;
    } else if (Array.isArray(rec[k])) {
      if (!rec[k].map(norm).includes(norm(v))) return false;
    } else if (typeof v === 'boolean') {
      if (Boolean(rec[k]) !== v) return false;
    } else if (norm(rec[k]) !== norm(v)) return false;
  }
  return true;
}
const norm = (x) => (typeof x === 'string' ? x.toLowerCase() : x);
export const textMatch = (rec, fields, q) => {
  if (!q) return true;
  const hay = fields.map((f) => rec[f] ?? '').join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
};
export const page = (items, lim = 25) => ({
  total: items.length,
  items: items.slice(0, lim),
  ...(items.length > lim ? { truncated: true } : {}),
});

// ---------- factories ----------
// Each returns a partial action spec; spread it into the action and add id/name/description/example.
export const ops = {
  /** Insert a record. `build(input, ctx)` returns extra/derived fields; `check(input, ctx)` may fail(). */
  create(table, { input, build, check, risk = 'write' }) {
    return { kind: "create", table,
      risk,
      input,
      handler: (inp, ctx) => {
        check?.(inp, ctx);
        return ctx.insert(table, { ...inp, ...(build ? build(inp, ctx) : {}) });
      },
    };
  },

  get(table, { what = table } = {}) {
    return { kind: "get", table,
      risk: 'read',
      input: z.object({ id: id(what) }),
      handler: ({ id: rid }, ctx) => ctx.get(table, rid),
    };
  },

  /**
   * filters: zod shape of optional filter fields (see matchFilters). text: fields searched by `query`.
   * virtual: filter keys that are not record fields (e.g. `overdue`) — handled only by `where`, never by matchFilters.
   */
  search(table, { filters = {}, text = [], where, sort, virtual = [] } = {}) {
    const shape = { ...filters, limit };
    if (text.length) shape.query = z.string().optional().describe(`free text over ${text.join(', ')}`);
    return { kind: "search", table,
      risk: 'read',
      input: z.object(shape),
      handler: (inp, ctx) => {
        const { query, limit: lim, ...f } = inp;
        for (const k of virtual) delete f[k];
        let rows = ctx.all(table).filter((r) => textMatch(r, text, query) && matchFilters(r, f) && (!where || where(r, inp, ctx)));
        if (sort) rows = [...rows].sort(sort);
        return page(rows, lim);
      },
    };
  },

  /** Patch selected fields. `fields` is a zod shape (all treated optional). `guard(rec)` may fail(). */
  update(table, { fields, guard, idName = 'id', what = table, after }) {
    const shape = { [idName]: id(what) };
    for (const [k, s] of Object.entries(fields)) shape[k] = s.optional();
    return { kind: "update", table,
      risk: 'write',
      input: z.object(shape).refine((o) => Object.keys(o).length > 1, 'provide at least one field to update'),
      handler: (inp, ctx) => {
        const { [idName]: rid, ...changes } = inp;
        const rec = ctx.get(table, rid);
        guard?.(rec, inp, ctx);
        ctx.patch(rec, changes);
        after?.(rec, inp, ctx);
        return rec;
      },
    };
  },

  /** Set a single field from a required input param. */
  set(table, field, schema, { param = field, guard, risk = 'write', what = table, map } = {}) {
    return { kind: "set", table,
      risk,
      input: z.object({ id: id(what), [param]: schema }),
      handler: (inp, ctx) => {
        const rec = ctx.get(table, inp.id);
        guard?.(rec, inp, ctx);
        ctx.patch(rec, { [field]: map ? map(inp[param], rec, ctx) : inp[param] });
        return rec;
      },
    };
  },

  /** State-machine transition: only allowed from `from` states (if given). */
  transition(table, { to, from, field = 'status', risk = 'write', extra, reason = false, what = table, guard }) {
    const shape = { id: id(what) };
    if (reason) shape.reason = z.string().min(1).describe('reason');
    return { kind: "transition", table,
      risk,
      input: z.object(shape),
      handler: (inp, ctx) => {
        const rec = ctx.get(table, inp.id);
        if (from && !from.includes(rec[field]))
          fail('INVALID_STATE', `${what} ${rec.id} is '${rec[field]}'; this action requires one of: ${from.join(', ')}`);
        guard?.(rec, inp, ctx);
        ctx.patch(rec, { [field]: to, ...(extra ? extra(rec, inp, ctx) : {}) });
        return rec;
      },
    };
  },

  /** Append an item to an array field on a record. */
  addItem(table, arrayField, itemShape, { prefix = 'itm', what = table, guard } = {}) {
    return { kind: "addItem", table,
      risk: 'write',
      input: z.object({ id: id(what), ...itemShape }),
      handler: ({ id: rid, ...item }, ctx) => {
        const rec = ctx.get(table, rid);
        guard?.(rec, item, ctx);
        const list = (rec[arrayField] ||= []);
        const added = { id: ctx.newId(prefix), ...item };
        list.push(added);
        ctx.patch(rec, {});
        return { ...rec, added };
      },
    };
  },

  /** Update an item inside an array field. */
  updateItem(table, arrayField, itemFields, { itemParam = 'itemId', what = table, guard } = {}) {
    const shape = { id: id(what), [itemParam]: id('item') };
    for (const [k, s] of Object.entries(itemFields)) shape[k] = s.optional();
    return { kind: "updateItem", table,
      risk: 'write',
      input: z.object(shape),
      handler: ({ id: rid, [itemParam]: iid, ...changes }, ctx) => {
        const rec = ctx.get(table, rid);
        guard?.(rec, changes, ctx);
        const item = (rec[arrayField] || []).find((x) => x.id === iid);
        if (!item) fail('NOT_FOUND', `${arrayField} item ${iid} not found on ${rid}`);
        Object.assign(item, changes);
        ctx.patch(rec, {});
        return rec;
      },
    };
  },

  removeItem(table, arrayField, { itemParam = 'itemId', what = table, risk = 'write', guard } = {}) {
    return { kind: "removeItem", table,
      risk,
      input: z.object({ id: id(what), [itemParam]: id('item') }),
      handler: ({ id: rid, [itemParam]: iid }, ctx) => {
        const rec = ctx.get(table, rid);
        const idx = (rec[arrayField] || []).findIndex((x) => x.id === iid);
        if (idx < 0) fail('NOT_FOUND', `${arrayField} item ${iid} not found on ${rid}`);
        guard?.(rec, rec[arrayField][idx], ctx);
        const [removed] = rec[arrayField].splice(idx, 1);
        ctx.patch(rec, {});
        return { ...rec, removed };
      },
    };
  },

  /** Reorder an array field by a full list of item ids. */
  reorder(table, arrayField, { param = 'orderedIds', what = table } = {}) {
    return { kind: "reorder", table,
      risk: 'write',
      input: z.object({ id: id(what), [param]: z.array(z.string()).min(1).describe('all item IDs in the new order') }),
      handler: ({ id: rid, [param]: order }, ctx) => {
        const rec = ctx.get(table, rid);
        const items = rec[arrayField] || [];
        const ids = items.map((x) => x.id);
        if (order.length !== ids.length || !ids.every((x) => order.includes(x)))
          fail("VALIDATION", `${param} must contain exactly these ids: ${ids.join(", ")}`);
        rec[arrayField] = order.map((x) => items.find((i) => i.id === x));
        ctx.patch(rec, {});
        return rec;
      },
    };
  },
};

/**
 * defineModule({ id, code, name, description, tables: { name: { prefix, schema } }, actions: [...], seed(ctx, h) })
 * Registration is just dropping a file in catalog/modules — the registry auto-loads every module.
 */
export function defineModule(mod) {
  if (!mod.id || !mod.name || !Array.isArray(mod.actions)) throw new Error('module needs id, name, actions');
  return mod;
}
