import express from 'express';
import { mkdirSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, MODEL, NOW } from './config.js';
import { modules, reset, getDb, validateCatalog } from './catalog/registry.js';
import { getSession, findSession, runTurn, confirm, publicMetrics, dropSession, clearSessions } from './agent/agent.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TRACE_DIR = path.join(here, '../traces');
mkdirSync(TRACE_DIR, { recursive: true });
reset();
const problems = validateCatalog();
if (problems.length) console.warn('Catalog problems:', problems);

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_, res) => res.json({ ok: true, model: MODEL, now: NOW.toISOString(), modules: modules.length, llm: !!process.env.ANTHROPIC_API_KEY }));

app.get('/api/catalog', (_, res) =>
  res.json(modules.map((m) => ({
    id: m.id, code: m.code, name: m.name, description: m.description,
    actions: m.actions.map((a) => ({ id: `${m.id}.${a.id}`, name: a.name, risk: a.risk, description: a.description })),
  }))),
);

app.get('/api/state', (_, res) => res.json(Object.fromEntries(Object.entries(getDb().tables).map(([t, rows]) => [t, rows.length]))));
app.get('/api/state/:table', (req, res) => res.json(getDb().tables[req.params.table] || []));

app.post('/api/reset', (_, res) => {
  reset();
  clearSessions(); // old transcripts reference records that no longer exist
  res.json({ ok: true });
});

// Streams NDJSON events: session, retrieval, call_start, text, progress, retry, tool_call, action_start, action_end,
// confirm, confirmation_resolved, done, error. One request per session at a time keeps the transcript consistent.
function stream(res, session, work) {
  if (session.busy) return res.status(409).json({ error: 'this chat is still working on the previous request' });
  session.busy = true;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  const emit = (ev) => res.writableEnded || res.write(JSON.stringify(ev) + '\n');
  // Client gone (tab closed) => stop spending model calls on a turn nobody will see.
  const abort = new AbortController();
  res.on('close', () => res.writableFinished || abort.abort());
  work(emit, abort.signal)
    .then((m) => {
      const file = path.join(TRACE_DIR, `${m.sessionId}-${String(m.turn).padStart(2, '0')}.json`);
      writeFile(file, JSON.stringify(m, null, 2)).catch((e) => console.warn('trace not written:', e.message));
    })
    .catch((e) => emit({ type: 'error', message: e.message }))
    .finally(() => {
      session.busy = false;
      res.end();
    });
}

app.post('/api/chat', (req, res) => {
  const { sessionId, message, strategy } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'message required' });
  if (message.length > 4000) return res.status(400).json({ error: 'message too long' });
  if (strategy !== undefined && !['optimized', 'baseline'].includes(strategy)) return res.status(400).json({ error: 'unknown strategy' });
  // Session ids end up in trace file names: accept only our own UUID-shaped ids, otherwise start a new session.
  const session = getSession(typeof sessionId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(sessionId) ? sessionId : undefined, strategy);
  res.setHeader('X-Session-Id', session.id);
  stream(res, session, (emit, signal) => {
    emit({ type: 'session', sessionId: session.id });
    return runTurn(session, message.trim(), emit, { signal });
  });
});

app.post('/api/confirm', (req, res) => {
  const { sessionId, approve, token } = req.body || {};
  const session = findSession(sessionId);
  if (!session?.pending) return res.status(409).json({ error: 'nothing awaiting confirmation' });
  if (token !== session.pending.token) return res.status(409).json({ error: 'this confirmation is out of date; a newer request is pending' });
  stream(res, session, (emit, signal) => confirm(session, approve === true, emit, { signal }, token));
});

app.delete('/api/session/:id', (req, res) => res.json({ ok: dropSession(req.params.id) }));

app.get('/api/session/:id/metrics', (req, res) => {
  const s = findSession(req.params.id);
  return s ? res.json(s.turns.map(publicMetrics)) : res.status(404).json({ error: 'unknown session' });
});

const dist = path.join(here, '../../web/dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, () => console.log(`Ask AI server on http://localhost:${PORT} (model ${MODEL}, simulated now ${NOW.toISOString()})`));
