# Ask AI — natural-language agent over 50 modules / 500 actions

Ask AI is a chat agent for a simulated CRM / business platform. It understands direct, indirect, multi-step, conditional and follow-up requests, picks the right actions from a catalog of **50 modules × 10 actions**, executes them against a stateful mock platform, asks for confirmation before risky operations, and reports what actually happened.

- **Backend:** Node.js (ESM, Express 5), Anthropic Claude via `@anthropic-ai/sdk` (default `claude-opus-5-5`, effort `low`)
- **Frontend:** Vue 3 + Vite chat UI with live progress (streamed text + per-action ledger + confirmation cards + per-run latency/cost)
- **Platform:** 500 executable, validated, stateful handlers over deterministic synthetic data
- **Evaluation:** 500-handler smoke test, oracle-validated scenario set, retrieval recall test, LLM benchmark (baseline vs optimized) with p50/p95 latency, token/cost accounting and state-checked quality

| deliverable | where |
|---|---|
| Chat UI + backend | `web/` (Vue 3) · `server/src/` (Node/Express, agent loop) |
| 50 modules / 500 actions with executable handlers | `server/src/catalog/modules/` · full list with signatures: [`docs/CATALOG.md`](docs/CATALOG.md) |
| Synthetic data + reproducible reset/seed | `server/src/store/` (seeded PRNG, fixed clock) · **Reset data** button / `POST /api/reset` |
| Evaluation dataset (118 scenarios, all 50 modules) | `server/eval/scenarios/` · readable index: [`docs/EVAL_DATASET.md`](docs/EVAL_DATASET.md) |
| Benchmark report (latency, cost, quality; baseline vs optimized) | [`server/eval/BENCHMARK.md`](server/eval/BENCHMARK.md) · raw results `server/eval/results/` · execution traces `server/eval/traces/` |
| Performance targets (fixed before the benchmark ran) | [`server/eval/targets.js`](server/eval/targets.js) |

---

## Quick start

```bash
cd ask-ai
npm install
cp .env.example .env          # set ANTHROPIC_API_KEY=...
npm run dev                   # API on :8787, UI on http://localhost:5173
```

Production-style single process: `npm start` (builds the UI and serves it from the API on :8787).

| command | what it does | needs API key |
|---|---|---|
| `npm run smoke` | runs all 500 handlers: example input succeeds, output matches schema, writes change state / reads don't, bad input and unknown ids are rejected | no |
| `npm run oracle -w server` | validates every eval scenario: its reference solution passes all assertions, and the state assertion fails on the untouched seed | no |
| `npm run retrieval -w server` | retrieval recall@K of expected actions over the scenario set | no |
| `npm run filters -w server` | property test of every search/list filter (boolean partitions, enum values, field matches) | no |
| `npm test` | smoke + filters + agent-loop test (scripted fake model: gating, stale confirmations, bulk-per-turn, progress streaming, atomic rollback, empty replies, step cap across confirmations, client abort) + oracle + retrieval | no |
| `npm run eval -w server -- --strategy optimized` | LLM benchmark over all scenarios (also `--strategy baseline`, `--filter`, `--limit`, `--concurrency`) | yes |
| `npm run report -w server` | builds `server/eval/BENCHMARK.md` from the latest results | no |
| `npm run benchmark` | both strategies over all scenarios, then the report (estimated $35–40 for both at Opus 5.5 list price, mostly the baseline) | yes |
| `npm run dataset -w server` | regenerates `docs/EVAL_DATASET.md` from the scenario files | no |
| `npm run catalog -w server` | regenerates `docs/CATALOG.md` (all 500 action signatures) | no |
| `npm run seed -w server` | prints seeded row counts (data is rebuilt deterministically on every server start / reset) | no |

Environment variables (`.env` at repo root): `ANTHROPIC_API_KEY` (required for chat/eval), `ASK_AI_MODEL` (default `claude-opus-5-5`), `ASK_AI_EFFORT` (default `low`), `ASK_AI_NOW` (simulated clock, default `2026-11-04T10:00:00Z`), `PORT` (default 8787).

---

## Architecture

```
 Vue chat UI ──POST /api/chat, /api/confirm──▶ Express (NDJSON event stream)
     ▲  text deltas · action_start/end · confirm · done(metrics)        │
     └───────────────────────────────────────────────────────────────────┤
                                                                         ▼
                         ┌──────────────────── Agent loop (src/agent/agent.js) ────────────────────┐
 user turn ─▶ retrieval ─┤ 1. retrieveForTurn(): BM25 + synonyms + typo fix, per clause (≈1 ms)    │
                         │ 2. Claude call: static system prompt + 2 meta-tools (cached) +          │
                         │    <candidate_actions> cards + history                                  │
                         │ 3. tool calls ─▶ resolve ─▶ validate (zod) ─▶ gate? ─▶ execute          │
                         │      search_actions(q)  → more action cards                             │
                         │      execute_action(id, input) → handler result (compacted)             │
                         │ 4. loop until final answer / confirmation needed / step limit           │
                         └──────────────────────────────────────┬──────────────────────────────────┘
                                                                ▼
             Registry (src/catalog/registry.js) — auto-loads modules/mNN-*.js, validates 50×10,
             derives JSON schemas + compact signature cards, executes with validation + audit log
                                                                ▼
             Store (src/store/db.js) — in-memory tables, deterministic seed (PRNG, fixed clock), reset
```

### Agent design

**Retrieval-augmented meta-tools (the core latency/cost decision).** Sending 500 native tool schemas costs ~tens of thousands of input tokens per model call and makes selection harder. Instead the model gets two *static* tools — `search_actions(query, module?)` and `execute_action(action, input)` — and each user turn is prefixed with the top-K (24) candidate actions as one-line signature cards, e.g.

```
invoices.list_overdue_invoices(minDaysOverdue?: integer, contactId?: string, notRemindedSince?: string, limit?: integer) [read] — Invoices: List overdue invoices. Unpaid issued invoices past their due date, ...
```

Because the tool list and system prompt never change, they stay byte-identical and prompt-cacheable across every request; history is append-only so the conversation prefix caches too. If candidates miss something, the model calls `search_actions` (same index, any phrasing, optional module filter).

**Loop.** Manual streaming tool-use loop (`messages.stream` + `finalMessage()`): executes independent tool calls from the same response in one batch, feeds results back, stops on final text, refusal, confirmation, output-limit (`incomplete`), or a 14-step cap. On Opus 5.5 the narration the model writes before a tool call ("I'll look up last week's leads…") arrives as *progress-update thinking blocks*, which are empty by default — the agent requests `thinking.display: "updates"` (beta `thinking-display-updates-2026-08-18`) and streams them to the UI as progress lines, so the first useful text arrives in the first call. Tool inputs are validated with zod before execution (eager input streaming is on, so the client owns validation); validation/business errors go back to the model as `is_error` tool results with a recoverable message (current state, allowed states, the action's signature), so it can self-correct.

**Reliability.**
- Every write action is atomic: the registry snapshots the store and rolls back if a handler fails half-way.
- The transcript is append-only (required by Opus 5.5's preserved-thinking check and good for caching); refusals and errors never leave an unanswered `tool_use`.
- One request per session at a time (HTTP 409 otherwise).
- Transient API errors (429/5xx/network) are retried with backoff by the agent itself (SDK retries off), so retries are counted and their latency/cost attributed.
- Sessions are LRU-capped; data reset clears them; session ids are validated before they touch the filesystem (trace files).
- A client disconnect aborts the in-flight model call and stops the loop, so closed tabs don't keep spending.

**Confirmations.** Every action declares `risk`: `read | write | destructive | external`. Destructive (archive, delete, void, cancel, merge, revoke…), external (send, publish, launch, invite, refund execution…) and bulk (more than 10 writes within one user turn, counted across steps) calls are held; safe calls in the same step still run. The UI shows a confirmation card; approve/decline resumes the loop with real results or a `DECLINED` result. Each pending confirmation carries a one-time token, so a stale card can never approve a newer request; a new message instead of a decision cancels the pending calls.

**Clarification & honesty.** The system prompt (src/agent/prompt.js) tells the model to resolve names via search (never invent ids), ask one focused question only when a missing value has no sensible default or ambiguity changes the outcome, never present failed/unexecuted steps as done, and say plainly when no action can do something. These are measured by `ambiguous`, `unsupported` and `failure` scenarios (no writes allowed / reply checks).

**Context management.**
- History is append-only (cache-friendly) and includes prior tool results, so follow-ups ("make those due tomorrow") act on the records already created.
- Tool results are compacted (nulls/empties/`updatedAt` dropped; long strings clipped only inside search lists — single-record reads keep full text so edits never write back truncated content; searches capped by `limit`, with `total`/`truncated`).
- A rolling working set is attached to each turn: recently touched records (`<recent_records>`) and the filters of recent lookups with their result counts (`<recent_lookups>`), so follow-ups like "only the Facebook ones" refine the same query.
- Short follow-ups reuse the previous request's vocabulary for retrieval.
- When history exceeds ~60k tokens it is compacted to a summary of previous requests/answers + the working set.
- Relative dates are resolved against a fixed simulated clock stated in the system prompt (this week / last week / tomorrow spelled out).

### Module catalog and registration

- One file per module: `server/src/catalog/modules/mNN-<slug>.js` exporting `defineModule({ id, code, name, description, tables, actions, seed })`. Dropping a file in registers it — the agent core never changes. Conventions + the shared data contract: `server/src/catalog/CONVENTIONS.md`.
- Each action: `id, name, description, keywords?, risk, input (zod), output (zod), handler(input, ctx), example(ctx)`. Factories in `src/catalog/kit.js` cover CRUD/state-machine shapes (`ops.create/get/search/update/set/transition/addItem/updateItem/removeItem/reorder`); everything else is a custom handler with real business rules (conflict detection, inventory reservation, prerequisite checks, refundable balances, SLA math, live report metrics…).
- The registry validates 50 modules × 10 actions, unique ids, risk levels, schemas; derives JSON Schema (`z.toJSONSchema`) and the compact signature card; executes with input validation, typed error codes (`NOT_FOUND, VALIDATION, INVALID_STATE, DUPLICATE, CONFLICT, LIMIT_EXCEEDED, PERMISSION…`) and an audit log entry for every write.
- Full list with signatures: [`docs/CATALOG.md`](docs/CATALOG.md).

### What is real vs mocked

| real | mocked / simulated |
|---|---|
| LLM calls (Anthropic API), streaming, tool use, prompt caching, token/cost accounting | The business platform: 500 handlers over an in-memory store (no HighLevel APIs) |
| Retrieval index, validation, confirmation gating, context management | Externally visible effects (SMS/email delivery, payments, publishing, directory sync) are recorded as state changes with simulated outcomes (e.g. card ending 0002 declines) |
| Evaluation harness, assertions on final data state, latency measurement | Synthetic data from a seeded PRNG and a fixed clock (2026-11-04T10:00Z), rebuilt on reset |

---

## Evaluation

See `server/eval/`. Scenario files (`eval/scenarios/*.js`) each declare turns, expected actions (with acceptable alternatives), forbidden actions, expected parameters, final-state assertions computed from data (`eval/fixtures.js`), clarification / no-write / confirmation / reply checks, and an **oracle** — a reference solution executed without the LLM to prove the assertions are satisfiable and non-tautological.

Categories: `direct, indirect, multi_step, conditional, follow_up, ambiguous, unsupported, failure` across all 50 modules.

Metrics (per strategy, `eval/summary.js`):
- **Quality:** task success (all checks incl. final state), correct action selection (all expected actions executed, none forbidden, no unexpected writes), expected-action recall, parameter accuracy.
- **Latency:** per user turn, p50/p95 of time-to-first-useful-response (first streamed answer text or first completed action) and end-to-end, separately for direct and complex (multi_step + conditional) requests.
- **Cost:** input/output/cache tokens, model calls, retries, list-price cost per request and per successful task.

Results: [`server/eval/BENCHMARK.md`](server/eval/BENCHMARK.md) · raw: `server/eval/results/latest-*.json` · traces: `server/eval/traces/<strategy>/<scenario>.json` (every model call, action, input, result status, timing).

Targets were fixed before running (`server/eval/targets.js`).

Offline results (reproducible without an API key, `npm test`):

| check | result |
|---|---|
| Handler smoke test | **500/500** handlers pass (success path, output schema, state change, rejection of bad input / unknown ids) |
| Scenario set | **118** scenarios, all 50 modules; direct 39 · indirect 13 · multi-step 21 · follow-up 13 · conditional 9 · ambiguous 9 · unsupported 5 · failure 9; **118/118** oracle-valid and non-tautological |
| Agent loop (scripted fake model) | gating, approve/decline, stale-token rejection, interrupted confirmation, bulk gate across steps, validation errors with signature, progress streaming, atomic rollback, empty replies, step cap across confirmations, client abort, baseline mode — all pass |
| Filter property test (every search/list filter: boolean partitions, enum values, field matches) | **363/363** |
| Retrieval recall@24 (expected actions present in the per-turn candidate cards) | **85.8%** of actions, 77.2% of scenarios fully covered — the rest is reachable through the cached catalog index / `search_actions`. The synonym list is generic CRM vocabulary; it was deliberately *not* tuned on eval misses |

LLM benchmark (baseline vs optimized on the same 118 scenarios): see [`server/eval/BENCHMARK.md`](server/eval/BENCHMARK.md).

### Cost model, cache behaviour and test conditions

- **Model:** `claude-opus-5-5` (override with `ASK_AI_MODEL`), adaptive thinking (always on for this model), `output_config.effort` = `low` (optimized) / `medium` (baseline). `max_tokens` 16k per call, streaming.
- **Pricing assumptions** (`server/src/config.js`, Anthropic list prices cached 2026-10-06, USD / 1M tokens): Opus 5.5 $4 in / $20 out; Sonnet 5.5 $2 / $10; Haiku 5.5 $0.10 / $0.50. Cache writes (5-min TTL) billed at 1.25× input, cache reads at 0.1× input. Cost per call = Σ tokens × price from the API's own `usage` (input, output, cache_creation, cache_read); thinking tokens are included in output tokens. Failed HTTP attempts are not billed by the API; they are counted as retries and their latency is included.
- **Cache behaviour:** the request prefix is `tools → system → messages`. In the optimized strategy the tool list (2 meta-tools) and the system prompt (rules + catalog index) are byte-identical across all requests, with an explicit breakpoint on the system block; top-level automatic caching adds a breakpoint at the end of the (append-only) conversation, so each model call in a loop re-reads the previous call's prefix from cache. Minimum cacheable prefix on Opus 5.5 is 512 tokens. The baseline caches its 500-tool prefix the same way. Hit rate is reported per run (`cacheHitRate`).
- **Test conditions** (recorded in each results file and BENCHMARK.md): scenario set, model, effort, concurrency (worker threads, default 4), wall time, Node version, start time. Latency is measured server-side per user turn from request receipt; confirmations are auto-approved (except decline scenarios), so E2E excludes human think time.

---

## Trade-offs

| decision | latency | cost | quality |
|---|---|---|---|
| Meta-tools + per-turn candidate cards instead of 500 native tools | far fewer input tokens to process per call (≈1.8k tokens of cards vs ≈68k of schemas) → lower time-to-first-token | fewer billed tokens; static tool list + system prompt cache across all requests | candidates can miss → mitigated by the cached catalog index and `search_actions` (one extra round trip when used) |
| Cached catalog index of all 500 action ids in the system prompt (~2.8k tokens) | none after first write | ~$0.001/call at cache-read price | lets the model match paraphrases semantically across the whole catalog without an embedding service |
| Lexical retrieval (BM25 + synonyms + typo correction + per-clause + module lookups) instead of embeddings / an LLM router | ~1–2 ms, no network | free | recall@24 85.8%; weaker on heavy paraphrase — the model-side index is the backstop |
| Effort `low` on Opus 5.5 | fewer thinking tokens → faster first text and fewer, consolidated tool calls | fewer output tokens | measured against baseline `medium` in BENCHMARK.md |
| Parallel tool calls + batched execution of a step | fewer model round trips for fan-out work (e.g. 5 tasks in one step) | fewer calls | — |
| Compacted tool results (drop nulls/empties/`updatedAt`, clip strings, capped lists) | smaller follow-up prompts | fewer input tokens | `total`/`truncated` tell the model when to refine filters |
| Confirmation gate on destructive/external/bulk writes | adds a human step only where it matters | — | prevents irreversible mistakes; safe calls in the same step still run |
| One-sentence plan before acting | first useful text in a single streamed call | a few output tokens | user sees intent immediately and can interrupt |

The baseline sends all 500 tools natively (still prompt-cached — no realistic deployment would re-bill 68k tokens per call), default effort `medium`, raw tool results, no retrieval.

## Known limitations

- **Synthetic platform.** Handlers enforce realistic rules but are simplified (all times UTC for availability; tax not added to order totals; no real delivery/payments).
- **In-memory, single process.** Sessions and data live in memory; restart = reseed. Eval workers each hold their own copy.
- **Shared seed RNG.** All module seeds draw from one PRNG in seed order, so editing an early module's seed shifts later random values. Scenario assertions derive expectations from data to stay robust; a per-module PRNG would remove the coupling.
- **Lexical retrieval** misses heavy paraphrases ("someone's pushing fake followers in the club") — the model recovers via the catalog index or `search_actions`, at the cost of an extra round trip.
- **Confirmation is all-or-nothing per step** (approve or decline every gated call in that step).
- **Compaction** uses a character-length estimate and a simple summary of previous turns; very long sessions lose detail from early tool results.
- **Evals** auto-approve confirmations (except the decline scenarios) and measure latency server-side, excluding network/UI.

## Scaling beyond 500 actions

- **Registration** is already O(1) per capability: drop a module file; the registry, retrieval index, docs and smoke test pick it up.
- **Retrieval** scales sub-linearly in cost: the model only ever sees K cards per turn regardless of catalog size. Beyond a few thousand actions, swap/add a vector index (same `retrieveForTurn` interface) and keep the lexical layer for exact names/typos.
- **The cached catalog index** is the part that grows with the catalog (~5.6 tokens/action). Past ~3–5k actions, switch it to a module-level index (module names + one-line descriptions) and let `search_actions(module=…)` expand a module on demand — two-level routing instead of a flat list.
- **Multi-tenant / per-user catalogs:** filter the index and retrieval by the user's permissions/installed modules (the risk metadata and `users.list_user_permissions` already model this).
- **Persistence & concurrency:** replace the in-memory store with a database behind the same `ctx` API (`all/get/insert/patch/remove`); sessions to Redis; the agent loop is stateless between requests apart from the session object.
- **Evals** shard across worker threads already; the same harness can run nightly with a fixed seed and alert on regressions in success rate, p95 latency or cost per successful task.
