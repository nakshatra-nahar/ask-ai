// Rebuilds the deterministic seed and prints row counts per table (the server does the same on start / POST /api/reset).
import { reset, getDb } from '../catalog/registry.js';

reset();
const t = getDb().tables;
const rows = Object.entries(t).sort(([a], [b]) => a.localeCompare(b));
for (const [name, r] of rows) console.log(name.padEnd(20), r.length);
console.log(`\n${rows.length} tables, ${rows.reduce((s, [, r]) => s + r.length, 0)} rows (seed 42, clock ${process.env.ASK_AI_NOW || '2026-11-04T10:00:00Z'})`);
