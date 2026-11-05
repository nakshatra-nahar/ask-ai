// LLM benchmark: runs every scenario end-to-end through the real agent (real model calls, mock platform),
// asserts on executed actions + final data state, and records latency/cost per user turn.
// Each worker thread has its own in-memory store, so scenarios run in parallel without interfering.
//
// Usage: node --env-file=../.env eval/run.js --strategy optimized|baseline [--concurrency 4] [--filter id|category|module] [--limit N]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from './summary.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};

if (isMainThread) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set (put it in ask-ai/.env). Offline checks: npm run smoke / oracle / retrieval.');
    process.exit(1);
  }
  const strategy = arg('strategy', 'optimized');
  const conc = Number(arg('concurrency', 4));
  const { loadScenarios } = await import('./lib.js');
  let scenarios = await loadScenarios(arg('filter'));
  if (arg('limit')) scenarios = scenarios.slice(0, Number(arg('limit')));
  const ids = scenarios.map((s) => s.id);
  console.log(`Running ${ids.length} scenarios · strategy=${strategy} · concurrency=${conc}`);
  const started = Date.now();
  const results = [];
  await Promise.all(
    Array.from({ length: Math.min(conc, ids.length) }, (_, w) =>
      new Promise((resolve) => {
        const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { ids: ids.filter((_, i) => i % conc === w), strategy, filter: arg('filter') } });
        worker.on('message', (r) => {
          results.push(r);
          console.log(`${r.pass ? '✓' : '✗'} ${r.id.padEnd(44)} ${String(r.e2eMs).padStart(6)}ms $${r.costUSD.toFixed(4)}${r.pass ? '' : '  ← ' + r.failed.join('; ').slice(0, 160)}`);
        });
        // A crashed worker must not abort the whole benchmark: its unfinished scenarios are recorded as failures below.
        worker.on('error', (e) => console.error(`worker ${w} crashed: ${e.message}`));
        worker.on('exit', resolve);
      }),
    ),
  );
  for (const id of ids.filter((x) => !results.some((r) => r.id === x))) {
    const s = scenarios.find((x) => x.id === id);
    results.push({ id, category: s.category, modules: s.modules, pass: false, failed: ['not run: worker crashed'], selection: { expected: (s.expect?.actions || []).length, hit: 0, forbiddenHit: 0, unexpectedWrites: 0 }, params: { total: 0, hit: 0 }, turns: [], finalText: '', e2eMs: 0, costUSD: 0 });
  }
  results.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  const { MODEL, EFFORT } = await import('../src/config.js');
  const out = {
    strategy, model: MODEL, effort: strategy === 'baseline' ? 'medium' : EFFORT, concurrency: conc, startedAt: new Date(started).toISOString(),
    wallMs: Date.now() - started, node: process.version, summary: summarize(results), results,
  };
  mkdirSync(path.join(here, 'results'), { recursive: true });
  writeFileSync(path.join(here, 'results', `latest-${strategy}.json`), JSON.stringify(out, null, 2));
  const s = out.summary;
  console.log(`\n${strategy}: success ${s.quality.taskSuccess}% · selection ${s.quality.actionSelection}% · params ${s.quality.paramAccuracy}% · $${s.cost.total} total · $${s.cost.perSuccessfulTask}/success`);
  console.log(`TTFUR p50/p95 direct ${s.latency.direct.ttfur.p50}/${s.latency.direct.ttfur.p95}ms · complex ${s.latency.complex.ttfur.p50}/${s.latency.complex.ttfur.p95}ms`);
  console.log(`E2E   p50/p95 direct ${s.latency.direct.e2e.p50}/${s.latency.direct.e2e.p95}ms · complex ${s.latency.complex.e2e.p50}/${s.latency.complex.e2e.p95}ms`);
  console.log('Wrote eval/results/latest-' + strategy + '.json — run `npm run report -w server` to refresh BENCHMARK.md');
} else {
  const { reset } = await import('../src/catalog/registry.js');
  const { getSession, runTurn } = await import('../src/agent/agent.js');
  const { loadScenarios, seedIds, stateHelpers, checkScenario } = await import('./lib.js');
  const { ids, strategy, filter } = workerData;
  const byId = new Map((await loadScenarios(filter)).map((s) => [s.id, s]));
  const traceDir = path.join(here, 'traces', strategy);
  mkdirSync(traceDir, { recursive: true });

  for (const id of ids) {
    const s = byId.get(id);
    reset();
    const seed = seedIds();
    const session = getSession(null, strategy);
    const turns = [];
    for (const t of s.turns) {
      const before = session.turns.length;
      await runTurn(session, t.user, () => {}, { autoConfirm: t.confirm ?? true });
      const segs = session.turns.slice(before);
      const u = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      segs.forEach((g) => Object.keys(u).forEach((k) => (u[k] += g.usage[k])));
      turns.push({
        user: t.user, status: segs.at(-1).status, ttfurMs: segs[0].ttfurMs, ttftTextMs: segs.find((g) => g.ttftTextMs != null)?.ttftTextMs ?? null, e2eMs: segs.reduce((a, g) => a + g.e2eMs, 0),
        llmCalls: segs.reduce((a, g) => a + g.llmCalls.filter((c) => !c.failed).length, 0), retries: segs.reduce((a, g) => a + g.retries, 0),
        usage: u, costUSD: segs.reduce((a, g) => a + g.costUSD, 0), error: segs.find((g) => g.error)?.error,
      });
    }
    const calls = session.turns.flatMap((m) => m.actions);
    const finalText = session.turns.at(-1).finalText || '';
    const confirmRequested = session.turns.some((m) => m.pendingConfirmation);
    const check = checkScenario(s, { calls, finalText, confirmRequested, h: stateHelpers(seed) });
    const r = {
      id, category: s.category, modules: s.modules, pass: check.pass, failed: check.checks.filter((c) => !c.pass).map((c) => `${c.name}${c.detail ? ' (' + c.detail + ')' : ''}`),
      selection: check.selection, params: check.params, turns, finalText,
      e2eMs: turns.reduce((a, t) => a + t.e2eMs, 0), costUSD: turns.reduce((a, t) => a + t.costUSD, 0),
      retrievalRecall: session.turns.map((m) => m.retrieved).flat().length ? (s.expect?.actions || []).flat().filter((a) => session.turns.some((m) => m.retrieved?.includes(a))).length : null,
    };
    writeFileSync(path.join(traceDir, `${id}.json`), JSON.stringify({ scenario: { id, category: s.category, turns: s.turns }, check, segments: session.turns }, null, 2));
    parentPort.postMessage(r);
  }
}
