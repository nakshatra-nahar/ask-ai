// Offline test of the agent loop mechanics with a scripted fake model (no API key needed):
// meta-tool dispatch, validation errors, confirmation gating (approve + decline), result ordering, transcript validity.
import assert from 'node:assert/strict';
import { reset, getDb } from '../src/catalog/registry.js';
import { getSession, runTurn, confirm, setClient } from '../src/agent/agent.js';

let script = [];
const seen = [];
const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 };
const fakeMessages = {
    stream(params) {
      seen.push(structuredClone(params.messages));
      const content = script.shift();
      if (!content) throw new Error('script exhausted');
      const events = content.flatMap((b) =>
        b.type === 'text' ? [{ type: 'content_block_delta', delta: { type: 'text_delta', text: b.text } }]
        : b.type === 'thinking' ? [{ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: b.thinking } }]
        : [{ type: 'content_block_start', content_block: b }]);
      return {
        async *[Symbol.asyncIterator]() { yield* events; },
        finalMessage: async () => ({ content, usage, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }),
      };
    },
};
setClient({ messages: fakeMessages, beta: { messages: fakeMessages } });
const use = (id, action, input) => ({ type: 'tool_use', id, name: 'execute_action', input: { action, input } });
const validTranscript = (msgs) => {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const uses = Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_use').map((b) => b.id) : [];
    if (uses.length) {
      const next = msgs[i + 1];
      assert.ok(next, 'tool_use must be followed by a message');
      assert.deepEqual(next.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id), uses, 'tool_results must answer every tool_use in order');
    }
  }
};

// 1) safe call + invalid input + gated call in one step; approve.
reset();
script = [
  [{ type: 'thinking', thinking: 'Creating Ada, then archiving contact 10.' }, use('t1', 'contacts.create_contact', { firstName: 'Ada', email: 'ada@x.io' }), use('t2', 'contacts.create_contact', { email: 'not-an-email' }), use('t3', 'contacts.archive_contact', { id: 'con_010' }), { type: 'tool_use', id: 't4', name: 'search_actions', input: { query: 'archive contact' } }],
  [{ type: 'text', text: 'Done: created Ada and archived con_010.' }],
];
const events = [];
let s = getSession(null, 'optimized');
let m = await runTurn(s, 'add Ada ada@x.io and archive contact 10', (e) => events.push(e));
assert.equal(m.status, 'awaiting_confirmation');
assert.ok(events.some((e) => e.type === 'confirm' && e.pending.length === 1 && e.pending[0].action === 'contacts.archive_contact'));
assert.ok(getDb().tables.contacts.some((c) => c.email === 'ada@x.io'), 'safe write ran before confirmation');
assert.equal(getDb().tables.contacts.find((c) => c.id === 'con_010').status, 'active', 'gated write held');
assert.ok(m.ttfurMs != null, 'ttfur recorded');
assert.ok(events.some((e) => e.type === 'progress' && /Creating Ada/.test(e.delta)), 'progress-update thinking streamed to the user');
await assert.rejects(() => confirm(s, true, () => {}, {}, 'stale-token'), /stale/);
m = await confirm(s, true, (e) => events.push(e));
assert.equal(m.status, 'completed');
assert.equal(getDb().tables.contacts.find((c) => c.id === 'con_010').status, 'archived');
const results = s.messages.at(-2).content;
assert.equal(results.find((r) => r.tool_use_id === 't2').is_error, true, 'validation error returned to model');
assert.match(results.find((r) => r.tool_use_id === 't4').content, /contacts\.archive_contact/);
validTranscript(s.messages);
assert.ok(seen[0][0].content[0].text.includes('<candidate_actions>'), 'retrieval context attached');

// 2) decline path via autoConfirm=false.
reset();
script = [[use('d1', 'invoices.void_invoice', { id: 'inv_001' })], [{ type: 'text', text: 'Okay, left it.' }]];
s = getSession(null, 'optimized');
m = await runTurn(s, 'void invoice INV-1001', () => {}, { autoConfirm: false });
assert.equal(getDb().tables.invoices.find((i) => i.id === 'inv_001').status !== 'void', true);
assert.match(s.messages.at(-2).content[0].content, /DECLINED/);
validTranscript(s.messages);

// 3) new message while a confirmation is pending cancels it and keeps the transcript valid.
reset();
script = [[use('p1', 'invoices.void_invoice', { id: 'inv_001' })], [{ type: 'text', text: 'Sure.' }]];
s = getSession(null, 'optimized');
await runTurn(s, 'void INV-1001');
await runTurn(s, 'actually never mind, what time is it?');
assert.notEqual(getDb().tables.invoices.find((i) => i.id === 'inv_001').status, 'void');
validTranscript(s.messages);

// 4) baseline strategy exposes all 500 tools natively.
reset();
script = [[{ type: 'tool_use', id: 'b1', name: 'tasks__create_task', input: { title: 'Call Ada' } }], [{ type: 'text', text: 'ok' }]];
s = getSession(null, 'baseline');
await runTurn(s, 'remind me to call Ada');
assert.ok(getDb().tables.tasks.some((t) => t.title === 'Call Ada'));

// 5) bulk gate counts writes across steps of one turn (11 task creations split 6 + 5).
reset();
const many = (n, off) => Array.from({ length: n }, (_, i) => use(`w${off + i}`, 'tasks.create_task', { title: `Bulk ${off + i}` }));
script = [many(6, 0), many(5, 6), [{ type: 'text', text: 'done' }]];
s = getSession(null, 'optimized');
const evs = [];
m = await runTurn(s, 'create 11 tasks', (e) => evs.push(e));
assert.equal(m.status, 'awaiting_confirmation', 'second step crosses the bulk threshold');
assert.ok(evs.some((e) => e.type === 'confirm' && e.bulk));
assert.equal(getDb().tables.tasks.filter((t) => t.title.startsWith('Bulk')).length, 6);
await confirm(s, true);
assert.equal(getDb().tables.tasks.filter((t) => t.title.startsWith('Bulk')).length, 11);
validTranscript(s.messages);

// 6) single-record reads keep full text; list results clip long strings.
reset();
const long = 'x'.repeat(900);
const nt = getDb().tables.notes[0];
nt.body = long;
script = [[use('r1', 'notes.get_note', { id: nt.id }), use('r2', 'notes.search_notes', {})], [{ type: 'text', text: 'ok' }]];
s = getSession(null, 'optimized');
await runTurn(s, 'show the note');
const res = s.messages.at(-2).content;
assert.ok(res.find((r) => r.tool_use_id === 'r1').content.includes(long), 'get returns full text');
assert.ok(!res.find((r) => r.tool_use_id === 'r2').content.includes(long), 'search clips');

console.log('Agent loop test: all assertions passed');

// 7) failed writes roll back atomically (handler throws after mutating).
{
  const { actions, execute } = await import('../src/catalog/registry.js');
  reset();
  const a = actions.get('tasks.create_task');
  const orig = a.handler;
  a.handler = (i, ctx) => { ctx.insert('tasks', { title: 'half-written' }); throw new Error('boom'); };
  const warn = console.warn;
  console.warn = () => {}; // the injected failure is expected; keep test output clean
  const r = execute('tasks.create_task', { title: 'x' });
  console.warn = warn;
  a.handler = orig;
  assert.equal(r.ok, false);
  assert.ok(!getDb().tables.tasks.some((t) => t.title === 'half-written'), 'partial write rolled back');
  console.log('Atomic write test: passed');
}

// 8) empty model reply is never stored; 9) step cap holds across auto-confirmations; 10) abort stops the loop.
{
  reset();
  script = [[]];
  let s8 = getSession(null, 'optimized');
  const m8 = await runTurn(s8, 'hello');
  assert.equal(m8.status, 'completed');
  assert.ok(!s8.messages.some((x) => x.role === 'assistant' && Array.isArray(x.content) && !x.content.length), 'no empty assistant message stored');

  reset();
  script = Array.from({ length: 40 }, (_, i) => [use(`loop${i}`, 'invoices.void_invoice', { id: 'inv_001' })]);
  const s9 = getSession(null, 'optimized');
  await runTurn(s9, 'keep voiding', () => {}, { autoConfirm: false });
  assert.ok(script.length >= 40 - 15, `step cap enforced across confirmations (used ${40 - script.length} calls)`);
  validTranscript(s9.messages);

  reset();
  const ac = new AbortController();
  ac.abort();
  script = [[{ type: 'text', text: 'never' }]];
  const s10 = getSession(null, 'optimized');
  const m10 = await runTurn(s10, 'anything', () => {}, { signal: ac.signal });
  assert.equal(m10.status, 'aborted');
  script = [];
  console.log('Empty-reply / step-cap / abort tests: passed');
}
