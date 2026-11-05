// In-memory stateful store. Tables are plain arrays keyed by name; reset() rebuilds from a deterministic seed.
import { NOW } from '../config.js';
import { fail } from '../catalog/kit.js';

const prefixes = {}; // table -> id prefix, filled by the registry from module table declarations
export const registerTable = (table, prefix) => (prefixes[table] = prefix);

export let db = null;

export function makeCtx(store, { actorId = 'usr_001' } = {}) {
  const now = NOW.toISOString();
  const ctx = {
    db: store,
    now,
    today: now.slice(0, 10),
    actorId,
    all: (t) => store.tables[t] || [], // reads never create tables
    find: (t, rid) => ctx.all(t).find((r) => r.id === rid),
    get(t, rid, what) {
      const r = ctx.find(t, rid);
      if (!r) fail('NOT_FOUND', `${what || t} '${rid}' not found`);
      return r;
    },
    newId(prefix) {
      const n = (store.seq[prefix] = (store.seq[prefix] || 0) + 1);
      return `${prefix}_${String(n).padStart(3, '0')}`;
    },
    insert(t, rec) {
      const r = { id: ctx.newId(prefixes[t] || t.slice(0, 3)), ...rec };
      r.createdAt ||= now;
      r.updatedAt ||= r.createdAt;
      (store.tables[t] ||= []).push(r);
      return r;
    },
    patch(rec, changes) {
      Object.assign(rec, changes, { updatedAt: now });
      return rec;
    },
    remove(t, rid) {
      const rows = ctx.all(t);
      const i = rows.findIndex((r) => r.id === rid);
      if (i < 0) fail('NOT_FOUND', `${t} '${rid}' not found`);
      return rows.splice(i, 1)[0];
    },
    // Resolve a polymorphic reference like { recordType: 'contacts', recordId: 'con_001' }.
    ref(recordType, recordId) {
      if (!store.tables[recordType]) fail('VALIDATION', `unknown recordType '${recordType}'`);
      return ctx.get(recordType, recordId);
    },
  };
  return ctx;
}

// ---------- deterministic seed helpers ----------
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function seedHelpers(seed = 42) {
  const rnd = mulberry32(seed);
  const h = {
    rnd,
    int: (a, b) => a + Math.floor(rnd() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(rnd() * arr.length)],
    chance: (p) => rnd() < p,
    sample: (arr, k) => [...arr].sort(() => rnd() - 0.5).slice(0, k),
    daysAgo: (d, hour = 9 + Math.floor(rnd() * 8)) => {
      const t = new Date(NOW.getTime() - d * 864e5);
      t.setUTCHours(hour, Math.floor(rnd() * 60), 0, 0);
      return t.toISOString();
    },
    daysFromNow: (d, hour = 9 + Math.floor(rnd() * 8)) => h.daysAgo(-d, hour),
    dateOnly: (iso) => iso.slice(0, 10),
    firstNames: ['Sarah', 'James', 'Priya', 'Michael', 'Elena', 'David', 'Aisha', 'Tom', 'Grace', 'Carlos', 'Mei', 'Liam', 'Fatima', 'Noah', 'Olivia', 'Ravi', 'Hannah', 'Lucas', 'Zoe', 'Ethan', 'Nina', 'Omar', 'Chloe', 'Ben', 'Isabel', 'Kenji', 'Amara', 'Jack', 'Sofia', 'Daniel'],
    lastNames: ['Johnson', 'Patel', 'Garcia', 'Chen', 'Williams', 'Okafor', 'Müller', 'Smith', 'Brown', 'Kim', 'Rossi', 'Nguyen', 'Martin', 'Silva', 'Clark', 'Lopez', 'Singh', 'Walker', 'Haddad', 'Lee'],
    companyNames: ['Acme Dental', 'BrightPath Realty', 'Summit Fitness', 'Bluewave Marketing', 'Greenleaf Landscaping', 'Northstar Legal', 'Pixel & Co', 'Harbor Auto Repair', 'Evergreen Clinic', 'Urban Roast Cafe', 'Atlas Roofing', 'Nimbus Software', 'Crescent Spa', 'Redwood Insurance', 'Lumen Photography', 'Vertex Consulting', 'Maple Street Bakery', 'Orbit Logistics', 'Sage Wellness', 'Ironclad Security'],
  };
  return h;
}

/** Rebuild the whole store from seed. `modules` are seeded in the given order. */
export function reset(modules, seed = 42) {
  db = { tables: {}, seq: {} };
  const ctx = makeCtx(db);
  const h = seedHelpers(seed);
  for (const m of modules) m.seed?.(ctx, h);
  return db;
}

export const snapshot = () => JSON.stringify(db.tables);
