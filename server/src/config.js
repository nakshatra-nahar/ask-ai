// Naive datetimes (no Z/offset) are interpreted as UTC on every host, not the machine's local zone.
process.env.TZ = 'UTC';

// Central config. Simulated clock is fixed so seeds, relative dates ("last week") and evals are reproducible.
export const NOW = new Date(process.env.ASK_AI_NOW || '2026-11-04T10:00:00Z');
export const MODEL = process.env.ASK_AI_MODEL || 'claude-opus-5-5';
export const EFFORT = process.env.ASK_AI_EFFORT || 'low';
export const PORT = Number(process.env.PORT || 8787);

// USD per 1M tokens (Anthropic first-party list prices, cached 2026-10-06).
// Cache writes (5m TTL) bill at 1.25x input; cache reads at 0.1x input.
export const PRICING = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-fable-5-1': { input: 10, output: 50 },
};

export function costUSD(model, u) {
  const p = PRICING[model] || PRICING['claude-opus-5-5'];
  return (
    (u.input_tokens || 0) * p.input +
    (u.cache_creation_input_tokens || 0) * p.input * 1.25 +
    (u.cache_read_input_tokens || 0) * p.input * 0.1 +
    (u.output_tokens || 0) * p.output
  ) / 1e6;
}
