import { defineModule, ops, z, id, entity, limit, fail, page } from '../kit.js';

const EVENTS = ['contact_created', 'lead_created', 'form_submitted', 'appointment_booked', 'appointment_cancelled', 'invoice_overdue', 'tag_added', 'payment_failed', 'survey_submitted', 'opportunity_stage_changed'];
const OPS = ['equals', 'not_equals', 'contains', 'gt', 'gte', 'lt', 'lte', 'in', 'exists'];
const ns = z.string().nullable().optional();
const condition = z.object({
  field: z.string().min(1).describe('dotted path in the event payload, e.g. source or invoice.daysOverdue'),
  operator: z.enum(OPS), value: z.any().optional().describe('comparison value (array for "in"; omit for "exists")'),
});
const trigger = entity({
  name: z.string(), eventType: z.enum(EVENTS).nullable(), conditions: z.array(z.looseObject({ field: z.string(), operator: z.enum(OPS) })),
  conditionLogic: z.enum(['all', 'any']), workflowId: ns, status: z.enum(['enabled', 'disabled']), lastFiredAt: ns,
  firings: z.array(z.looseObject({ id: z.string(), matched: z.boolean() })).optional(),
});

const at = (o, path) => path.split('.').reduce((v, k) => v?.[k], o);
const s = (x) => String(x ?? '').toLowerCase();
function evalCond(payload, c) {
  const v = at(payload, c.field);
  const x = c.value;
  switch (c.operator) {
    case 'equals': return Array.isArray(v) ? v.map(s).includes(s(x)) : s(v) === s(x);
    case 'not_equals': return Array.isArray(v) ? !v.map(s).includes(s(x)) : s(v) !== s(x);
    case 'contains': return Array.isArray(v) ? v.map(s).includes(s(x)) : s(v).includes(s(x));
    case 'gt': return Number(v) > Number(x);
    case 'gte': return Number(v) >= Number(x);
    case 'lt': return Number(v) < Number(x);
    case 'lte': return Number(v) <= Number(x);
    case 'in': return Array.isArray(x) && x.map(s).includes(s(v));
    case 'exists': return v !== undefined && v !== null && v !== '';
  }
}
/** Evaluate all conditions (no conditions = always matches). */
const evaluate = (t, payload) => {
  const results = t.conditions.map((c) => ({ ...c, actual: at(payload, c.field) ?? null, passed: evalCond(payload, c) }));
  const matched = !results.length || (t.conditionLogic === 'any' ? results.some((r) => r.passed) : results.every((r) => r.passed));
  return { matched, results };
};
const checkConditions = (conditions = []) => {
  const bad = conditions.filter((c) => (c.operator === 'in' ? !Array.isArray(c.value) : c.operator !== 'exists' && c.value === undefined));
  if (bad.length) fail('VALIDATION', `conditions need a value (an array for "in"): ${bad.map((c) => `${c.field} ${c.operator}`).join(', ')}`);
};
const byName = (ctx, n) => ctx.all('triggers').find((t) => t.name === n).id;
const wfId = (ctx, n) => ctx.all('workflows').find((w) => w.name === n)?.id ?? null;

export default defineModule({
  id: 'triggers',
  code: 'M17',
  name: 'Event Triggers',
  description: 'Configure which platform events (new lead, form submitted, invoice overdue...) start which workflows.',
  tables: { triggers: { prefix: 'trg', schema: trigger } },
  actions: [
    {
      id: 'create_event_trigger', name: 'Create event trigger',
      description: 'Create a (disabled) trigger that will start a workflow when a platform event happens, optionally with event type, payload conditions and a bound workflow.',
      keywords: ['new trigger', 'when this happens', 'automation trigger'],
      ...ops.create('triggers', {
        input: z.object({
          name: z.string().min(1), eventType: z.enum(EVENTS).optional(), workflowId: z.string().optional(),
          conditions: z.array(condition).optional(), conditionLogic: z.enum(['all', 'any']).optional(),
        }),
        check: (i, ctx) => {
          checkConditions(i.conditions);
          if (i.workflowId) ctx.get('workflows', i.workflowId, 'workflow');
        },
        build: (i) => ({ eventType: i.eventType ?? null, workflowId: i.workflowId ?? null, conditions: i.conditions ?? [], conditionLogic: i.conditionLogic ?? 'all', status: 'disabled', lastFiredAt: null, firings: [] }),
      }),
      example: () => ({ name: 'New Contact Welcome', eventType: 'contact_created' }),
    },
    {
      id: 'get_trigger', name: 'Get trigger configuration', description: 'Fetch a trigger: event type, conditions, bound workflow (with its status) and enabled state (firing log excluded; see firing history).',
      risk: 'read',
      input: z.object({ id: id('trigger') }),
      output: trigger,
      handler: ({ id: tid }, ctx) => {
        const { firings = [], ...t } = ctx.get('triggers', tid, 'trigger');
        const wf = t.workflowId && ctx.find('workflows', t.workflowId);
        return { ...t, workflow: wf ? { id: wf.id, name: wf.name, status: wf.status } : null, firingCount: firings.length };
      },
      example: (ctx) => ({ id: byName(ctx, 'New Facebook Lead') }),
    },
    {
      id: 'list_event_triggers', name: 'List event triggers', description: 'List event triggers, filterable by event type, enabled/disabled status, bound workflow or name text.',
      keywords: ['automation triggers', 'what starts workflow'],
      ...ops.search('triggers', {
        text: ['name'],
        filters: { eventType: z.enum(EVENTS).optional(), status: z.enum(['enabled', 'disabled']).optional(), workflowId: z.string().optional() },
      }),
      example: () => ({ status: 'enabled' }),
    },
    {
      id: 'set_trigger_event_type', name: 'Set trigger event type', description: 'Choose which platform event fires the trigger (e.g. lead_created, invoice_overdue, form_submitted).',
      ...ops.set('triggers', 'eventType', z.enum(EVENTS), { what: 'trigger' }),
      example: (ctx) => ({ id: byName(ctx, 'Untitled Trigger'), eventType: 'contact_created' }),
    },
    {
      id: 'update_trigger_conditions', name: 'Update trigger conditions',
      description: 'Replace the payload conditions a trigger event must satisfy (field/operator/value; all or any). An empty list means every event of the type fires.',
      keywords: ['trigger filter', 'only when'],
      risk: 'write',
      input: z.object({ id: id('trigger'), conditions: z.array(condition), conditionLogic: z.enum(['all', 'any']).optional() }),
      output: trigger,
      handler: ({ id: tid, conditions, conditionLogic }, ctx) => {
        const t = ctx.get('triggers', tid, 'trigger');
        checkConditions(conditions);
        return ctx.patch(t, { conditions, conditionLogic: conditionLogic ?? t.conditionLogic });
      },
      example: (ctx) => ({ id: byName(ctx, 'New Facebook Lead'), conditions: [{ field: 'source', operator: 'in', value: ['facebook', 'google_ads'] }] }),
    },
    {
      id: 'bind_trigger_to_workflow', name: 'Bind trigger to workflow', description: 'Set the workflow a trigger starts when it fires (replaces any previous binding).',
      keywords: ['connect trigger', 'link workflow'],
      ...ops.set('triggers', 'workflowId', id('workflow'), { param: 'workflowId', what: 'trigger', guard: (t, i, ctx) => {
        const wf = ctx.get('workflows', i.workflowId, 'workflow');
        // enable_trigger requires a published workflow; keep that invariant for already-enabled triggers.
        if (t.status === 'enabled' && wf.status !== 'published') fail('INVALID_STATE', `trigger ${t.id} is enabled but workflow ${wf.id} '${wf.name}' is ${wf.status}; publish the workflow first or disable the trigger`);
      } }),
      example: (ctx) => ({ id: byName(ctx, 'Contact Us Form Submitted'), workflowId: wfId(ctx, 'New Lead Nurture') }),
    },
    {
      id: 'enable_trigger', name: 'Enable trigger', description: 'Turn a trigger on. Requires an event type and a bound workflow that is published.',
      keywords: ['activate trigger', 'turn on trigger'],
      ...ops.transition('triggers', {
        to: 'enabled', from: ['disabled'], what: 'trigger',
        guard: (t, i, ctx) => {
          if (!t.eventType) fail('INVALID_STATE', `trigger ${t.id} has no event type; call set_trigger_event_type first`);
          if (!t.workflowId) fail('INVALID_STATE', `trigger ${t.id} is not bound to a workflow; call bind_trigger_to_workflow first`);
          const wf = ctx.get('workflows', t.workflowId, 'workflow');
          if (wf.status !== 'published') fail('INVALID_STATE', `bound workflow ${wf.id} '${wf.name}' is ${wf.status}; publish it before enabling the trigger`);
        },
      }),
      example: (ctx) => ({ id: byName(ctx, 'Invoice 7+ Days Overdue') }),
    },
    {
      id: 'disable_trigger', name: 'Disable trigger', description: 'Turn a trigger off so its events no longer start the workflow.',
      keywords: ['turn off trigger'],
      ...ops.transition('triggers', { to: 'disabled', from: ['enabled'], what: 'trigger' }),
      example: (ctx) => ({ id: byName(ctx, 'New Facebook Lead') }),
    },
    {
      id: 'test_trigger', name: 'Test trigger with sample event',
      description: 'Dry-run a trigger against a sample event payload: evaluates each condition, records a test firing in the history, and reports whether it would start the bound workflow. Does not run the workflow.',
      keywords: ['simulate event', 'dry run trigger'],
      risk: 'write',
      input: z.object({ id: id('trigger'), samplePayload: z.record(z.string(), z.any()).describe('event payload, e.g. {"source":"facebook","leadId":"ld_001"}') }),
      output: z.looseObject({ triggerId: z.string(), matched: z.boolean(), conditionResults: z.array(z.looseObject({ passed: z.boolean() })) }),
      handler: ({ id: tid, samplePayload }, ctx) => {
        const t = ctx.get('triggers', tid, 'trigger');
        if (!t.eventType) fail('INVALID_STATE', `trigger ${t.id} has no event type; call set_trigger_event_type first`);
        const { matched, results } = evaluate(t, samplePayload);
        const firing = { id: ctx.newId('trf'), at: ctx.now, test: true, eventType: t.eventType, matched, payload: samplePayload, workflowRunStarted: false };
        (t.firings ||= []).push(firing);
        ctx.patch(t, {});
        return { triggerId: t.id, eventType: t.eventType, matched, conditionResults: results, wouldStartWorkflowId: matched ? t.workflowId : null, triggerStatus: t.status, firing };
      },
      example: (ctx) => ({ id: byName(ctx, 'New Facebook Lead'), samplePayload: { source: 'facebook', leadId: 'ld_001' } }),
    },
    {
      id: 'get_trigger_firing_history', name: 'Get trigger firing history',
      description: 'Log of a trigger\'s firings (real events and tests), newest first: event payload, whether conditions matched and whether a workflow run started.',
      keywords: ['trigger log', 'did trigger fire'],
      risk: 'read',
      input: z.object({ id: id('trigger'), matched: z.boolean().optional(), includeTests: z.boolean().default(true), limit }),
      output: z.looseObject({ triggerId: z.string(), total: z.number(), items: z.array(z.looseObject({ id: z.string(), matched: z.boolean() })) }),
      handler: ({ id: tid, matched, includeTests, limit: lim }, ctx) => {
        const t = ctx.get('triggers', tid, 'trigger');
        const rows = (t.firings || []).filter((f) => (matched === undefined || f.matched === matched) && (includeTests || !f.test)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
        return { triggerId: t.id, name: t.name, ...page(rows, lim) };
      },
      example: (ctx) => ({ id: byName(ctx, 'New Facebook Lead') }),
    },
  ],

  seed(ctx, h) {
    const rows = [
      ['New Facebook Lead', 'lead_created', [{ field: 'source', operator: 'equals', value: 'facebook' }], 'New Lead Nurture', 'enabled'],
      ['Appointment Booked', 'appointment_booked', [], 'Appointment Reminders', 'enabled'],
      ['Invoice 7+ Days Overdue', 'invoice_overdue', [{ field: 'daysOverdue', operator: 'gte', value: 7 }], 'Invoice Overdue Follow-up', 'disabled'],
      ['Contact Us Form Submitted', 'form_submitted', [{ field: 'formName', operator: 'equals', value: 'Contact Us' }], null, 'disabled'],
      ['VIP Tag Added', 'tag_added', [{ field: 'tag', operator: 'equals', value: 'vip' }], 'Webinar Follow-up', 'disabled'],
      ['Payment Failed', 'payment_failed', [], null, 'disabled'],
      ['Untitled Trigger', null, [], null, 'disabled'],
    ];
    const sources = ['facebook', 'facebook', 'facebook', 'google_ads', 'website'];
    for (const [name, eventType, conditions, wf, status] of rows) {
      const t = { name, eventType, conditions, conditionLogic: 'all', workflowId: wf ? wfId(ctx, wf) : null, status, lastFiredAt: null, firings: [], createdAt: h.daysAgo(h.int(60, 120)) };
      for (let k = 0; status === 'enabled' && k < 5; k++) {
        const payload = eventType === 'lead_created' ? { leadId: `ld_${String(k + 1).padStart(3, '0')}`, source: sources[k] } : { appointmentId: `apt_${String(k + 1).padStart(3, '0')}` };
        const matched = evaluate(t, payload).matched;
        t.firings.push({ id: ctx.newId('trf'), at: h.daysAgo(h.int(1, 20)), test: false, eventType, matched, payload, workflowRunStarted: matched });
      }
      t.lastFiredAt = t.firings.map((f) => f.at).sort().at(-1) ?? null;
      ctx.insert('triggers', t);
    }
  },
});
