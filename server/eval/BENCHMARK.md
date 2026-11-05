# Benchmark report

Generated 2026-11-05T21:20:07.112Z from `eval/results/latest-*.json`.

| | **baseline** | **optimized** | target (optimized) |
|---|---|---|---|
| Task success (end-to-end, state-checked) | 98.3% | 98.3% | ≥ 80% ✅ |
| Correct action selection | 100% | 100% | ≥ 85% ✅ |
| Expected-action recall | 100% | 100% |  |
| Parameter accuracy | 100% | 100% | ≥ 90% ✅ |
| TTFUR p50 — direct | 1.33s | 1.16s | ≤ 2.50s ✅ |
| TTFUR p95 — direct | 4.45s | 2.35s | ≤ 5.00s ✅ |
| TTFUR p50 — complex | 1.57s | 1.13s | ≤ 3.00s ✅ |
| TTFUR p95 — complex | 4.79s | 2.77s | ≤ 6.00s ✅ |
| First streamed text p50 — direct | 1.33s | 1.16s |  |
| First streamed text p50 — complex | 1.57s | 1.13s |  |
| E2E p50 — direct | 7.87s | 6.71s | ≤ 6.00s ❌ missed |
| E2E p95 — direct | 19.70s | 11.45s | ≤ 12.00s ✅ |
| E2E p50 — complex | 13.11s | 12.56s | ≤ 25.00s ✅ |
| E2E p95 — complex | 32.64s | 24.86s | ≤ 45.00s ✅ |
| Cost per request | $0.2073 | $0.0474 | ≤ $0.0500 ✅ |
| Cost per successful task | $0.2341 | $0.0536 | ≤ $0.0800 ✅ |
| Model calls per request | 3.5 | 3.5 | ≤ 3.5 ✅ |
| Input tokens per request (incl. cached) | 396,384 | 32,234 |  |
| Cache hit rate (input) | 98.2% | 86.2% | ≥ 40% ✅ |
| Total cost (all scenarios) | $27.1517 | $6.2162 |  |
| Retries | 0 | 0 |  |
| Errors | 0 | 0 |  |

**Test conditions:** baseline: model `claude-opus-5-5`, effort `medium`, 118 scenarios, concurrency 4, wall 342s, started 2026-11-05T21:02:56.453Z, Node v24.13.0 (12 scenarios that hit API errors were re-run at 2026-11-05T21:18:09.300Z and merged); optimized: model `claude-opus-5-5`, effort `low`, 118 scenarios, concurrency 4, wall 336s, started 2026-11-05T20:57:20.557Z, Node v24.13.0. Latency is per user turn, measured server-side from request receipt (no network/UI). TTFUR = first streamed text (progress note or answer) or first completed action result, whichever comes first; first-streamed-text is reported separately. Confirmations are auto-approved in evals, so E2E excludes human wait. Cost = list price × tokens (cache write 1.25×, cache read 0.1× input), including retries.

## Task success by category

| category | baseline | optimized |
|---|---|---|
| ambiguous | 8/9 | 8/9 |
| conditional | 9/9 | 9/9 |
| direct | 39/39 | 39/39 |
| failure | 8/9 | 8/9 |
| follow_up | 13/13 | 13/13 |
| indirect | 13/13 | 13/13 |
| multi_step | 21/21 | 21/21 |
| unsupported | 5/5 | 5/5 |

## Failures — baseline (2)

- **com-ambiguous-noah-invoice** (ambiguous): no writes (invoices.issue_invoice); asks clarification
- **com-failure-refund-over-balance** (failure): final state (refund request(s) created: 160)

## Failures — optimized (2)

- **com-ambiguous-noah-invoice** (ambiguous): no writes (invoices.send_invoice_reminder); asks clarification
- **com-failure-refund-over-balance** (failure): final state (refund request(s) created: 160)
