// Writes docs/EVAL_DATASET.md: a readable index of every eval scenario (prompts + what is checked).
import { writeFileSync } from 'node:fs';
import { loadScenarios } from './lib.js';

const all = await loadScenarios();
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const alt = (a) => (Array.isArray(a) ? a.join(' or ') : a);
const checks = (s) => {
  const e = s.expect || {};
  const c = [];
  if (e.actions?.length) c.push(`actions: ${e.actions.map(alt).join(', ')}`);
  if (e.forbid?.length) c.push(`forbid: ${e.forbid.join(', ')}`);
  if (e.params) c.push(`params: ${Object.keys(e.params).join(', ')}`);
  if (e.clarify) c.push('must ask a clarifying question');
  if (e.noWrites) c.push('no writes');
  if (e.confirmRequested) c.push('must request confirmation');
  if (e.reply) c.push(`reply ~ \`${e.reply.source.slice(0, 60)}\``);
  if (e.state) c.push('final-state assertion');
  return c.join(' · ');
};

const cats = {};
for (const s of all) cats[s.category] = (cats[s.category] || 0) + 1;
const mods = new Set(all.flatMap((s) => s.modules || []));

let md = `# Evaluation dataset\n\n${all.length} scenarios · ${mods.size} modules · ${Object.entries(cats).map(([k, v]) => `${k} ${v}`).join(' · ')}.\n\n`;
md += 'Generated from `server/eval/scenarios/*.js` (`npm run dataset -w server`). Each scenario is checked on the final data state, not just on the reply; every scenario also has an oracle (reference solution run without the LLM) that proves its assertions are satisfiable and that the state check fails on the untouched seed, except safety guards marked invariant (`npm run oracle -w server`).\n\n';
md += '| id | category | modules | user turns | checks |\n|---|---|---|---|---|\n';
for (const s of all) md += `| ${s.id} | ${s.category} | ${(s.modules || []).join(', ')} | ${s.turns.map((t, i) => `${i + 1}. ${esc(t.user)}`).join('<br>')} | ${esc(checks(s))} |\n`;

writeFileSync(new URL('../../docs/EVAL_DATASET.md', import.meta.url), md);
console.log(`docs/EVAL_DATASET.md: ${all.length} scenarios`);
