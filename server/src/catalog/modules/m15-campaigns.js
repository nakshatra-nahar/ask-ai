import { defineModule, ops, z, id, entity, isoDate, fail, toTimeIn, round2 } from '../kit.js';
import { matching as matchingSmartList } from './m09-smart-lists.js';
import { activeTemplate } from './m14-templates.js';

const CHANNELS = ['email', 'sms', 'facebook', 'google', 'multi'];
const STATUSES = ['draft', 'scheduled', 'active', 'paused', 'completed'];
const ADS = ['facebook', 'google'];
const campaign = entity({
  name: z.string(), channel: z.enum(CHANNELS), status: z.enum(STATUSES), audience: z.looseObject({}).nullable(), audienceSize: z.number(),
  steps: z.array(z.looseObject({ id: z.string(), channel: z.enum(['email', 'sms']) })), schedule: z.looseObject({}).nullable(),
  stats: z.looseObject({}), budget: z.number().nullable().optional(), launchedAt: z.string().nullable().optional(),
});
const EDITABLE = ['draft', 'scheduled', 'paused'];
const editable = (c) => {
  if (!EDITABLE.includes(c.status))
    fail('INVALID_STATE', `campaign ${c.id} '${c.name}' is ${c.status}; audience/steps/schedule can only change while ${EDITABLE.join(', ')}${c.status === 'active' ? ' (pause it first)' : ''}`);
};
const lower = (a) => a.map((x) => x.toLowerCase());

// Smart-list rule evaluation, mirroring m09-smart-lists `test`/`matching` (AND of {field, op, value} over targetTable, merged rows excluded).
/** Contact ids of a smart list's members (lead lists map to the leads' contacts). */
const smartListMembers = (ctx, sl) => {
  const rows = matchingSmartList(ctx, sl);
  return sl.targetTable === 'leads' ? rows.map((l) => l.contactId).filter(Boolean) : rows.map((r) => r.id);
};

/** Union of tag matches, explicit contacts and smart-list members; only active contacts reachable on the campaign channel count. */
function audienceOf(ctx, { tags, contactIds, smartListId }, channel) {
  const ids = new Set();
  (contactIds || []).forEach((c) => ids.add(ctx.get('contacts', c, 'contact').id));
  if (tags?.length) ctx.all('contacts').filter((c) => c.tags?.some((t) => lower(tags).includes(t.toLowerCase()))).forEach((c) => ids.add(c.id));
  if (smartListId) smartListMembers(ctx, ctx.get('smart_lists', smartListId, 'smart list')).forEach((c) => ids.add(c));
  const members = [...ids].map((c) => ctx.find('contacts', c)).filter((c) => c?.status === 'active');
  const okEmail = (c) => c.email && c.preferences?.email !== false;
  const okSms = (c) => c.phone && c.preferences?.sms !== false;
  const reach = (c) => (channel === 'email' ? okEmail(c) : channel === 'sms' ? okSms(c) : channel === 'multi' ? okEmail(c) || okSms(c) : true);
  const reachable = members.filter(reach);
  return { size: reachable.length, excluded: members.length - reachable.length };
}
const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const byName = (ctx, n) => ctx.all('campaigns').find((c) => c.name === n).id;

export default defineModule({
  id: 'campaigns',
  code: 'M15',
  name: 'Campaigns',
  description: 'Plan, launch and measure bulk marketing campaigns (email, SMS, paid ads).',
  tables: { campaigns: { prefix: 'cam', schema: campaign } },
  actions: [
    {
      id: 'create_campaign', name: 'Create campaign',
      description: 'Create a draft marketing campaign (email, sms, facebook, google or multi-channel) with an optional budget. Nothing is sent until launch.',
      keywords: ['new campaign', 'marketing blast', 'broadcast'],
      ...ops.create('campaigns', {
        input: z.object({ name: z.string().min(1), channel: z.enum(CHANNELS), budget: z.number().nonnegative().optional().describe('ad spend budget (USD)'), description: z.string().optional() }),
        check: (i, ctx) => {
          const d = ctx.all('campaigns').find((c) => c.name.toLowerCase() === i.name.toLowerCase());
          if (d) fail('DUPLICATE', `campaign '${i.name}' already exists (${d.id}, ${d.status})`);
        },
        build: (i) => ({ status: 'draft', audience: null, audienceSize: 0, steps: [], schedule: null, stats: {}, budget: i.budget ?? null, launchedAt: null }),
      }),
      example: () => ({ name: 'Holiday Sale 2026', channel: 'email' }),
    },
    {
      id: 'get_campaign', name: 'Get campaign details', description: 'Fetch one campaign: channel, status, audience, message steps, schedule, budget and raw stats.',
      ...ops.get('campaigns', { what: 'campaign' }),
      example: (ctx) => ({ id: byName(ctx, 'Facebook Lead Ads - Q4') }),
    },
    {
      id: 'list_campaigns', name: 'List campaigns', description: 'List marketing campaigns, filterable by status, channel or name text.',
      keywords: ['all campaigns', 'running campaigns'],
      ...ops.search('campaigns', { text: ['name'], filters: { status: z.enum(STATUSES).optional(), channel: z.enum(CHANNELS).optional() } }),
      example: () => ({ status: 'active' }),
    },
    {
      id: 'set_campaign_audience', name: 'Set campaign audience',
      description: 'Target a campaign at contacts with any of the given tags, explicit contactIds and/or a smart list. Computes audienceSize = active contacts reachable on the channel (opted-out contacts excluded). Replaces the previous audience.',
      keywords: ['target audience', 'recipients', 'segment'],
      risk: 'write',
      input: z.object({
        id: id('campaign'), tags: z.array(z.string()).optional().describe('contacts having ANY of these tags'), contactIds: z.array(z.string()).optional(), smartListId: z.string().optional(),
      }),
      output: campaign,
      handler: ({ id: cid, ...aud }, ctx) => {
        const c = ctx.get('campaigns', cid, 'campaign');
        editable(c);
        if (!aud.tags?.length && !aud.contactIds?.length && !aud.smartListId) fail('VALIDATION', 'provide tags, contactIds and/or smartListId');
        const a = audienceOf(ctx, aud, c.channel);
        if (!a.size) fail('VALIDATION', `that audience has no active contacts reachable by ${c.channel}${a.excluded ? ` (${a.excluded} matched but opted out or lack a ${c.channel === 'sms' ? 'phone' : 'email'})` : ''}`);
        return ctx.patch(c, { audience: { tags: aud.tags ?? [], contactIds: aud.contactIds ?? [], smartListId: aud.smartListId ?? null, excludedOptedOut: a.excluded }, audienceSize: a.size });
      },
      example: (ctx) => ({ id: byName(ctx, 'Black Friday SMS'), tags: ['customer'] }),
    },
    {
      id: 'add_campaign_message_step', name: 'Add campaign message step',
      description: 'Append an email or SMS message step to a campaign sequence (template or inline content, sent delayDays after the previous step). Not for ad campaigns (facebook/google).',
      keywords: ['campaign email', 'drip step', 'sequence message'],
      risk: 'write',
      input: z.object({
        id: id('campaign'), channel: z.enum(['email', 'sms']).optional().describe('defaults to the campaign channel'), templateId: z.string().optional(),
        subject: z.string().optional(), body: z.string().optional(), delayDays: z.number().int().min(0).default(0).describe('days after the previous step'),
      }),
      output: campaign,
      handler: ({ id: cid, ...s }, ctx) => {
        const c = ctx.get('campaigns', cid, 'campaign');
        editable(c);
        if (ADS.includes(c.channel)) fail('VALIDATION', `${c.channel} ad campaigns have no message steps; only email/sms/multi campaigns do`);
        const channel = s.channel ?? (c.channel === 'multi' ? null : c.channel);
        if (!channel) fail('VALIDATION', 'multi-channel campaigns need channel email or sms for each step');
        if (c.channel !== 'multi' && channel !== c.channel) fail('VALIDATION', `this is a ${c.channel} campaign; step channel must be ${c.channel}`);
        if (s.templateId) activeTemplate(ctx, s.templateId, channel);
        else if (!s.body || (channel === 'email' && !s.subject)) fail('VALIDATION', `provide templateId, or body${channel === 'email' ? ' and subject' : ''}`);
        const added = { id: ctx.newId('cstp'), order: c.steps.length + 1, channel, templateId: s.templateId ?? null, subject: s.subject ?? null, body: s.body ?? null, delayDays: s.delayDays };
        c.steps.push(added);
        ctx.patch(c, {});
        return { ...c, added };
      },
      example: (ctx) => ({ id: byName(ctx, 'Black Friday SMS'), templateId: ctx.all('templates').find((t) => t.name === 'Black Friday Teaser').id }),
    },
    {
      id: 'set_campaign_schedule', name: 'Set campaign schedule',
      description: 'Set when a campaign starts (future time) and optionally ends. A draft campaign becomes scheduled; launch_campaign starts it immediately instead.',
      keywords: ['schedule campaign', 'start date'],
      risk: 'write',
      input: z.object({ id: id('campaign'), startAt: isoDate('future start time'), endAt: isoDate().optional(), timezone: z.string().optional().describe('e.g. America/New_York') }),
      output: campaign,
      handler: ({ id: cid, startAt, endAt, timezone }, ctx) => {
        const c = ctx.get('campaigns', cid, 'campaign');
        editable(c);
        if (timezone) try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { fail('VALIDATION', `unknown timezone '${timezone}'; use an IANA name like America/New_York`); }
        // Naive datetimes are wall-clock time in `timezone` when given, else UTC.
        const at = (v) => toTimeIn(v, timezone);
        if (at(startAt) <= Date.parse(ctx.now)) fail('VALIDATION', `startAt must be in the future (now is ${ctx.now}); use launch_campaign to start now`);
        if (endAt && at(endAt) <= at(startAt)) fail('VALIDATION', 'endAt must be after startAt');
        const iso = (v) => new Date(at(v)).toISOString();
        return ctx.patch(c, { schedule: { startAt: iso(startAt), endAt: endAt ? iso(endAt) : null, timezone: timezone ?? 'UTC' }, ...(c.status === 'draft' ? { status: 'scheduled' } : {}) });
      },
      example: (ctx) => ({ id: byName(ctx, 'Black Friday SMS'), startAt: '2026-11-27T14:00:00Z', endAt: '2026-11-28T04:00:00Z' }),
    },
    {
      id: 'launch_campaign', name: 'Launch campaign',
      description: 'Start a draft or scheduled campaign now (status → active), sending to its whole audience. Email/SMS/multi campaigns need an audience and at least one message step; ad campaigns need an audience and a budget. For a single message use sms.send_sms / email.send_email.',
      keywords: ['start campaign', 'go live', 'blast'],
      risk: 'external',
      input: z.object({ id: id('campaign') }),
      output: campaign,
      handler: ({ id: cid }, ctx) => {
        const c = ctx.get('campaigns', cid, 'campaign');
        if (!['draft', 'scheduled'].includes(c.status)) fail('INVALID_STATE', `campaign '${c.name}' is ${c.status}; only draft or scheduled campaigns can be launched${c.status === 'paused' ? ' (use resume_campaign)' : ''}`);
        // Re-evaluate tag/contact/smart-list audiences now so contacts who opted out since targeting are not sent to.
        const aud = c.audience;
        const fresh = !ADS.includes(c.channel) && (aud?.tags?.length || aud?.contactIds?.length || aud?.smartListId) ? audienceOf(ctx, aud, c.channel) : null;
        const audienceSize = fresh ? fresh.size : c.audienceSize;
        const missing = [];
        if (!audienceSize) missing.push(fresh ? 'an audience with reachable contacts (everyone targeted has opted out; update set_campaign_audience)' : 'an audience (set_campaign_audience)');
        if (ADS.includes(c.channel) ? !c.budget : !c.steps.length) missing.push(ADS.includes(c.channel) ? 'a budget' : 'at least one message step (add_campaign_message_step)');
        if (missing.length) fail('INVALID_STATE', `campaign '${c.name}' cannot launch: needs ${missing.join(' and ')}`);
        return ctx.patch(c, {
          status: 'active', launchedAt: ctx.now, schedule: { ...(c.schedule || {}), startAt: ctx.now },
          ...(fresh ? { audienceSize, audience: { ...aud, excludedOptedOut: fresh.excluded } } : {}),
          stats: { ...c.stats, ...(ADS.includes(c.channel) ? {} : { queued: audienceSize }) },
        });
      },
      example: (ctx) => ({ id: byName(ctx, 'November Newsletter') }),
    },
    {
      id: 'pause_campaign', name: 'Pause campaign', description: 'Pause an active campaign (stops further sends / ad delivery until resumed).',
      ...ops.transition('campaigns', { to: 'paused', from: ['active'], what: 'campaign', extra: (r, i, ctx) => ({ pausedAt: ctx.now }) }),
      example: (ctx) => ({ id: byName(ctx, 'Facebook Lead Ads - Q4') }),
    },
    {
      id: 'resume_campaign', name: 'Resume campaign', description: 'Resume a paused campaign (back to active); sending / ad delivery restarts.',
      ...ops.transition('campaigns', { to: 'active', from: ['paused'], risk: 'external', what: 'campaign', extra: () => ({ pausedAt: null }) }),
      example: (ctx) => ({ id: byName(ctx, 'Spring Referral Drive') }),
    },
    {
      id: 'get_campaign_performance', name: 'Get campaign performance',
      description: 'Campaign results: raw stats plus delivery/open/click/reply rates (email/SMS) or CTR (ads), spend vs budget, leads attributed (leads with this campaignId), converted leads and cost per lead.',
      keywords: ['campaign roi', 'campaign results', 'cost per lead', 'open rate', 'ad performance'],
      risk: 'read',
      input: z.object({ id: id('campaign') }),
      output: z.looseObject({ campaignId: z.string(), stats: z.looseObject({}), rates: z.looseObject({}), leadsAttributed: z.number() }),
      handler: ({ id: cid }, ctx) => {
        const c = ctx.get('campaigns', cid, 'campaign');
        const s = c.stats || {};
        const leads = ctx.all('leads').filter((l) => l.campaignId === c.id);
        const rates = Object.fromEntries(Object.entries({
          deliveryRate: rate(s.delivered, s.sent), openRate: rate(s.opened, s.delivered), clickRate: rate(s.clicked, s.delivered),
          replyRate: rate(s.replied, s.delivered), ctr: rate(s.clicks, s.impressions), leadConversionRate: rate(leads.filter((l) => l.status === 'converted').length, leads.length),
        }).filter(([, v]) => v != null));
        return {
          campaignId: c.id, name: c.name, channel: c.channel, status: c.status, audienceSize: c.audienceSize, stats: s, rates,
          leadsAttributed: leads.length, leadsConverted: leads.filter((l) => l.status === 'converted').length,
          spend: s.spend ?? null, budget: c.budget ?? null, budgetRemaining: c.budget != null && s.spend != null ? round2(c.budget - s.spend) : null,
          costPerLead: s.spend && leads.length ? round2(s.spend / leads.length) : null,
        };
      },
      example: (ctx) => ({ id: byName(ctx, 'Facebook Lead Ads - Q4') }),
    },
  ],

  seed(ctx, h) {
    const size = (aud, ch) => audienceOf(ctx, aud, ch).size;
    const step = (channel, subject, body, delayDays = 0) => ({ id: ctx.newId('cstp'), channel, templateId: null, subject, body, delayDays });
    const rows = [
      {
        name: 'Facebook Lead Ads - Q4', channel: 'facebook', status: 'active', budget: 6000, launchedAt: '2026-10-01T13:00:00.000Z',
        audience: { platformAudience: 'Lookalike 1% of past customers (US, 25-55)' }, audienceSize: 185000, steps: [],
        schedule: { startAt: '2026-10-01T13:00:00.000Z', endAt: '2026-12-31T23:59:00.000Z', timezone: 'America/New_York' },
        stats: { impressions: 148200, clicks: 3120, spend: 3850 },
      },
      {
        name: 'Google Search - Q4', channel: 'google', status: 'active', budget: 4500, launchedAt: '2026-10-01T13:00:00.000Z',
        audience: { keywords: ['local marketing agency', 'crm for small business', 'appointment booking software'] }, audienceSize: 52000, steps: [],
        schedule: { startAt: '2026-10-01T13:00:00.000Z', endAt: '2026-12-31T23:59:00.000Z', timezone: 'America/New_York' },
        stats: { impressions: 52300, clicks: 2780, spend: 2910 },
      },
      {
        name: 'November Newsletter', channel: 'email', status: 'scheduled', audience: { tags: ['newsletter'], contactIds: [], smartListId: null },
        steps: [step('email', 'What\'s new at Acme this November', 'Hi {{contact.firstName}}, here are this month\'s updates, tips and offers.')],
        schedule: { startAt: '2026-11-06T14:00:00.000Z', endAt: null, timezone: 'America/New_York' }, stats: {},
      },
      {
        name: 'Webinar Promo - Oct', channel: 'email', status: 'completed', audienceSize: 412, launchedAt: '2026-10-05T14:00:00.000Z', audience: { tags: ['lead'], contactIds: [], smartListId: null },
        steps: [step('email', 'Join our free webinar: Grow your local business', 'Hi {{contact.firstName}}, save your seat for our October webinar.'), step('email', 'Last chance: webinar starts tomorrow', 'Hi {{contact.firstName}}, the webinar starts tomorrow!', 7)],
        schedule: { startAt: '2026-10-05T14:00:00.000Z', endAt: '2026-10-20T23:59:00.000Z', timezone: 'America/New_York' },
        stats: { sent: 412, delivered: 398, opened: 171, clicked: 46, replied: 7, bounced: 14, unsubscribed: 3 },
      },
      { name: 'Black Friday SMS', channel: 'sms', status: 'draft', audience: null, audienceSize: 0, steps: [], schedule: null, stats: {} },
      {
        name: 'Spring Referral Drive', channel: 'multi', status: 'paused', audienceSize: 48, launchedAt: '2026-09-15T14:00:00.000Z', pausedAt: '2026-10-20T16:00:00.000Z',
        audience: { tags: ['customer'], contactIds: [], smartListId: null },
        steps: [step('email', 'Give $50, get $50', 'Hi {{contact.firstName}}, refer a friend and you both get $50 off.'), step('sms', null, 'Reminder: refer a friend to Acme and you both get $50 off!', 5)],
        schedule: { startAt: '2026-09-15T14:00:00.000Z', endAt: '2026-12-15T23:59:00.000Z', timezone: 'America/New_York' },
        stats: { sent: 96, delivered: 94, opened: 41, clicked: 12, replied: 5 },
      },
    ];
    for (const r of rows) {
      r.steps.forEach((s, i) => (s.order = i + 1));
      ctx.insert('campaigns', {
        budget: null, launchedAt: null, ...r, audienceSize: r.audienceSize ?? (r.audience ? size(r.audience, r.channel) : 0), createdAt: h.daysAgo(h.int(55, 80)),
      });
    }
  },
});
