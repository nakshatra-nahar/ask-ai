// Offline retrieval quality: does the per-turn candidate set contain the actions each scenario needs?
// Recall@K is the ceiling on what the model can pick without falling back to search_actions.
// Usage: node eval/retrieval.js [k]
import { retrieveForTurn } from '../src/catalog/search.js';
import { loadScenarios } from './lib.js';

const k = Number(process.argv[2] || 24); // same K the agent uses
const scenarios = (await loadScenarios()).filter((s) => s.expect?.actions?.length);
let need = 0, got = 0, full = 0;
const misses = [];
for (const s of scenarios) {
  // Same per-turn query the agent builds: short follow-ups carry the previous request's words.
  const cands = new Set();
  s.turns.forEach((t, i) => {
    const prev = s.turns[i - 1]?.user;
    const q = t.user.split(/\s+/).length < 12 && prev ? `${t.user} ${prev}` : t.user;
    retrieveForTurn(q, { k }).forEach((a) => cands.add(a.fullId));
  });
  const exp = s.expect.actions.map((a) => [].concat(a));
  const hit = exp.filter((alts) => alts.some((a) => cands.has(a)));
  need += exp.length;
  got += hit.length;
  if (hit.length === exp.length) full++;
  else misses.push(`${s.id}: missing ${exp.filter((x) => !hit.includes(x)).map((x) => x.join('|')).join(', ')}`);
}
console.log(misses.join('\n'));
console.log(`\nRetrieval@${k}: action recall ${((100 * got) / need).toFixed(1)}% (${got}/${need}); scenarios fully covered ${((100 * full) / scenarios.length).toFixed(1)}% (${full}/${scenarios.length})`);
