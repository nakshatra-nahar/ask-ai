# Module authoring conventions

Every module is one file `src/catalog/modules/mNN-<slug>.js` with a default export `defineModule({...})`.
The registry auto-loads every `mNN-*.js` file — no other file needs editing to register a module.
Reference implementations: `m01-contacts.js`, `m48-users.js`, `m49-teams.js`, `m06-tasks.js`, `m28-invoices.js`.
Kit (factories, zod helpers, `fail`): `src/catalog/kit.js`. Store/ctx: `src/store/db.js`.

## Module shape
```js
export default defineModule({
  id: 'leads', code: 'M03', name: 'Leads', description: 'Capture, qualify, and route prospective customers.',
  tables: { leads: { prefix: 'ld', schema: leadSchema } },   // every table this module OWNS
  actions: [ /* exactly 10, in catalog order */ ],
  seed(ctx, h) { /* deterministic synthetic data */ },
});
```

## Action shape
```js
{
  id: 'create_lead',                // snake_case, unique in module; full id = `${module.id}.${id}`
  name: 'Create lead',              // EXACT catalog name
  description: '...',               // 1-2 sentences. Say what distinguishes it from look-alikes in other modules.
  keywords: ['new prospect'],       // optional synonyms that help retrieval
  risk: 'read'|'write'|'destructive'|'external',
  input: z.object({...}),           // zod; use .describe() on non-obvious params
  output: zodSchema,                // optional when using a factory on an owned table (derived)
  handler: (input, ctx) => result,  // or spread a factory: ...ops.create('leads', {...})
  example: (ctx) => input,          // REQUIRED: valid input that succeeds on a fresh seed
}
```
Risk: `read` no state change · `write` internal reversible change · `destructive` delete/archive/void/cancel/merge/revoke/remove-with-data-loss · `external` visible outside the account (send, publish, launch, charge, refund execution, invite).
The agent asks the user to confirm destructive/external actions — so classify honestly.

## Rules
- Handlers must be **stateful and meaningful**: reads return real records/derived data; writes mutate `ctx` tables. Never "always success".
- Enforce business rules with `fail(code, message)`. Codes: `NOT_FOUND`, `VALIDATION`, `INVALID_STATE`, `DUPLICATE`, `CONFLICT`, `LIMIT_EXCEEDED`, `INSUFFICIENT_BALANCE`, `PERMISSION`. Messages must tell the model how to recover (e.g. current state, allowed states).
- Validate cross-module references with `ctx.get(table, id, 'what')` (throws NOT_FOUND).
- Time: use `ctx.now` / `ctx.today` (fixed simulated clock 2026-11-04T10:00:00Z, a Wednesday). Never `Date.now()`/`new Date()` without args, never `Math.random()`.
- `ctx.all(t)` reads (does not create a table). `ctx.insert(t, rec)` creates with auto id/createdAt/updatedAt. `ctx.patch(rec, changes)` updates. `ctx.remove(t, id)` hard-deletes.
- Searches return `{ total, items, truncated? }` via `ops.search` or `page(rows, limit)`. Filters that are not record fields (e.g. `overdue`, `unassigned`) must be listed in `ops.search({ virtual: [...] })` and handled in `where`. Money: use `round2` from the kit. Search filters follow `matchFilters` naming: `field`, `fieldAfter/fieldBefore` (dates), `fieldMin/fieldMax` (numbers), `fieldIds` (array of ids for `fieldId`).
- Seeds: deterministic, only via `h` (`h.int, h.pick, h.chance, h.sample, h.daysAgo(n), h.daysFromNow(n)`) and `ctx.insert`. 6–40 rows per main table. Include realistic edge cases (archived/draft/failed/overdue states) so failure paths are reachable. A seed may read tables seeded earlier (see seed order) but must tolerate them being empty.
- Seed order: users, teams, contacts, companies, campaigns, leads, pipelines, opportunities, calendars, availability, appointments, conversations, templates, sms, email, products, prices, tax_rules, invoices, payments, then all other modules in catalog order.
- Id prefixes are 2-4 lowercase letters and globally unique (table below). Ids render as `prefix_001`.
- Keep the core (`kit.js`, `registry.js`, `db.js`) module-agnostic: adding a module never requires editing it. Behaviour shared by several modules belongs in the kit or is exported from the owning module.
- Verify with `node eval/smoke.js <moduleId>` (per module) until 10/10 pass.

## Shared tables contract (cross-module fields — keep these names)
| table (owner) | prefix | key fields |
|---|---|---|
| users (M48) | usr | name, email, roles[] (admin, manager, sales_rep, support, marketing, billing), status invited/active/deactivated, outOfOffice. Seeds: usr_001 Alex Morgan admin+manager; usr_002 Jordan Lee, usr_003 Priya Shah, usr_005 Dana Cruz active sales reps; usr_004 Marcus Reed sales rep **out of office**; usr_006 Sam Taylor, usr_007 Riley Kim support; usr_008 Morgan Blake marketing; usr_009 Chris Park deactivated rep; usr_010 invited; usr_011 Jamie Fox billing |
| teams (M49) | tm | name, memberIds[], managerId, assignmentStrategy, status. tm_001 Sales, tm_002 Support, tm_003 Marketing |
| contacts (M01) | con | firstName, lastName, name, email, phone, companyId, ownerId, tags[] (tag names), source, status active/archived/merged, lifecycleStage, preferences{email,sms,call}. 80 rows. con_001 Sarah Johnson (customer, vip), con_002 Sarah Chen (lead), con_003 Michael Smith + con_004 Mike Smith (duplicates, same phone), con_005 Olivia Martin (sms+call opted out) |
| activity (registry) | act | at, actorId, action, summary, refs[] — auto-logged for every write |
| tasks (M06) | tsk | title, description, contactId, recordType, recordId, ownerId, dueDate (YYYY-MM-DD), priority low/medium/high, status open/completed/cancelled |
| invoices (M28) | inv | number, contactId, status draft/sent/partially_paid/paid/void, issueDate, dueDate (YYYY-MM-DD), currency, lineItems[{id, description, productId, quantity, unitPrice, amount}], subtotal, discount, tax, total, amountPaid, balance, remindersSent[{at, channel, messageId}], lastReminderAt |
| companies (M02) | co | name, domain, industry, phone, address, accountManagerId, status active/archived/merged. Membership = contacts.companyId |
| leads (M03) | ld | contactId, name, email, phone, source (facebook, google_ads, website, referral, webinar, walk_in), campaignId, status new/contacted/qualified/disqualified/converted, score 0-100, ownerId (null = unassigned), qualification{}, disqualifyReason, opportunityId |
| pipelines (M05) | pl | name, status active/archived, stages[{id ('stg_###' via ctx.newId('stg')), name, probability, order}], isDefault |
| opportunities (M04) | opp | name, contactId, companyId, leadId, pipelineId, stageId, value, currency, status open/won/lost, ownerId, expectedCloseDate, lostReason, closedAt |
| notes (M07) | nt | body, recordType (table name e.g. 'contacts'), recordId, contactId, pinned, authorId, revisions[] |
| tags (M08) | tag | name, color, status. Applied tags live in the target record's `tags` string array |
| conversations (M11) | cnv | contactId, channel sms/email/webchat, status open/closed, unread, ownerId, lastMessageAt, lastInboundAt, lastOutboundAt, lastDirection inbound/outbound, comments[] |
| messages (declared by M12 SMS, shared with M13 Email) | msg | channel sms/email, direction inbound/outbound, contactId, conversationId, to, from, subject, body, status draft/scheduled/sent/delivered/failed/cancelled/received, scheduledAt, sentAt, deliveredAt, failureReason, templateId, relatedType, relatedId, purpose (e.g. 'invoice_reminder', 'follow_up') |
| templates (M14) | tpl | name, channel email/sms, subject, body with {{var}} placeholders, variables[], status active/archived, versions[] |
| campaigns (M15) | cam | name, channel email/sms/facebook/google/multi, status draft/scheduled/active/paused/completed, audience{}, steps[], schedule{}, stats{} |
| calendars (M20) | cal | name, timezone, hostUserIds[], durationMin, bufferMin, visibility, status active/archived |
| appointments (M21) | apt | calendarId, contactId, hostUserId, title, startAt, endAt (ISO), status booked/confirmed/cancelled/completed/no_show, attendees[] |
| products (M25) | prd | name, description, sku, status active/archived, variants[], inventory{quantity, tracked}, defaultPriceId, taxCategory |
| prices (M26) | pri | productId, label, amount, currency, interval one_time/month/year, trialDays, status |
| payments (M29) | pay | contactId, invoiceId, amount, currency, method, status pending/succeeded/failed/refunded/partially_refunded, allocations[{invoiceId, amount}], refundedAmount, failureCode, failureMessage, paidAt |
| tickets (M47) | tkt | subject, contactId, ownerId, priority, status, slaDueAt |

Other prefixes (reserve these exactly): smart_lists sl, custom_fields cf, workflows wf, triggers trg, forms frm, form_submissions fsub, surveys srv, survey_responses sres, availability avl, booking_pages bp, events evt, quotes quo, payment_requests preq, subscriptions sub, coupons cpn, orders ord, refunds rfd, tax_rules tax, tax_exemptions txe, websites web, funnels fnl, landing_pages lp, blog_posts blog, media med, courses crs, lessons les, enrollments enr, certificates cert, communities cmty, community_posts post, membership_plans mpl, memberships mem, reviews rev, review_requests rrq, listings lst, reports rpt, report_exports rexp. Item ids inside arrays: use `ctx.newId('<short>')` with a unique 2-4 letter prefix.
