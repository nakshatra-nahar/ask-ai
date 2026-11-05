<script setup>
import { ref, reactive, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { streamPost } from './api.js';
import { md } from './md.js';

const PRESETS = [
  ['Direct', 'Create a contact named Sarah Lee with email sarah.lee@brightpath.io and assign her to Jordan Lee.'],
  ['Indirect', 'I keep forgetting to follow up with new leads. Help me stay on top of them.'],
  ['Complex', 'Find leads created last week who have not replied, exclude anyone with a booked appointment, assign the remaining leads to available sales reps, and create follow-up tasks.'],
  ['Follow-up', 'Only include leads from the Facebook campaign, and make those tasks due tomorrow.'],
  ['Conditional', 'For unpaid invoices overdue by more than 15 days, draft reminders, but skip customers who already received one this week.'],
  ['Ambiguous', 'Send Sarah a text saying her appointment is confirmed.'],
  ['Unsupported', 'Order 200 business cards from Vistaprint for Jordan.'],
  ['Typo', 'show me overdeu invocies and who ows the most'],
];

const health = ref(null);
const strategy = ref('optimized');
const sessionId = ref(null);
const turns = reactive([]);
const input = ref('');
const busy = ref(false);
const now = ref(performance.now());
const scroller = ref(null);
let timer;

onMounted(async () => {
  health.value = await fetch('/api/health').then((r) => r.json()).catch(() => null);
  timer = setInterval(() => (now.value = performance.now()), 100);
});
onUnmounted(() => clearInterval(timer));

const totals = computed(() => {
  const ms = turns.map((t) => t.metrics || t.partial).filter(Boolean);
  return {
    runs: ms.length,
    tokens: ms.reduce((s, m) => s + m.usage.input_tokens + m.usage.output_tokens + m.usage.cache_read_input_tokens + m.usage.cache_creation_input_tokens, 0),
    cost: ms.reduce((s, m) => s + m.costUSD, 0),
  };
});

const scrollDown = () => nextTick(() => scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' }));

function agentTurn() {
  const t = reactive({ role: 'agent', segments: [], status: 'running', metrics: null, pending: null, token: null, retrieval: null, error: null, started: performance.now(), openText: false, callStart: 0, retries: 0 });
  turns.push(t);
  return t;
}

function onEvent(t, ev) {
  switch (ev.type) {
    case 'session': sessionId.value = ev.sessionId; break;
    case 'retrieval': t.retrieval = ev; break;
    case 'call_start': t.callStart = t.segments.length; t.openText = false; break;
    // A failed model call is re-issued: drop the partial text it streamed so nothing shows twice.
    case 'retry': t.segments.splice(t.callStart); t.retries++; t.openText = false; break;
    case 'text':
    case 'progress': {
      const kind = ev.type === 'text' ? 'text' : 'progress';
      const last = t.segments.at(-1);
      if (t.openText && last?.kind === kind) last.text += ev.delta;
      else t.segments.push({ kind, text: ev.delta });
      t.openText = true;
      break;
    }
    case 'text_break': t.openText = false; break;
    case 'action_start': t.openText = false; t.segments.push({ kind: 'step', ...ev, state: 'running' }); break;
    case 'action_end': {
      const s = t.segments.find((x) => x.kind === 'step' && x.id === ev.id);
      if (s) Object.assign(s, { state: ev.ok ? 'ok' : 'fail', summary: ev.summary, error: ev.error, ms: ev.ms, data: ev.data });
      break;
    }
    case 'confirm': t.pending = ev.pending; t.bulk = ev.bulk; t.token = ev.token; break;
    case 'confirmation_resolved': t.pending = null; break;
    case 'done':
      t.status = ev.status;
      if (ev.status !== 'awaiting_confirmation') t.metrics = mergeMetrics(t.metrics, ev.metrics);
      else t.partial = mergeMetrics(t.partial, ev.metrics);
      break;
    case 'error': t.error = ev.message; t.status = 'error'; break;
  }
  scrollDown();
}
// A confirmed run is two server segments; show their sum.
function mergeMetrics(a, b) {
  if (!a) return b;
  const u = {};
  for (const k of Object.keys(b.usage)) u[k] = a.usage[k] + b.usage[k];
  return { ...b, ttfurMs: a.ttfurMs ?? b.ttfurMs, e2eMs: a.e2eMs + b.e2eMs, llmCalls: a.llmCalls + b.llmCalls, retries: (a.retries || 0) + (b.retries || 0), actions: a.actions + b.actions, failedActions: a.failedActions + b.failedActions, usage: u, costUSD: a.costUSD + b.costUSD };
}

async function send(text = input.value) {
  text = text.trim();
  if (!text || busy.value) return;
  input.value = '';
  // Sending a new message cancels any confirmation still waiting (the server declines it too).
  for (const old of turns) if (old.pending) Object.assign(old, { pending: null, superseded: true, status: 'cancelled' });
  turns.push({ role: 'user', text });
  const t = agentTurn();
  busy.value = true;
  scrollDown();
  try {
    await streamPost('/api/chat', { sessionId: sessionId.value, message: text, strategy: strategy.value }, (ev) => onEvent(t, ev));
  } catch (e) {
    onEvent(t, { type: 'error', message: e.message });
  } finally {
    busy.value = false;
  }
}

async function decide(t, approve) {
  busy.value = true;
  const token = t.token;
  t.pending = null;
  t.status = 'running';
  t.openText = false;
  t.metrics = t.partial;
  try {
    await streamPost('/api/confirm', { sessionId: sessionId.value, approve, token }, (ev) => onEvent(t, ev));
  } catch (e) {
    onEvent(t, { type: 'error', message: e.message });
  } finally {
    busy.value = false;
  }
}

async function resetAll() {
  if (busy.value) return;
  await fetch('/api/reset', { method: 'POST' });
  turns.splice(0);
  sessionId.value = null;
}
function newChat() {
  if (busy.value) return;
  turns.splice(0);
  sessionId.value = null;
}

const fmtMs = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtN = (n) => n.toLocaleString();
const elapsed = (t) => fmtMs(Math.round(now.value - t.started));
const inputStr = (o) => Object.entries(o || {}).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('  ');
const kbd = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
};
</script>

<template>
  <div class="shell">
    <header class="top">
      <div class="brand">
        <h1>Ask <em>AI</em></h1>
        <span class="tag">50 modules · 500 actions · {{ health?.model || 'offline' }}</span>
      </div>
      <div class="controls">
        <label class="seg" title="Agent strategy used for new chats">
          <span>strategy</span>
          <select v-model="strategy" :disabled="!!sessionId">
            <option value="optimized">optimized</option>
            <option value="baseline">baseline (all 500 tools)</option>
          </select>
        </label>
        <button class="ghost" @click="newChat" :disabled="busy">New chat</button>
        <button class="ghost" @click="resetAll" :disabled="busy" title="Re-seed all synthetic data">Reset data</button>
      </div>
    </header>

    <aside class="rail">
      <h2>Try</h2>
      <button v-for="[k, p] in PRESETS" :key="k" class="preset" @click="send(p)" :disabled="busy">
        <span class="kind">{{ k }}</span>{{ p }}
      </button>
      <div class="ledger-total" v-if="totals.runs">
        <h2>This session</h2>
        <dl>
          <dt>runs</dt><dd>{{ totals.runs }}</dd>
          <dt>tokens</dt><dd>{{ fmtN(totals.tokens) }}</dd>
          <dt>cost</dt><dd>${{ totals.cost.toFixed(4) }}</dd>
        </dl>
      </div>
      <p class="warn" v-if="health && !health.llm">ANTHROPIC_API_KEY is not set on the server — chat is disabled. Set it in <code>.env</code>.</p>
    </aside>

    <main class="chat" ref="scroller" aria-live="polite">
      <div class="empty" v-if="!turns.length">
        <p class="lede">Tell the platform what you need.</p>
        <p class="sub">Contacts, leads, calendars, invoices, campaigns, courses… Ask directly, vaguely, or in several steps. Every action runs against live (synthetic) data and is shown below as a ledger.</p>
      </div>

      <template v-for="(t, i) in turns" :key="i">
        <div v-if="t.role === 'user'" class="msg user">{{ t.text }}</div>

        <article v-else class="msg agent">
          <div class="retrieval" v-if="t.retrieval">
            <span>retrieved {{ t.retrieval.candidates.length }} candidate actions in {{ t.retrieval.ms }}ms</span>
          </div>

          <template v-for="(s, j) in t.segments" :key="j">
            <div v-if="s.kind === 'text'" class="prose" v-html="md(s.text)"></div>
            <p v-else-if="s.kind === 'progress'" class="progress">{{ s.text }}</p>
            <details v-else class="step" :class="[s.risk, s.state]">
              <summary>
                <span class="mark" aria-hidden="true">{{ s.state === 'ok' ? '✓' : s.state === 'fail' ? '✕' : '…' }}</span>
                <span class="aid">{{ s.action }}</span>
                <span class="sum">{{ s.state === 'fail' ? s.error?.code + ': ' + s.error?.message : s.summary || inputStr(s.input) }}</span>
                <span class="ms">{{ s.ms != null ? s.ms + 'ms' : '' }}</span>
              </summary>
              <div class="io">
                <div><b>input</b><pre>{{ JSON.stringify(s.input, null, 2) }}</pre></div>
                <div v-if="s.data"><b>result</b><pre>{{ JSON.stringify(s.data, null, 2) }}</pre></div>
              </div>
            </details>
          </template>

          <div v-if="t.pending" class="confirm" role="group" aria-label="Confirmation required">
            <p><strong>{{ t.bulk ? 'Bulk operation' : 'Needs your OK' }}</strong> — these actions are {{ t.bulk ? 'part of a bulk change' : 'destructive or visible outside your account' }}:</p>
            <ul>
              <li v-for="p in t.pending" :key="p.id"><span class="risk" :class="p.risk">{{ p.risk }}</span> <code>{{ p.action }}</code> <span class="args">{{ inputStr(p.input) }}</span></li>
            </ul>
            <div class="row">
              <button class="go" @click="decide(t, true)" :disabled="busy">Approve {{ t.pending.length }}</button>
              <button class="ghost" @click="decide(t, false)" :disabled="busy">Decline</button>
            </div>
          </div>

          <p v-if="t.superseded" class="note">Not executed — you sent a new message instead of confirming.</p>
          <p v-if="t.error" class="err">Error: {{ t.error }}</p>
          <p v-if="t.status === 'running'" class="working"><span class="pulse"></span>working · {{ elapsed(t) }}</p>

          <footer v-if="t.metrics" class="stub">
            <span>TTFUR {{ fmtMs(t.metrics.ttfurMs) }}</span>
            <span>E2E {{ fmtMs(t.metrics.e2eMs) }}</span>
            <span>{{ t.metrics.llmCalls }} calls<template v-if="t.metrics.retries"> · {{ t.metrics.retries }} retries</template></span>
            <span>{{ t.metrics.actions }} actions<template v-if="t.metrics.failedActions"> ({{ t.metrics.failedActions }} failed)</template></span>
            <span>{{ fmtN(t.metrics.usage.input_tokens) }} in · {{ fmtN(t.metrics.usage.cache_read_input_tokens) }} cached · {{ fmtN(t.metrics.usage.output_tokens) }} out</span>
            <span class="cost">${{ t.metrics.costUSD.toFixed(4) }}</span>
          </footer>
        </article>
      </template>
    </main>

    <form class="composer" @submit.prevent="send()">
      <label for="q" class="sr">Message</label>
      <textarea id="q" v-model="input" @keydown="kbd" rows="2" placeholder="e.g. Find overdue invoices and draft reminders…" :disabled="busy"></textarea>
      <button class="go" :disabled="busy || !input.trim()">Run</button>
    </form>
  </div>
</template>
