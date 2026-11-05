import { defineModule, ops, z, id, entity, isoDate, limit, money, listOf, fail, page, textMatch, matchFilters } from '../kit.js';

const SOURCES = ['facebook', 'google_ads', 'website', 'referral', 'webinar', 'walk_in'];
const STATUS = ['new', 'contacted', 'qualified', 'disqualified', 'converted'];
const OPEN = ['new', 'contacted', 'qualified'];
const lead = entity({
  contactId: z.string().nullable(), name: z.string(), email: z.string().nullable().optional(), phone: z.string().nullable().optional(),
  source: z.enum(SOURCES), campaignId: z.string().nullable().optional(), status: z.enum(STATUS), score: z.number().min(0).max(100),
  ownerId: z.string().nullable(), qualification: z.record(z.string(), z.any()), disqualifyReason: z.string().nullable().optional(),
  opportunityId: z.string().nullable().optional(),
});

function activeUser(ctx, uid) {
  const u = ctx.get('users', uid, 'user');
  if (u.status !== 'active') fail('INVALID_STATE', `user ${uid} (${u.name}) is ${u.status} and cannot own leads; pick an active user (users.list_users)`);
  return u;
}
const isOpen = (l) => {
  if (!OPEN.includes(l.status))
    fail('INVALID_STATE', `lead ${l.id} is ${l.status}${l.opportunityId ? ` (opportunity ${l.opportunityId})` : ''}; only new/contacted/qualified leads can be changed`);
};
const scoreSchema = z.number().int().min(0).max(100);

export default defineModule({
  id: 'leads',
  code: 'M03',
  name: 'Leads',
  description: 'Capture, qualify, and route prospective customers.',
  tables: { leads: { prefix: 'ld', schema: lead } },
  actions: [
    {
      id: 'create_lead', name: 'Create lead',
      description: 'Capture a new sales lead (prospect inquiry) with its source/campaign, linked to an existing contact or with name/email. Rejects a second open lead for the same contact. To add a person to the CRM use contacts.create_contact.',
      keywords: ['new prospect', 'capture lead', 'inquiry'],
      ...ops.create('leads', {
        input: z.object({
          contactId: z.string().optional().describe('existing contact; its name/email/phone are copied onto the lead'),
          name: z.string().min(1).optional().describe('required when contactId is omitted'),
          email: z.email().optional(), phone: z.string().optional(), source: z.enum(SOURCES),
          campaignId: z.string().optional(), ownerId: z.string().optional(), score: scoreSchema.optional(),
        }),
        build: (i, ctx) => {
          const c = i.contactId
            ? ctx.get('contacts', i.contactId, 'contact')
            : i.email && ctx.all('contacts').find((x) => x.email?.toLowerCase() === i.email.toLowerCase() && x.status === 'active');
          if (!c && !i.name) fail('VALIDATION', 'provide contactId, or name (plus email/phone) for a new prospect');
          if (c?.status === 'merged') fail('INVALID_STATE', `contact ${c.id} was merged into ${c.mergedInto}; use ${c.mergedInto} instead`);
          if (c) {
            const open = ctx.all('leads').find((l) => l.contactId === c.id && OPEN.includes(l.status));
            if (open) fail('DUPLICATE', `${c.name} already has an open lead ${open.id} (${open.status}); update it instead`, { existingId: open.id });
          }
          if (i.campaignId) ctx.get('campaigns', i.campaignId, 'campaign');
          if (i.ownerId) activeUser(ctx, i.ownerId);
          return {
            contactId: c?.id ?? null, name: c?.name ?? i.name, email: c?.email ?? i.email ?? null, phone: c?.phone ?? i.phone ?? null,
            campaignId: i.campaignId ?? null, ownerId: i.ownerId ?? null, score: i.score ?? 0, status: 'new',
            qualification: {}, disqualifyReason: null, opportunityId: null,
          };
        },
      }),
      example: () => ({ name: 'Test Prospect', email: 'test.prospect@example.com', source: 'website' }),
    },
    {
      id: 'get_lead', name: 'Get lead details', description: 'Fetch one lead by ID (source, campaign, status, score, owner, qualification answers).',
      ...ops.get('leads', { what: 'lead' }),
      example: (ctx) => ({ id: ctx.all('leads')[0].id }),
    },
    {
      id: 'search_leads', name: 'Search leads',
      description: 'Find sales leads (prospects with source/campaign/status/score/owner) — not general contact lookup (contacts.search_contacts). Filter by status, source, campaignId, ownerId, unassigned, contactId(s), score range, created date range, or name/email/phone text. Newest first.',
      keywords: ['find leads', 'new leads', 'unassigned leads', 'facebook leads', 'prospects'],
      risk: 'read',
      input: z.object({
        query: z.string().optional().describe('free text over name, email, phone'),
        status: z.union([z.enum(STATUS), z.array(z.enum(STATUS))]).optional().describe('one status or a list'),
        source: z.enum(SOURCES).optional(), campaignId: z.string().optional(), ownerId: z.string().optional(),
        contactId: z.string().optional(), contactIds: z.array(z.string()).optional().describe('leads for any of these contacts'),
        createdAtAfter: isoDate().optional(), createdAtBefore: isoDate().optional(),
        scoreMin: z.number().optional(), scoreMax: z.number().optional(),
        unassigned: z.boolean().optional().describe('true = only leads with no owner; false = only owned leads'),
        limit,
      }),
      output: listOf(lead),
      handler: ({ query, limit: lim, unassigned, ...f }, ctx) => {
        const rows = ctx.all('leads').filter(
          (r) => textMatch(r, ['name', 'email', 'phone'], query) && matchFilters(r, f) && (unassigned === undefined || (r.ownerId == null) === unassigned),
        );
        return page([...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), lim);
      },
      example: () => ({ source: 'facebook', createdAtAfter: '2026-10-26', createdAtBefore: '2026-11-01' }),
    },
    {
      id: 'update_lead', name: 'Update lead details', description: 'Edit an open lead\'s name, email, phone or pipeline status (new/contacted/qualified). Use disqualify_lead / convert_lead to close it.',
      ...ops.update('leads', {
        what: 'lead',
        fields: { name: z.string().min(1), email: z.email(), phone: z.string(), status: z.enum(OPEN) },
        guard: isOpen,
      }),
      example: (ctx) => ({ id: ctx.all('leads').find((l) => l.status === 'new').id, status: 'contacted' }),
    },
    {
      id: 'assign_lead_owner', name: 'Assign lead owner',
      description: 'Assign or reassign an open lead to a sales rep. User must be active (not deactivated/invited); out-of-office users are allowed but a warning is returned.',
      keywords: ['route lead', 'distribute leads', 'give lead to rep'],
      risk: 'write',
      input: z.object({ id: id('lead'), ownerId: id('user') }),
      output: lead,
      handler: ({ id: lid, ownerId }, ctx) => {
        const l = ctx.get('leads', lid, 'lead');
        isOpen(l);
        const u = activeUser(ctx, ownerId);
        const previousOwnerId = l.ownerId;
        ctx.patch(l, { ownerId, assignedAt: ctx.now });
        return { ...l, ownerName: u.name, previousOwnerId, ...(u.outOfOffice ? { warning: `${u.name} is currently out of office; the lead may not be worked until they return` } : {}) };
      },
      example: (ctx) => ({ id: ctx.all('leads').find((l) => l.status === 'new' && !l.ownerId).id, ownerId: 'usr_002' }),
    },
    {
      id: 'set_lead_source', name: 'Set lead source', description: 'Correct where a lead came from (source channel and optionally the campaign that produced it).',
      keywords: ['attribution', 'lead origin'],
      risk: 'write',
      input: z.object({
        id: id('lead'), source: z.enum(SOURCES),
        campaignId: z.string().nullable().optional().describe('campaign that produced the lead; null clears it'),
      }),
      output: lead,
      handler: ({ id: lid, source, campaignId }, ctx) => {
        const l = ctx.get('leads', lid, 'lead');
        if (campaignId) ctx.get('campaigns', campaignId, 'campaign');
        if (l.source === source && campaignId === undefined) fail('INVALID_STATE', `lead ${l.id} already has source ${source}`);
        return ctx.patch(l, { source, ...(campaignId !== undefined ? { campaignId } : {}) });
      },
      example: (ctx) => ({ id: ctx.all('leads').find((l) => l.source === 'website').id, source: 'referral' }),
    },
    {
      id: 'record_qualification_answers', name: 'Record qualification answers',
      description: 'Save qualification answers (budget, timeline, authority, need…) on an open lead; merges with earlier answers and can mark it qualified.',
      keywords: ['BANT', 'qualify lead', 'discovery answers'],
      risk: 'write',
      input: z.object({
        id: id('lead'),
        answers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).refine((a) => Object.keys(a).length > 0, 'provide at least one answer')
          .describe('question key -> answer, e.g. {"budget":"$5k-10k","timeline":"this quarter","decisionMaker":true}'),
        markQualified: z.boolean().optional().describe('also set status to qualified'),
      }),
      output: lead,
      handler: ({ id: lid, answers, markQualified }, ctx) => {
        const l = ctx.get('leads', lid, 'lead');
        isOpen(l);
        return ctx.patch(l, { qualification: { ...l.qualification, ...answers }, ...(markQualified ? { status: 'qualified' } : {}) });
      },
      example: (ctx) => ({ id: ctx.all('leads').find((l) => l.status === 'contacted').id, answers: { budget: '$5k-10k', timeline: 'this quarter' }, markQualified: true }),
    },
    {
      id: 'update_lead_score', name: 'Update lead score', description: 'Set the 0-100 lead score of an open lead.',
      keywords: ['scoring', 'hot lead'],
      ...ops.set('leads', 'score', scoreSchema.describe('new score 0-100'), { what: 'lead', guard: isOpen }),
      example: (ctx) => ({ id: ctx.all('leads').find((l) => l.status === 'new').id, score: 85 }),
    },
    {
      id: 'disqualify_lead', name: 'Disqualify lead with reason', description: 'Close an open lead as disqualified (not a fit). A reason is required.',
      keywords: ['reject lead', 'junk lead', 'not a fit'],
      ...ops.transition('leads', { to: 'disqualified', from: OPEN, reason: true, what: 'lead', extra: (l, i) => ({ disqualifyReason: i.reason }) }),
      example: (ctx) => ({ id: ctx.all('leads').find((l) => l.status === 'new').id, reason: 'Outside service area' }),
    },
    {
      id: 'convert_lead', name: 'Convert lead to opportunity',
      description: 'Convert an open lead into a deal: creates an opportunity in the default pipeline\'s first stage, marks the lead converted and links them. Fails if already converted or disqualified.',
      keywords: ['create deal from lead', 'promote lead'],
      risk: 'write',
      input: z.object({
        id: id('lead'), opportunityName: z.string().min(1).optional(), value: money.optional().describe('deal value, default 0'),
        expectedCloseDate: isoDate().optional(),
      }),
      output: z.looseObject({ lead, opportunity: z.looseObject({ id: z.string(), pipelineId: z.string(), stageId: z.string(), status: z.string() }) }),
      handler: ({ id: lid, opportunityName, value, expectedCloseDate }, ctx) => {
        const l = ctx.get('leads', lid, 'lead');
        if (l.status === 'converted') fail('INVALID_STATE', `lead ${l.id} was already converted to opportunity ${l.opportunityId}`);
        if (l.status === 'disqualified') fail('INVALID_STATE', `lead ${l.id} is disqualified (${l.disqualifyReason}) and cannot be converted`);
        const p = ctx.all('pipelines').find((x) => x.isDefault && x.status === 'active') || fail('NOT_FOUND', 'no active default pipeline to place the opportunity in');
        const stage = p.stages[0] || fail('INVALID_STATE', `pipeline ${p.name} has no stages`);
        const c = l.contactId ? ctx.find('contacts', l.contactId) : null;
        const opportunity = ctx.insert('opportunities', {
          name: opportunityName || `${l.name} - New deal`, contactId: l.contactId, companyId: c?.companyId ?? null, leadId: l.id,
          pipelineId: p.id, stageId: stage.id, value: value ?? 0, currency: 'USD', status: 'open', ownerId: l.ownerId,
          expectedCloseDate: expectedCloseDate?.slice(0, 10) ?? null, lostReason: null, closedAt: null,
        });
        ctx.patch(l, { status: 'converted', opportunityId: opportunity.id, convertedAt: ctx.now });
        if (c && ['subscriber', 'lead'].includes(c.lifecycleStage)) ctx.patch(c, { lifecycleStage: 'opportunity' });
        return { lead: l, opportunity };
      },
      example: (ctx) => ({ id: ctx.all('leads').find((l) => l.status === 'qualified').id, value: 5000 }),
    },
  ],

  seed(ctx, h) {
    const campaigns = ctx.all('campaigns');
    const fb = campaigns.find((c) => c.name === 'Facebook Lead Ads - Q4')?.id ?? null;
    const gads = campaigns.find((c) => c.channel === 'google')?.id ?? null;
    const contacts = ctx.all('contacts').filter((c) => c.status === 'active');
    const leadPool = contacts.filter((c) => c.lifecycleStage === 'lead' && c.id !== 'con_002');
    const convPool = contacts.filter((c) => ['opportunity', 'customer'].includes(c.lifecycleStage));
    const used = new Set(['con_002']);
    const take = (pool) => {
      const c = pool.find((x) => !used.has(x.id)) || contacts.find((x) => !used.has(x.id));
      if (c) used.add(c.id);
      return c;
    };
    // [daysAgo, source, status, ownerId, disqualifyReason]. Last week = daysAgo 3..9 (2026-10-26..2026-11-01).
    const specs = [
      // last week: 16 leads, 8 facebook, 8 unassigned 'new'
      [5, 'facebook', 'new', null], [3, 'facebook', 'new', null], [4, 'facebook', 'new', null], [6, 'facebook', 'new', null],
      [8, 'facebook', 'new', null], [4, 'facebook', 'contacted', 'usr_002'], [7, 'facebook', 'qualified', 'usr_003'], [9, 'facebook', 'new', 'usr_005'],
      [3, 'google_ads', 'new', null], [6, 'website', 'new', null], [9, 'referral', 'new', null],
      [5, 'google_ads', 'contacted', 'usr_002'], [7, 'website', 'contacted', 'usr_003'], [8, 'referral', 'qualified', 'usr_005'],
      [4, 'webinar', 'new', 'usr_002'], [6, 'google_ads', 'contacted', 'usr_003'],
      // this week
      [0, 'facebook', 'new', null], [1, 'website', 'new', null], [2, 'google_ads', 'new', 'usr_002'], [1, 'referral', 'contacted', 'usr_005'], [2, 'walk_in', 'new', null],
      // older (10-60 days)
      [12, 'facebook', 'contacted', 'usr_002'], [15, 'facebook', 'disqualified', 'usr_003', 'No budget this year'], [20, 'facebook', 'converted', 'usr_002'],
      [11, 'google_ads', 'qualified', 'usr_003'], [14, 'website', 'contacted', 'usr_004'], [18, 'referral', 'converted', 'usr_005'],
      [22, 'webinar', 'qualified', 'usr_002'], [25, 'website', 'disqualified', 'usr_005', 'Outside service area'], [28, 'google_ads', 'converted', 'usr_003'],
      [30, 'referral', 'contacted', 'usr_009'], [33, 'walk_in', 'converted', 'usr_002'], [35, 'website', 'new', null],
      [38, 'facebook', 'qualified', 'usr_005'], [40, 'google_ads', 'disqualified', 'usr_002', 'Duplicate inquiry'], [42, 'webinar', 'contacted', 'usr_003'],
      [45, 'referral', 'converted', 'usr_005'], [47, 'website', 'qualified', 'usr_009'], [50, 'facebook', 'converted', 'usr_003'],
      [52, 'google_ads', 'contacted', 'usr_004'], [55, 'website', 'disqualified', 'usr_003', 'Unresponsive after 5 attempts'], [57, 'referral', 'qualified', 'usr_002'],
      [58, 'webinar', 'new', 'usr_005'], [60, 'walk_in', 'converted', 'usr_002'], [13, 'website', 'new', null],
    ];
    const scores = { new: [10, 40], contacted: [30, 60], qualified: [60, 90], converted: [70, 95], disqualified: [5, 25] };
    specs.forEach(([d, source, status, ownerId, disqualifyReason], i) => {
      const c = i === 0 ? ctx.find('contacts', 'con_002') : take(status === 'converted' ? convPool : leadPool);
      if (!c) return;
      const qualified = ['qualified', 'converted'].includes(status);
      ctx.insert('leads', {
        contactId: c.id, name: c.name, email: c.email ?? null, phone: c.phone ?? null, source,
        campaignId: source === 'facebook' && d <= 34 ? fb : source === 'google_ads' ? gads : null, // Q4 started 34 days ago
        status, score: h.int(...scores[status]), ownerId,
        qualification: qualified ? { budget: h.pick(['$2k-5k', '$5k-10k', '$10k+']), timeline: h.pick(['this month', 'this quarter']), decisionMaker: true } : {},
        disqualifyReason: disqualifyReason ?? null, opportunityId: null, // converted leads get opportunityId from the opportunities seed
        createdAt: h.daysAgo(d, d === 0 ? 8 : undefined),
      });
    });
  },
});
