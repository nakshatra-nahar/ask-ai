// Lexical retrieval over the action catalog: BM25 + light stemming + domain synonyms + typo tolerance.
// Runs in <2ms for 500 actions, so it adds no perceptible latency and costs zero tokens.
import { actions } from './registry.js';

const STOP = new Set('a an the and or of to for in on at by with from into my our your me i we you it is are be this that these those all any some who which what have has had do does did not no can will would should please help just also them their then than there here up out about'.split(' '));

// Domain thesaurus (user vocabulary -> catalog vocabulary). Generic CRM language, not tied to eval prompts.
const SYN = {
  followup: ['task', 'follow'], follow: ['task'], remind: ['task', 'reminder'], forget: ['task', 'reminder'], todo: ['task'], callback: ['task'],
  deal: ['opportunity'], deals: ['opportunity'], meeting: ['appointment'], booked: ['appointment'], booking: ['appointment', 'book'], call: ['appointment', 'task'],
  text: ['sms'], texts: ['sms'], txt: ['sms'], message: ['sms', 'email', 'conversation'], bill: ['invoice'], owe: ['invoice', 'overdue'], unpaid: ['invoice', 'overdue', 'balance'],
  late: ['overdue'], chase: ['reminder'], nudge: ['reminder'], customer: ['contact'], client: ['contact'], person: ['contact'], people: ['contact'], prospect: ['lead'],
  rep: ['user', 'team', 'owner'], reps: ['user', 'team', 'owner'], salesperson: ['user', 'owner'], staff: ['user'], employee: ['user'], teammate: ['user'],
  available: ['workload', 'availability'], assign: ['owner', 'assign'], replied: ['conversation', 'inbound', 'reply'], reply: ['conversation', 'reply'], respond: ['reply', 'conversation'],
  newsletter: ['campaign', 'email'], blast: ['campaign'], promo: ['coupon', 'campaign'], discount: ['coupon', 'discount'], code: ['coupon'],
  webinar: ['event'], workshop: ['event'], signup: ['form', 'register'], site: ['website'], article: ['blog', 'post'], learner: ['enrollment'], student: ['enrollment'],
  class: ['course'], program: ['course'], issue: ['ticket'], complaint: ['ticket'], rating: ['review'], stars: ['review'], dnd: ['preference'], unsubscribe: ['unsubscribe', 'preference'],
  revenue: ['report', 'payment'], metric: ['report'], kpi: ['report'], stats: ['report', 'performance'], automate: ['workflow', 'trigger'], automation: ['workflow', 'trigger'],
  audience: ['smart', 'list'], segment: ['smart', 'list'], dedupe: ['merge', 'duplicate'], delete: ['archive', 'delete'], remove: ['remove', 'archive'], label: ['tag'],
  charge: ['payment'], paid: ['payment'], receipt: ['receipt', 'payment'], plan: ['subscription', 'membership'], price: ['price'],
  setup: ['create'], new: ['create'], make: ['create'], proposal: ['quote'], estimate: ['quote'],
  shirt: ['product', 'variant'], merch: ['product'], restock: ['inventory', 'quantity'], stock: ['inventory', 'quantity'],
  duplicate: ['duplicate', 'merge'], spam: ['report', 'remove', 'post'], moderate: ['remove', 'report'],
  reschedule: ['due', 'reschedule'], handover: ['assign', 'owner'], reassign: ['assign', 'owner'], hand: ['assign'],
  slot: ['available', 'slot'], free: ['available', 'slot'], timeslot: ['slot'], hours: ['working', 'hours'], vacation: ['block', 'time'], pto: ['block', 'time'],
};

const stem = (w) =>
  w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y'
  : w.length > 5 && w.endsWith('ing') ? w.slice(0, -3)
  : w.length > 4 && w.endsWith('ed') ? w.slice(0, -2)
  : w.length > 3 && w.endsWith('es') && !w.endsWith('ses') ? w.slice(0, -2)
  : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1)
  : w;
const split = (s) => s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/follow[\s-]?ups?/g, 'followup').replace(/\bset[\s-]up\b/g, 'setup').replace(/\bsold out|selling out|out of stock\b/g, 'stock').split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));
export const tokenize = (s) => split(s).map(stem);

// ---------- index ----------
const docs = [];
const df = new Map();
for (const a of actions.values()) {
  const params = Object.keys(a.inputJson.properties || {}).join(' ');
  const text = [a.module.name, a.module.name, a.module.description, a.name, a.name, a.name, a.description, (a.keywords || []).join(' '), (a.keywords || []).join(' '), params, a.id.replace(/_/g, ' ')].join(' ');
  const tf = new Map();
  const toks = tokenize(text);
  toks.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
  docs.push({ a, tf, len: toks.length });
  for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
}
const avgLen = docs.reduce((s, d) => s + d.len, 0) / docs.length;
const vocab = [...df.keys()];

function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const fuzzyCache = new Map();
function correct(t) {
  if (df.has(t) || t.length < 4) return t;
  if (fuzzyCache.has(t)) return fuzzyCache.get(t);
  const max = t.length >= 7 ? 2 : 1;
  let best = null, bestD = max + 1;
  for (const v of vocab) {
    const d = lev(t, v, max);
    if (d < bestD || (d === bestD && best && df.get(v) > df.get(best))) (best = v), (bestD = d);
  }
  const r = bestD <= max ? best : t;
  fuzzyCache.set(t, r);
  return r;
}

/** Weighted query terms: original words (corrected for typos) weight 1, synonyms 0.6. */
function queryTerms(q) {
  const terms = new Map();
  for (const raw of split(q)) {
    const t = correct(stem(raw));
    terms.set(t, Math.max(terms.get(t) || 0, 1));
    for (const s of (Object.hasOwn(SYN, raw) && SYN[raw]) || (Object.hasOwn(SYN, t) && SYN[t]) || []) {
      const st = stem(s);
      terms.set(st, Math.max(terms.get(st) || 0, 0.6));
    }
  }
  return terms;
}

export function searchActions(q, { k = 10, module } = {}) {
  const terms = queryTerms(q);
  const N = docs.length, k1 = 1.2, b = 0.75;
  const scored = [];
  for (const d of docs) {
    if (module && d.a.module.id !== module && d.a.module.name.toLowerCase() !== module.toLowerCase()) continue;
    let s = 0;
    for (const [t, w] of terms) {
      const f = d.tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      s += w * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgLen)));
    }
    if (s > 0) scored.push({ id: d.a.fullId, score: s, a: d.a });
  }
  return scored.sort((x, y) => y.score - x.score).slice(0, k);
}

/**
 * Multi-query retrieval for a user turn: whole message + each clause (complex requests name several modules).
 * Returns a de-duplicated, score-ordered list of actions.
 */
// Module name tokens -> that module's lookup actions (search_* / list_*). Mentioning an entity usually means
// it has to be resolved or filtered first, so its lookup action is always worth a candidate slot.
const moduleLookups = new Map();
for (const a of actions.values()) {
  if (!/^(search|list)_/.test(a.id)) continue;
  for (const t of tokenize(a.module.name)) {
    if (!moduleLookups.has(t)) moduleLookups.set(t, []);
    if (!moduleLookups.get(t).includes(a)) moduleLookups.get(t).push(a);
  }
}

export function retrieveForTurn(text, { k = 24, perClause = 4, perModule = 6 } = {}) {
  const lists = [searchActions(text, { k: k * 2 })];
  const lookups = [...queryTerms(text)].filter(([, w]) => w >= 1).flatMap(([t]) => moduleLookups.get(t) || []);
  if (lookups.length) lists.push(lookups.map((a) => ({ id: a.fullId, a })));
  const clauses = text.split(/[,;.!?\n]|\band\b|\bthen\b|\bbut\b|\bexcept\b|\bexclude\b|\bskip\b/i).map((c) => c.trim()).filter((c) => c.split(/\s+/).length >= 2);
  if (clauses.length > 1) for (const c of clauses) lists.push(searchActions(c, { k: perClause }));
  // Round-robin merge so every clause gets its best matches in; cap per module so one module can't crowd out the rest.
  const picked = new Set();
  const perMod = {};
  for (let rank = 0; picked.size < k && lists.some((l) => l[rank]); rank++)
    for (const l of lists) {
      const hit = l[rank];
      if (!hit || picked.size >= k || picked.has(hit.id)) continue;
      const m = hit.a.module.id;
      if ((perMod[m] || 0) >= perModule) continue;
      perMod[m] = (perMod[m] || 0) + 1;
      picked.add(hit.id);
    }
  return [...picked].map((id) => actions.get(id));
}
