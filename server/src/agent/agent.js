// Ask AI agent: retrieval-augmented tool-use loop over the 500-action catalog.
//
// optimized: 2 static meta-tools (search_actions, execute_action) + per-turn top-K candidate action cards
//            -> tool list never changes, so system+tools stay prompt-cached; ~1-2k catalog tokens/turn instead of ~60k.
// baseline:  all 500 actions as native tools (~110k schema tokens, prompt-cached), no retrieval, default effort, raw results.
import Anthropic from '@anthropic-ai/sdk';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { MODEL, EFFORT, costUSD } from '../config.js';
import { actions, execute } from '../catalog/registry.js';
import { retrieveForTurn, searchActions } from '../catalog/search.js';
import { SYSTEM, SYSTEM_BASELINE } from './prompt.js';

export const STRATEGIES = {
  optimized: { name: 'optimized', tools: 'meta', retrieval: true, cache: true, effort: EFFORT, compact: true },
  // Baseline still caches: without it every call re-bills ~110k tool-schema tokens, which no real deployment would do.
  baseline: { name: 'baseline', tools: 'all', retrieval: false, cache: true, effort: 'medium', compact: false },
};
const MAX_ITERS = 14;
const BULK_WRITES = 10; // more writes than this in one user turn => confirm the rest as a bulk operation
const GATED = new Set(['destructive', 'external']);
const MAX_SESSIONS = 500;
const API_RETRIES = 3;
// Models that return narration between tool calls as progress-update thinking blocks (empty unless display: "updates").
const PROGRESS_UPDATES = /^claude-(opus-5-5|sonnet-5-5|fable-5|mythos-5)/.test(MODEL);
const UPDATES_BETA = 'thinking-display-updates-2026-08-18';

let client;
// SDK retries are off so every retry is counted (and its latency attributed) in the metrics.
const llm = () => (client ||= new Anthropic({ maxRetries: 0 }));
/** Test hook: inject a fake client exposing messages.stream(params). */
export const setClient = (c) => (client = c);

// ---------- tool definitions ----------
const META_TOOLS = [
  {
    name: 'search_actions',
    description: 'Search the platform action catalog (50 modules, 500 actions) when the provided candidate actions do not cover what you need. Returns action ids with parameter signatures.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'what you want to do, in plain words' },
        module: { type: 'string', description: 'optional module id or name to restrict the search, e.g. "appointments"' },
      },
      required: ['query'],
    },
  },
  {
    name: 'execute_action',
    description: 'Execute one platform action by id with its input object. Call several in one response to run independent actions in parallel.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'action id, e.g. "contacts.create_contact"' },
        input: { type: 'object', description: 'parameters matching the action signature' },
      },
      required: ['action', 'input'],
    },
  },
];
const toolName = (fullId) => fullId.replace('.', '__');
let ALL_TOOLS;
const allTools = () =>
  (ALL_TOOLS ||= [...actions.values()].map((a) => ({
    name: toolName(a.fullId),
    description: `[${a.risk}] ${a.module.name}: ${a.name}. ${a.description}`,
    input_schema: a.inputJson,
  })));
const withEager = (tools) => tools.map((t) => ({ ...t, eager_input_streaming: true }));

// ---------- sessions ----------
const sessions = new Map(); // insertion order = recency (re-inserted on use) -> cheap LRU
/** Existing session or undefined — never creates (use for confirm/metrics endpoints). */
export function findSession(id) {
  const s = id && sessions.get(id);
  if (s) sessions.delete(id), sessions.set(id, s);
  return s;
}
export function getSession(id, strategy = 'optimized') {
  const found = findSession(id);
  if (found) return found;
  const s = {
    id: id || randomUUID(), strategy: STRATEGIES[strategy] || STRATEGIES.optimized, messages: [], pending: null,
    memory: [], filters: [], turns: [], lastUserText: '', busy: false, turnWrites: 0, bulkApproved: false,
  };
  sessions.set(s.id, s);
  for (const [k, v] of sessions) {
    if (sessions.size <= MAX_SESSIONS) break;
    if (!v.busy) sessions.delete(k);
  }
  return s;
}
export const dropSession = (id) => sessions.delete(id);
export const clearSessions = () => sessions.clear();

// ---------- helpers ----------
/**
 * Drop nulls/empties/updatedAt; clip long strings only inside lists (search results). Single-record reads keep
 * full text, so a later update never writes back a truncated copy.
 */
function compact(v, inList = false) {
  if (Array.isArray(v)) return v.map((x) => compact(x, true));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === null || x === undefined || k === 'updatedAt' || (Array.isArray(x) && !x.length) || (typeof x === 'object' && !Array.isArray(x) && x && !Object.keys(x).length)) continue;
      o[k] = compact(x, inList);
    }
    return o;
  }
  return inList && typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…[truncated; get the record for full text]' : v;
}
const label = (r) => r?.name || r?.title || r?.number || r?.subject || r?.label || '';
/** Working set carried across turns: recently touched records + the filters of recent lookups. */
function remember(session, fullId, data, input, risk) {
  const add = (r) => r?.id && session.memory.unshift(`${r.id} (${fullId.split('.')[0]}${label(r) ? ': ' + label(r) : ''})`);
  if (data?.items) data.items.slice(0, 8).forEach(add);
  else add(data);
  session.memory = [...new Set(session.memory)].slice(0, 20);
  const f = Object.fromEntries(Object.entries(input || {}).filter(([k]) => k !== 'limit' && k !== 'id'));
  if (risk === 'read' && Object.keys(f).length)
    session.filters = [...new Set([`${fullId} ${JSON.stringify(f)} -> ${data?.total ?? 1} result(s)`, ...session.filters])].slice(0, 6);
}

function newMetrics(session, userText) {
  return {
    sessionId: session.id, turn: session.turns.length, strategy: session.strategy.name, model: MODEL, userText,
    t0: performance.now(), ttfurMs: null, ttftTextMs: null, firstActionMs: null, e2eMs: null,
    llmCalls: [], actions: [], usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    costUSD: 0, retries: 0, retrieved: [], status: 'running', finalText: '', progress: [],
  };
}
const since = (m) => Math.round(performance.now() - m.t0);
function markUseful(m, kind) {
  const t = since(m);
  if (kind === 'text' && m.ttftTextMs == null) m.ttftTextMs = t;
  if (kind === 'action' && m.firstActionMs == null) m.firstActionMs = t;
  if (m.ttfurMs == null) m.ttfurMs = t;
}

// ---------- public API ----------
/** Run one user turn. `emit(event)` receives progress events for the UI. Resolves with the turn metrics/trace. */
export async function runTurn(session, userText, emit = () => {}, opts = {}) {
  const m = newMetrics(session, userText);
  session.turns.push(m);
  maybeCompact(session); // no-op while a confirmation is pending, so tool_use ids are never orphaned

  // Build everything that can fail BEFORE touching session state, so a failure never leaves a half-updated transcript.
  let ctxText = null;
  if (session.strategy.retrieval) {
    // Short follow-ups ("make those due tomorrow") inherit the previous request's vocabulary.
    const q = userText.split(/\s+/).length < 12 && session.lastUserText ? `${userText} ${session.lastUserText}` : userText;
    const t = performance.now();
    let cands = [];
    try {
      cands = retrieveForTurn(q);
    } catch (e) {
      console.warn('retrieval failed, continuing with the catalog index only:', e.message);
    }
    m.retrieved = cands.map((a) => a.fullId);
    m.retrievalMs = +(performance.now() - t).toFixed(2);
    emit({ type: 'retrieval', candidates: m.retrieved, ms: m.retrievalMs });
    ctxText = `<candidate_actions>\n${cands.map((a) => a.card).join('\n')}\n</candidate_actions>`;
    if (session.memory.length) ctxText += `\n<recent_records>${session.memory.join('; ')}</recent_records>`;
    if (session.filters.length) ctxText += `\n<recent_lookups>${session.filters.join('; ')}</recent_lookups>`;
  }
  const content = [];
  if (session.pending) content.push(...declinePending(session, 'User sent a new message instead of confirming; not executed.'));
  session.turnWrites = 0;
  session.bulkApproved = false;
  session.turnIters = 0;
  if (ctxText) content.push({ type: 'text', text: ctxText });
  content.push({ type: 'text', text: userText });
  session.messages.push({ role: 'user', content });
  session.lastUserText = userText;
  return loop(session, m, emit, opts);
}

/**
 * Resolve a pending confirmation (approve or decline all gated calls) and continue the turn.
 * `token` must match the pending request, so a stale confirmation card can never approve a newer request.
 */
export async function confirm(session, approve, emit = () => {}, opts = {}, token = session.pending?.token) {
  if (!session.pending) throw new Error('nothing pending');
  if (token !== session.pending.token) throw new Error('confirmation is stale: a newer request is pending');
  const m = newMetrics(session, approve ? '[confirmed]' : '[declined]');
  m.resumed = true;
  session.turns.push(m);
  const { order, results, gated, bulk } = session.pending;
  session.pending = null;
  if (approve && bulk) session.bulkApproved = true;
  if (approve) session.turnWrites += gated.filter((g) => g.action.risk !== 'read').length;
  for (const g of gated) {
    if (approve) results.set(g.id, runAction(session, m, g, emit, true));
    else results.set(g.id, toolResult(g.id, { ok: false, error: { code: 'DECLINED', message: 'User declined this action; it was not executed.' } }));
  }
  session.messages.push({ role: 'user', content: order.map((id) => results.get(id)) });
  emit({ type: 'confirmation_resolved', approved: approve });
  return loop(session, m, emit, opts);
}

// ---------- internals ----------
function declinePending(session, why) {
  const { order, results, gated } = session.pending;
  for (const g of gated) results.set(g.id, toolResult(g.id, { ok: false, error: { code: 'NOT_CONFIRMED', message: why } }));
  session.pending = null;
  return order.map((id) => results.get(id));
}

function maybeCompact(session) {
  // shortcut: char-length token estimate; upgrade to count_tokens if conversations get long in practice.
  if (session.pending || JSON.stringify(session.messages).length < 240_000) return;
  const done = session.turns.filter((t) => t.finalText).slice(-8).map((t) => `- User: ${t.userText}\n  You: ${t.finalText.slice(0, 600)}`);
  session.messages = [
    { role: 'user', content: `<conversation_summary>\n${done.join('\n')}\nRecent records: ${session.memory.join('; ')}\n</conversation_summary>` },
    { role: 'assistant', content: 'Understood — continuing with that context.' },
  ];
}

async function loop(session, m, emit, opts) {
  const strat = session.strategy;
  try {
    // The step budget is per user turn, shared across confirmation round-trips.
    while ((session.turnIters = (session.turnIters || 0) + 1) <= MAX_ITERS) {
      if (opts.signal?.aborted) {
        m.finalText = 'Stopped: the client disconnected.';
        return finish(m, 'aborted', emit);
      }
      const msg = await callModel(session, m, emit, opts.signal);
      if (msg.stop_reason === 'refusal') {
        // A refusal can cut a tool_use off mid-input: never run it, and keep history valid without it.
        m.finalText ||= 'I can’t help with that request.';
        session.messages.push({ role: 'assistant', content: m.finalText });
        return finish(m, 'refused', emit);
      }
      // An empty assistant message would make every later request in this chat invalid, so it is never stored.
      if (msg.content.length) session.messages.push({ role: 'assistant', content: msg.content });
      const uses = msg.content.filter((b) => b.type === 'tool_use');
      if (!uses.length) {
        m.finalText = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || '(No summary was returned — see the actions above.)';
        if (msg.stop_reason === 'max_tokens') {
          m.finalText += '\n\n_(answer cut off at the output limit)_';
          return finish(m, 'incomplete', emit);
        }
        return finish(m, 'completed', emit);
      }
      if (msg.stop_reason === 'max_tokens') throw new Error('tool input truncated at max_tokens');

      // Resolve calls, run safe ones now, hold gated ones for confirmation.
      const results = new Map();
      const gated = [];
      const calls = uses.map((u) => ({ id: u.id, ...resolveCall(u, strat) }));
      const writes = calls.filter((c) => c.action && c.action.risk !== 'read');
      // Bulk is counted per user turn, so splitting a mass change across steps doesn't dodge the gate.
      const bulk = !session.bulkApproved && session.turnWrites + writes.length > BULK_WRITES;
      for (const c of calls) {
        if (c.meta) results.set(c.id, c.meta());
        else if (c.error) results.set(c.id, toolResult(c.id, { ok: false, error: c.error }));
        else if (GATED.has(c.action.risk) || (bulk && c.action.risk !== 'read')) gated.push(c);
        else {
          results.set(c.id, runAction(session, m, c, emit));
          if (c.action.risk !== 'read') session.turnWrites++;
        }
      }
      if (gated.length) {
        const token = randomUUID();
        session.pending = { order: uses.map((u) => u.id), results, gated, bulk, token };
        const pending = gated.map((g) => ({ id: g.id, action: g.fullId, name: g.action.name, risk: bulk && !GATED.has(g.action.risk) ? 'bulk' : g.action.risk, input: g.input }));
        m.pendingConfirmation = pending;
        emit({ type: 'confirm', pending, bulk, token });
        if (opts.autoConfirm !== undefined) {
          finish(m, 'awaiting_confirmation', emit, true);
          return confirm(session, opts.autoConfirm, emit, opts);
        }
        m.finalText = `Waiting for your confirmation to run ${gated.length} action(s).`;
        return finish(m, 'awaiting_confirmation', emit);
      }
      session.messages.push({ role: 'user', content: uses.map((u) => results.get(u.id)) });
    }
    m.finalText = 'Stopped: too many steps for one request. Partial results are listed above.';
    return finish(m, 'max_iterations', emit);
  } catch (e) {
    const aborted = opts.signal?.aborted;
    m.error = aborted ? 'client disconnected' : e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e.message;
    if (!aborted) emit({ type: 'error', message: m.error });
    // Keep the transcript valid: an assistant tool_use must be followed by tool_results.
    const last = session.messages.at(-1);
    if (last?.role === 'assistant' && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_use')) session.messages.pop();
    if (session.messages.at(-1)?.role === 'user') session.messages.push({ role: 'assistant', content: `(error: ${m.error})` });
    return finish(m, aborted ? 'aborted' : 'error', emit);
  }
}

function resolveCall(u, strat) {
  if (strat.tools === 'all') {
    const fullId = u.name.replace('__', '.');
    return actions.has(fullId) ? { fullId, action: actions.get(fullId), input: u.input } : { error: { code: 'UNKNOWN_ACTION', message: u.name } };
  }
  if (u.name === 'search_actions') {
    return {
      meta: () => {
        const q = String(u.input?.query || '');
        const hits = searchActions(q, { k: 8, module: u.input?.module });
        return toolResultText(u.id, hits.length ? hits.map((h) => h.a.card).join('\n') : 'No matching actions. The platform may not support this.');
      },
    };
  }
  if (u.name === 'execute_action') {
    const fullId = u.input?.action;
    if (typeof fullId !== 'string' || !actions.has(fullId))
      return { error: { code: 'UNKNOWN_ACTION', message: `Unknown action '${fullId}'. Use search_actions to find valid ids.` } };
    if (u.input.input !== undefined && (typeof u.input.input !== 'object' || Array.isArray(u.input.input)))
      return { error: { code: 'VALIDATION', message: 'input must be an object' } };
    return { fullId, action: actions.get(fullId), input: u.input.input ?? {} };
  }
  return { error: { code: 'UNKNOWN_TOOL', message: u.name } };
}

function runAction(session, m, c, emit, confirmed = false) {
  emit({ type: 'action_start', id: c.id, action: c.fullId, name: c.action.name, risk: c.action.risk, input: c.input });
  const t = performance.now();
  const r = execute(c.fullId, c.input);
  const ms = +(performance.now() - t).toFixed(2);
  m.actions.push({ action: c.fullId, input: c.input, ok: r.ok, error: r.ok ? undefined : r.error, ms, confirmed });
  if (r.ok) {
    remember(session, c.fullId, r.data, c.input, c.action.risk);
    markUseful(m, 'action');
  }
  emit({ type: 'action_end', id: c.id, action: c.fullId, ok: r.ok, ms, ...(r.ok ? { summary: summarize(r.data) } : { error: r.error }), data: r.ok ? r.data : undefined });
  // Bad input on an action picked from the index: hand back its signature so the retry is one step.
  if (!r.ok && r.error.code === 'VALIDATION') r.error.signature = c.action.card;
  return toolResult(c.id, r, session.strategy.compact);
}
const summarize = (d) => (d?.items ? `${d.total} result(s)` : d?.id ? `${d.id}${label(d) ? ' · ' + label(d) : ''}` : 'ok');
const toolResult = (id, r, doCompact = true) => ({
  type: 'tool_result', tool_use_id: id, ...(r.ok ? {} : { is_error: true }),
  content: JSON.stringify(r.ok ? (doCompact ? compact(r.data) : r.data) : { error: r.error }),
});
const toolResultText = (id, text) => ({ type: 'tool_result', tool_use_id: id, content: text });

const retryable = (e) => e instanceof Anthropic.APIConnectionError || (e instanceof Anthropic.APIError && (e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callModel(session, m, emit, signal) {
  const strat = session.strategy;
  const system = strat.tools === 'all' ? SYSTEM_BASELINE : SYSTEM;
  const params = {
    model: MODEL,
    max_tokens: 16000,
    system: strat.cache ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system,
    tools: withEager(strat.tools === 'all' ? allTools() : META_TOOLS),
    messages: session.messages,
    output_config: { effort: strat.effort },
    ...(strat.cache ? { cache_control: { type: 'ephemeral' } } : {}),
    // Without this, narration between tool calls (the "here's what I'll do" line) comes back as empty thinking blocks.
    ...(PROGRESS_UPDATES ? { thinking: { type: 'adaptive', display: 'updates' }, betas: [UPDATES_BETA] } : {}),
  };
  for (let attempt = 0; ; attempt++) {
    const t = performance.now();
    let ttft = null;
    let stream;
    emit({ type: 'call_start' });
    try {
      stream = PROGRESS_UPDATES ? llm().beta.messages.stream(params, { signal }) : llm().messages.stream(params, { signal });
      for await (const ev of stream) {
        if (ev.type !== 'content_block_delta' && ev.type !== 'content_block_start') continue;
        const text = ev.delta?.type === 'text_delta' ? ev.delta.text : ev.delta?.type === 'thinking_delta' ? ev.delta.thinking : '';
        if (text) {
          ttft ??= performance.now() - t;
          markUseful(m, 'text');
          emit({ type: ev.delta.type === 'text_delta' ? 'text' : 'progress', delta: text });
        } else if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
          emit({ type: 'tool_call', name: ev.content_block.name });
        }
      }
      const msg = await stream.finalMessage();
      const cost = addUsage(m, msg.usage);
      m.llmCalls.push({ ms: Math.round(performance.now() - t), ttftMs: ttft && Math.round(ttft), stop: msg.stop_reason, usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens, cacheRead: msg.usage.cache_read_input_tokens || 0, cacheWrite: msg.usage.cache_creation_input_tokens || 0 }, costUSD: cost });
      emit({ type: 'text_break' });
      return msg;
    } catch (e) {
      // A stream that died mid-way may already have billed tokens; count what the snapshot shows.
      const partial = stream?.currentMessage?.usage;
      if (partial) m.llmCalls.push({ ms: Math.round(performance.now() - t), failed: true, costUSD: addUsage(m, partial) });
      const api = e instanceof Anthropic.APIError;
      // Retry only transient API/network errors (backoff, honour retry-after) and unparseable streamed tool JSON.
      // Anything else (missing credentials, a bug, an abort) fails fast with its real reason.
      const badJson = !api && (e instanceof SyntaxError || /JSON/i.test(e.message));
      if (signal?.aborted || (api ? !retryable(e) || attempt >= API_RETRIES : !badJson || attempt >= 2)) throw e;
      m.retries++;
      emit({ type: 'retry', attempt: attempt + 1, reason: api ? `${e.status ?? 'network'} ${e.message}`.slice(0, 120) : 'malformed tool input' });
      if (api) await sleep(Math.min(8000, Number(e.headers?.get?.('retry-after')) * 1000 || 500 * 2 ** attempt));
    }
  }
}
function addUsage(m, u) {
  for (const k of Object.keys(m.usage)) m.usage[k] += u[k] || 0;
  const cost = costUSD(MODEL, u);
  m.costUSD += cost;
  return cost;
}

function finish(m, status, emit, intermediate = false) {
  m.status = status;
  m.e2eMs = since(m);
  m.calls = m.llmCalls.length;
  m.costUSD = +m.costUSD.toFixed(6);
  delete m.t0;
  if (!intermediate) emit({ type: 'done', status, text: m.finalText, metrics: publicMetrics(m) });
  return m;
}
export const publicMetrics = (m) => ({
  status: m.status, ttfurMs: m.ttfurMs, ttftTextMs: m.ttftTextMs, e2eMs: m.e2eMs, llmCalls: m.llmCalls.filter((c) => !c.failed).length, retries: m.retries, actions: m.actions.length,
  failedActions: m.actions.filter((a) => !a.ok).length, usage: m.usage, costUSD: m.costUSD, strategy: m.strategy, model: m.model,
});
