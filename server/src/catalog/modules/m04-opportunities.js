import { defineModule, ops, z, id, entity, isoDate, money, fail } from '../kit.js';

const STATUS = ['open', 'won', 'lost'];
const opportunity = entity({
  name: z.string(), contactId: z.string().nullable(), companyId: z.string().nullable().optional(), leadId: z.string().nullable().optional(),
  pipelineId: z.string(), stageId: z.string(), value: z.number(), currency: z.string(), status: z.enum(STATUS),
  ownerId: z.string().nullable().optional(), expectedCloseDate: z.string().nullable().optional(),
  lostReason: z.string().nullable().optional(), closedAt: z.string().nullable().optional(),
});

function activeUser(ctx, uid) {
  const u = ctx.get('users', uid, 'user');
  if (u.status !== 'active') fail('INVALID_STATE', `user ${uid} (${u.name}) is ${u.status} and cannot own opportunities; pick an active user`);
  return u;
}
const isOpen = (o) => {
  if (o.status !== 'open') fail('INVALID_STATE', `opportunity ${o.id} is ${o.status}; reopen it first with opportunities.reopen_opportunity`);
};
// Accepts a stage id or exact stage name; the stage must belong to pipeline `p`.
const stageIn = (p, ref) =>
  p.stages.find((s) => s.id === ref || s.name.toLowerCase() === ref.toLowerCase()) ||
  fail('VALIDATION', `stage '${ref}' is not in pipeline ${p.name} (${p.id}); valid stages: ${p.stages.map((s) => `${s.id} ${s.name}`).join(', ')}`);

export default defineModule({
  id: 'opportunities',
  code: 'M04',
  name: 'Opportunities',
  description: 'Track individual deals through the sales process.',
  tables: { opportunities: { prefix: 'opp', schema: opportunity } },
  actions: [
    {
      id: 'create_opportunity', name: 'Create opportunity',
      description: 'Create a deal for a contact in a pipeline stage (defaults: default pipeline, its first stage, contact\'s company and owner). To turn an existing lead into a deal use leads.convert_lead instead.',
      keywords: ['new deal', 'add deal', 'open opportunity'],
      ...ops.create('opportunities', {
        input: z.object({
          name: z.string().min(1), contactId: id('contact'), value: money.describe('deal value'), currency: z.string().length(3).optional(),
          pipelineId: z.string().optional().describe('defaults to the default pipeline'),
          stageId: z.string().optional().describe('stage ID or name in that pipeline; defaults to the first stage'),
          ownerId: z.string().optional(), expectedCloseDate: isoDate().optional(), companyId: z.string().optional(), leadId: z.string().optional(),
        }),
        build: (i, ctx) => {
          const c = ctx.get('contacts', i.contactId, 'contact');
          if (c.status === 'merged') fail('INVALID_STATE', `contact ${c.id} was merged into ${c.mergedInto}; use ${c.mergedInto} instead`);
          const p = i.pipelineId
            ? ctx.get('pipelines', i.pipelineId, 'pipeline')
            : ctx.all('pipelines').find((x) => x.isDefault && x.status === 'active') || fail('NOT_FOUND', 'no default pipeline; pass pipelineId (see pipelines.list_pipelines)');
          if (p.status !== 'active') fail('INVALID_STATE', `pipeline ${p.name} is archived; choose an active pipeline`);
          const s = i.stageId ? stageIn(p, i.stageId) : p.stages[0] || fail('INVALID_STATE', `pipeline ${p.name} has no stages`);
          if (i.ownerId) activeUser(ctx, i.ownerId);
          const co = i.companyId && ctx.get('companies', i.companyId, 'company');
          if (co?.status === 'merged') fail('INVALID_STATE', `company ${co.id} was merged into ${co.mergedInto}; use ${co.mergedInto} instead`);
          const lead = i.leadId && ctx.get('leads', i.leadId, 'lead');
          if (lead?.contactId && lead.contactId !== c.id) fail('VALIDATION', `lead ${lead.id} belongs to contact ${lead.contactId}, not ${c.id}`);
          return {
            pipelineId: p.id, stageId: s.id, currency: (i.currency || 'USD').toUpperCase(), companyId: i.companyId ?? c.companyId ?? null,
            leadId: i.leadId ?? null, ownerId: i.ownerId ?? c.ownerId ?? null, expectedCloseDate: i.expectedCloseDate?.slice(0, 10) ?? null,
            status: 'open', lostReason: null, closedAt: null,
          };
        },
      }),
      example: (ctx) => ({ name: 'Website Redesign', contactId: ctx.all('contacts')[0].id, value: 7500, expectedCloseDate: '2026-12-15' }),
    },
    {
      id: 'get_opportunity', name: 'Get opportunity details',
      description: 'Fetch one deal by ID with its pipeline and stage names, stage win probability, contact name and owner name.',
      risk: 'read',
      input: z.object({ id: id('opportunity') }),
      output: opportunity,
      handler: ({ id: oid }, ctx) => {
        const o = ctx.get('opportunities', oid, 'opportunity');
        const p = ctx.find('pipelines', o.pipelineId);
        const s = p?.stages.find((x) => x.id === o.stageId);
        return {
          ...o, pipelineName: p?.name ?? null, stageName: s?.name ?? null, probability: s?.probability ?? null,
          contactName: ctx.find('contacts', o.contactId)?.name ?? null, ownerName: ctx.find('users', o.ownerId)?.name ?? null,
        };
      },
      example: (ctx) => ({ id: ctx.all('opportunities')[0].id }),
    },
    {
      id: 'search_opportunities', name: 'Search opportunities',
      description: 'Find deals by name, status (open/won/lost), pipeline, stage, owner, contact, company, value range, expected close date, close date or created date. Searches deals, not leads (leads.search_leads).',
      keywords: ['deals', 'pipeline report', 'open deals', 'closing soon'],
      ...ops.search('opportunities', {
        text: ['name'],
        filters: {
          status: z.enum(STATUS).optional(), pipelineId: z.string().optional(), stageId: z.string().optional(), ownerId: z.string().optional(),
          contactId: z.string().optional(), companyId: z.string().optional(), leadId: z.string().optional(),
          valueMin: z.number().optional(), valueMax: z.number().optional(),
          expectedCloseDateAfter: isoDate().optional(), expectedCloseDateBefore: isoDate().optional(),
          closedAtAfter: isoDate().optional(), closedAtBefore: isoDate().optional(),
          createdAtAfter: isoDate().optional(), createdAtBefore: isoDate().optional(),
        },
      }),
      example: () => ({ status: 'open' }),
    },
    {
      id: 'update_opportunity_value', name: 'Update opportunity value', description: 'Change the monetary value of an open deal.',
      keywords: ['deal amount', 'deal size'],
      ...ops.set('opportunities', 'value', money.describe('new deal value'), { what: 'opportunity', guard: isOpen }),
      example: (ctx) => ({ id: ctx.all('opportunities').find((o) => o.status === 'open').id, value: 12500 }),
    },
    {
      id: 'move_opportunity_to_stage', name: 'Move opportunity to stage',
      description: 'Move an open deal to another stage of its own pipeline (stage ID or name). To mark it won/lost use mark_opportunity_won / mark_opportunity_lost.',
      keywords: ['advance deal', 'change stage', 'progress deal'],
      risk: 'write',
      input: z.object({ id: id('opportunity'), stageId: z.string().min(1).describe("stage ID or exact stage name from the opportunity's pipeline (see pipelines.get_pipeline)") }),
      output: opportunity,
      handler: ({ id: oid, stageId }, ctx) => {
        const o = ctx.get('opportunities', oid, 'opportunity');
        isOpen(o);
        const s = stageIn(ctx.get('pipelines', o.pipelineId, 'pipeline'), stageId);
        if (o.stageId === s.id) fail('INVALID_STATE', `opportunity ${o.id} is already in stage ${s.name}`);
        const previousStageId = o.stageId;
        ctx.patch(o, { stageId: s.id, stageChangedAt: ctx.now });
        return { ...o, previousStageId, stageName: s.name, probability: s.probability };
      },
      example: (ctx) => {
        const o = ctx.all('opportunities').find((x) => x.status === 'open');
        const p = ctx.find('pipelines', o.pipelineId);
        return { id: o.id, stageId: p.stages.find((s) => s.id !== o.stageId).id };
      },
    },
    {
      id: 'assign_opportunity_owner', name: 'Assign opportunity owner', description: 'Set the sales rep who owns a deal. Owner must be an active user.',
      ...ops.set('opportunities', 'ownerId', id('user'), { param: 'ownerId', what: 'opportunity', guard: (o, i, ctx) => activeUser(ctx, i.ownerId) }),
      example: (ctx) => ({ id: ctx.all('opportunities')[0].id, ownerId: 'usr_005' }),
    },
    {
      id: 'set_expected_close_date', name: 'Set expected close date', description: 'Set the forecast close date of an open deal (today or later).',
      ...ops.set('opportunities', 'expectedCloseDate', isoDate(), {
        what: 'opportunity', map: (v) => v.slice(0, 10),
        guard: (o, i, ctx) => {
          isOpen(o);
          if (i.expectedCloseDate.slice(0, 10) < ctx.today) fail('VALIDATION', `${i.expectedCloseDate} is in the past (today is ${ctx.today})`);
        },
      }),
      example: (ctx) => ({ id: ctx.all('opportunities').find((o) => o.status === 'open').id, expectedCloseDate: '2026-12-20' }),
    },
    {
      id: 'mark_opportunity_won', name: 'Mark opportunity won', description: 'Close an open deal as won (records closedAt).',
      keywords: ['close deal', 'deal won', 'closed won'],
      ...ops.transition('opportunities', { to: 'won', from: ['open'], what: 'opportunity', extra: (o, i, ctx) => ({ closedAt: ctx.now, lostReason: null }) }),
      example: (ctx) => ({ id: ctx.all('opportunities').find((o) => o.status === 'open').id }),
    },
    {
      id: 'mark_opportunity_lost', name: 'Mark opportunity lost', description: 'Close an open deal as lost. A reason is required.',
      keywords: ['deal lost', 'closed lost'],
      ...ops.transition('opportunities', { to: 'lost', from: ['open'], reason: true, what: 'opportunity', extra: (o, i, ctx) => ({ closedAt: ctx.now, lostReason: i.reason }) }),
      example: (ctx) => ({ id: ctx.all('opportunities').find((o) => o.status === 'open').id, reason: 'Chose a competitor' }),
    },
    {
      id: 'reopen_opportunity', name: 'Reopen closed opportunity',
      description: 'Reopen a won or lost deal so it is open again (clears closedAt/lostReason). If its stage was removed it goes to the first stage.',
      ...ops.transition('opportunities', {
        to: 'open', from: ['won', 'lost'], what: 'opportunity',
        guard: (o, i, ctx) => {
          const p = ctx.get('pipelines', o.pipelineId, 'pipeline');
          if (p.status !== 'active') fail('INVALID_STATE', `pipeline ${p.name} is archived; deals in it cannot be reopened`);
        },
        extra: (o, i, ctx) => {
          const p = ctx.find('pipelines', o.pipelineId);
          return { closedAt: null, lostReason: null, stageId: p.stages.some((s) => s.id === o.stageId) ? o.stageId : p.stages[0].id };
        },
      }),
      example: (ctx) => ({ id: ctx.all('opportunities').find((o) => o.status === 'lost').id }),
    },
  ],

  seed(ctx, h) {
    const pls = ctx.all('pipelines');
    const P = { sales: pls.find((p) => p.isDefault), partners: pls.find((p) => p.name === 'Partnerships'), referral: pls.find((p) => p.name === 'Referral Program') };
    if (!P.sales) return;
    const products = ['Website Redesign', 'SEO Retainer', 'Annual Membership', 'Marketing Automation Setup', 'Ads Management', 'Consulting Package'];
    // [pipeline, stageIdx, status, value, expected close (days from today; negative = past), lostReason]
    // First 7 rows go to converted leads (in order); the rest to opportunity/customer contacts.
    const specs = [
      ['sales', 3, 'open', 8500, 12], ['sales', 4, 'open', 15000, 5], ['sales', 4, 'won', 12000, -6], ['sales', 3, 'won', 4800, -15],
      ['sales', 2, 'open', 6200, 21], ['sales', 3, 'lost', 9000, -9, 'Chose a competitor'], ['sales', 1, 'open', 3500, 30],
      ['sales', 0, 'open', 2500, 45], ['sales', 0, 'open', 1800, 40], ['sales', 1, 'open', 5200, 25], ['sales', 1, 'open', 7400, -3],
      ['sales', 2, 'open', 11000, 14], ['sales', 2, 'open', 3900, -7], ['sales', 3, 'open', 22000, 9], ['sales', 3, 'open', 6700, 18],
      ['sales', 4, 'open', 18500, 2], ['sales', 4, 'won', 9600, -2], ['sales', 2, 'won', 2400, -20], ['sales', 1, 'lost', 5000, -12, 'Budget cut'],
      ['sales', 0, 'lost', 1500, -30, 'No response after 6 follow-ups'],
      ['partners', 0, 'open', 20000, 60], ['partners', 1, 'open', 35000, 45], ['partners', 2, 'open', 50000, 20],
      ['referral', 1, 'won', 3000, -25], ['sales', 2, 'open', 4300, 7],
    ];
    const converted = ctx.all('leads').filter((l) => l.status === 'converted');
    const used = new Set(converted.map((l) => l.contactId));
    const pool = ctx.all('contacts').filter((c) => ['customer', 'opportunity'].includes(c.lifecycleStage) && !used.has(c.id));
    const reps = ['usr_002', 'usr_003', 'usr_005', 'usr_004'];
    specs.forEach(([pk, si, status, value, close, lostReason], i) => {
      const p = P[pk] || P.sales;
      const lead = converted[i];
      const c = lead ? ctx.find('contacts', lead.contactId) : pool.shift();
      if (!c) return;
      const closedDaysAgo = Math.max(-close, 0);
      const createdAt = lead ? new Date(Date.parse(lead.createdAt) + 2 * 864e5).toISOString() : h.daysAgo(closedDaysAgo + h.int(10, 60));
      const o = ctx.insert('opportunities', {
        name: `${c.name} - ${h.pick(products)}`, contactId: c.id, companyId: c.companyId ?? null, leadId: lead?.id ?? null,
        pipelineId: p.id, stageId: p.stages[Math.min(si, p.stages.length - 1)].id, value, currency: 'USD', status,
        ownerId: lead?.ownerId ?? reps[i % reps.length], expectedCloseDate: h.dateOnly(h.daysFromNow(close)),
        lostReason: lostReason ?? null, closedAt: status === 'open' ? null : h.daysAgo(closedDaysAgo), createdAt,
      });
      if (lead) lead.opportunityId = o.id;
    });
  },
});
