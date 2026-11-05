import { pct } from './lib.js';

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const COMPLEX = new Set(['multi_step', 'conditional']);

/** Aggregate per-scenario results into quality / latency / cost metrics. */
export function summarize(results) {
  const n = results.length;
  const passed = results.filter((r) => r.pass);
  const withSel = results.filter((r) => r.selection.expected);
  const selOk = withSel.filter((r) => r.selection.hit === r.selection.expected && !r.selection.forbiddenHit && !r.selection.unexpectedWrites);
  const pTot = results.reduce((a, r) => a + r.params.total, 0);
  const pHit = results.reduce((a, r) => a + r.params.hit, 0);
  const expTot = withSel.reduce((a, r) => a + r.selection.expected, 0);
  const expHit = withSel.reduce((a, r) => a + r.selection.hit, 0);

  const turnsOf = (pred) => results.filter(pred).flatMap((r) => r.turns);
  const lat = (turns) => ({
    n: turns.length,
    ttfur: { p50: pct(turns.map((t) => t.ttfurMs), 50), p95: pct(turns.map((t) => t.ttfurMs), 95) },
    firstText: { p50: pct(turns.map((t) => t.ttftTextMs), 50), p95: pct(turns.map((t) => t.ttftTextMs), 95) },
    e2e: { p50: pct(turns.map((t) => t.e2eMs), 50), p95: pct(turns.map((t) => t.e2eMs), 95) },
  });
  const allTurns = results.flatMap((r) => r.turns);
  const cost = allTurns.reduce((a, t) => a + t.costUSD, 0);
  const tok = (k) => allTurns.reduce((a, t) => a + t.usage[k], 0);
  const inputAll = tok('input_tokens') + tok('cache_read_input_tokens') + tok('cache_creation_input_tokens');

  const byCategory = {};
  for (const r of results) {
    const c = (byCategory[r.category] ||= { n: 0, pass: 0 });
    c.n++;
    if (r.pass) c.pass++;
  }
  return {
    n,
    quality: {
      taskSuccess: r1((100 * passed.length) / n),
      actionSelection: r1((100 * selOk.length) / (withSel.length || 1)),
      actionRecall: r1((100 * expHit) / (expTot || 1)),
      paramAccuracy: r1((100 * pHit) / (pTot || 1)),
      byCategory,
    },
    latency: {
      direct: lat(turnsOf((r) => r.category === 'direct')),
      complex: lat(turnsOf((r) => COMPLEX.has(r.category))),
      all: lat(allTurns),
    },
    cost: {
      total: +cost.toFixed(4),
      perRequest: +(cost / (allTurns.length || 1)).toFixed(5),
      perSuccessfulTask: passed.length ? +(cost / passed.length).toFixed(5) : null,
      modelCalls: allTurns.reduce((a, t) => a + t.llmCalls, 0),
      callsPerRequest: r1(allTurns.reduce((a, t) => a + t.llmCalls, 0) / (allTurns.length || 1)),
      retries: allTurns.reduce((a, t) => a + (t.retries || 0), 0),
      tokens: { input: tok('input_tokens'), cacheRead: tok('cache_read_input_tokens'), cacheWrite: tok('cache_creation_input_tokens'), output: tok('output_tokens') },
      inputTokensPerRequest: Math.round(inputAll / (allTurns.length || 1)),
      cacheHitRate: r1((100 * tok('cache_read_input_tokens')) / (inputAll || 1)),
    },
    errors: allTurns.filter((t) => t.error).length,
  };
}
