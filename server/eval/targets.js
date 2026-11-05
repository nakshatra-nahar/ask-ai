// Performance targets for the OPTIMIZED strategy, fixed before the first benchmark run (2026-11-04).
// Rationale: interactive chat needs a useful first token in ~2s; complex multi-module workflows may take tens of
// seconds if progress streams; cost must stay well under a cent-scale per routine request at Opus pricing.
export const TARGETS = {
  'quality.taskSuccess': { min: 80 },
  'quality.actionSelection': { min: 85 },
  'quality.paramAccuracy': { min: 90 },
  'latency.direct.ttfur.p50': { max: 2500 },
  'latency.direct.ttfur.p95': { max: 5000 },
  'latency.complex.ttfur.p50': { max: 3000 },
  'latency.complex.ttfur.p95': { max: 6000 },
  'latency.direct.e2e.p50': { max: 6000 },
  'latency.direct.e2e.p95': { max: 12000 },
  'latency.complex.e2e.p50': { max: 25000 },
  'latency.complex.e2e.p95': { max: 45000 },
  'cost.perRequest': { max: 0.05 },
  'cost.perSuccessfulTask': { max: 0.08 },
  'cost.callsPerRequest': { max: 3.5 },
  'cost.cacheHitRate': { min: 40 },
};
