// Builds eval/BENCHMARK.md from eval/results/latest-*.json, scoring each strategy against TARGETS
// (targets are fixed in targets.js and were committed before any benchmark run).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS } from './targets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (s) => {
  const f = path.join(here, 'results', `latest-${s}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
};
const runs = ['baseline', 'optimized'].map(load).filter(Boolean);
if (!runs.length) {
  console.error('No results yet. Run: npm run eval -w server -- --strategy optimized');
  process.exit(1);
}

const ms = (v) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v}ms`);
const usd = (v) => (v == null ? '—' : `$${v.toFixed(4)}`);
const get = (o, p) => p.split('.').reduce((x, k) => x?.[k], o);
const verdict = (v, t) => (v == null ? '—' : (t.max != null ? v <= t.max : v >= t.min) ? '✅' : '❌ missed');

const rows = [
  ['Task success (end-to-end, state-checked)', 'quality.taskSuccess', (v) => `${v}%`],
  ['Correct action selection', 'quality.actionSelection', (v) => `${v}%`],
  ['Expected-action recall', 'quality.actionRecall', (v) => `${v}%`],
  ['Parameter accuracy', 'quality.paramAccuracy', (v) => `${v}%`],
  ['TTFUR p50 — direct', 'latency.direct.ttfur.p50', ms],
  ['TTFUR p95 — direct', 'latency.direct.ttfur.p95', ms],
  ['TTFUR p50 — complex', 'latency.complex.ttfur.p50', ms],
  ['TTFUR p95 — complex', 'latency.complex.ttfur.p95', ms],
  ['First streamed text p50 — direct', 'latency.direct.firstText.p50', ms],
  ['First streamed text p50 — complex', 'latency.complex.firstText.p50', ms],
  ['E2E p50 — direct', 'latency.direct.e2e.p50', ms],
  ['E2E p95 — direct', 'latency.direct.e2e.p95', ms],
  ['E2E p50 — complex', 'latency.complex.e2e.p50', ms],
  ['E2E p95 — complex', 'latency.complex.e2e.p95', ms],
  ['Cost per request', 'cost.perRequest', usd],
  ['Cost per successful task', 'cost.perSuccessfulTask', usd],
  ['Model calls per request', 'cost.callsPerRequest', (v) => v],
  ['Input tokens per request (incl. cached)', 'cost.inputTokensPerRequest', (v) => v?.toLocaleString()],
  ['Cache hit rate (input)', 'cost.cacheHitRate', (v) => `${v}%`],
  ['Total cost (all scenarios)', 'cost.total', usd],
  ['Retries', 'cost.retries', (v) => v],
  ['Errors', 'errors', (v) => v],
];

let md = `# Benchmark report\n\nGenerated ${new Date().toISOString()} from \`eval/results/latest-*.json\`.\n\n`;
md += `| | ${runs.map((r) => `**${r.strategy}**`).join(' | ')} | target (${runs.at(-1).strategy}) |\n|---|${runs.map(() => '---|').join('')}---|\n`;
for (const [name, p, f] of rows) {
  const t = TARGETS[p];
  md += `| ${name} | ${runs.map((r) => f(get(r.summary, p))).join(' | ')} | ${t ? `${t.max != null ? '≤' : '≥'} ${f(t.max ?? t.min)} ${verdict(get(runs.at(-1).summary, p), t)}` : ''} |\n`;
}
md += `\n**Test conditions:** ${runs.map((r) => `${r.strategy}: model \`${r.model}\`, effort \`${r.effort}\`, ${r.summary.n} scenarios, concurrency ${r.concurrency}, wall ${(r.wallMs / 1000).toFixed(0)}s, started ${r.startedAt}, Node ${r.node}`).join('; ')}. `;
md += `Latency is per user turn, measured server-side from request receipt (no network/UI). TTFUR = first streamed text (progress note or answer) or first completed action result, whichever comes first; first-streamed-text is reported separately. Confirmations are auto-approved in evals, so E2E excludes human wait. Cost = list price × tokens (cache write 1.25×, cache read 0.1× input), including retries.\n\n`;

md += `## Task success by category\n\n| category | ${runs.map((r) => r.strategy).join(' | ')} |\n|---|${runs.map(() => '---|').join('')}\n`;
const cats = [...new Set(runs.flatMap((r) => Object.keys(r.summary.quality.byCategory)))].sort();
for (const c of cats) md += `| ${c} | ${runs.map((r) => { const x = r.summary.quality.byCategory[c]; return x ? `${x.pass}/${x.n}` : '—'; }).join(' | ')} |\n`;

for (const r of runs) {
  const fails = r.results.filter((x) => !x.pass);
  md += `\n## Failures — ${r.strategy} (${fails.length})\n\n`;
  md += fails.length ? fails.map((x) => `- **${x.id}** (${x.category}): ${x.failed.join('; ').slice(0, 300)}`).join('\n') + '\n' : 'None.\n';
}
writeFileSync(path.join(here, 'BENCHMARK.md'), md);
console.log(md);
