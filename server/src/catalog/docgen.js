// Writes docs/CATALOG.md: every module and action with its signature, risk, and description.
import { writeFileSync, mkdirSync } from 'node:fs';
import { modules, actions } from './registry.js';

let md = `# Action catalog\n\n${modules.length} modules · ${actions.size} actions. Generated from the registry (\`npm run catalog -w server\`). Signature notation: \`param?\` = optional. Risk: read · write · destructive · external (destructive/external require user confirmation).\n\n`;
md += modules.map((m) => `- [${m.code} ${m.name}](#${m.code.toLowerCase()}-${m.name.toLowerCase().replace(/\s+/g, '-')})`).join('\n') + '\n';
for (const m of modules) {
  md += `\n## ${m.code} ${m.name}\n\n${m.description}\n\n| action | risk | signature / description |\n|---|---|---|\n`;
  for (const a of m.actions) {
    const x = actions.get(`${m.id}.${a.id}`);
    const sig = x.card.split(' [')[0].replace(/\|/g, '\\|');
    md += `| ${a.name} | ${a.risk} | \`${sig}\` — ${a.description.replace(/\|/g, '\\|')} |\n`;
  }
}
mkdirSync(new URL('../../../docs/', import.meta.url), { recursive: true });
writeFileSync(new URL('../../../docs/CATALOG.md', import.meta.url), md);
console.log(`docs/CATALOG.md: ${modules.length} modules, ${actions.size} actions`);
