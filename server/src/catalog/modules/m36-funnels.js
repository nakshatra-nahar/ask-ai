import { defineModule, ops, z, id, entity, fail } from '../kit.js';

const STEP_TYPES = ['optin', 'sales', 'upsell', 'downsell', 'thankyou', 'booking'];
const STATUSES = ['draft', 'published', 'unpublished'];
// Which step types can carry each conversion goal.
const GOAL_STEPS = { form_submit: ['optin'], purchase: ['sales', 'upsell', 'downsell'], booking: ['booking'] };
const MAX_STEPS = 10;
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

const step = z.looseObject({ id: z.string(), name: z.string(), type: z.enum(STEP_TYPES), path: z.string(), landingPageId: z.string().nullable() });
const funnel = entity({
  name: z.string(), description: z.string().nullable().optional(), websiteId: z.string().nullable(), status: z.enum(STATUSES),
  steps: z.array(step),
  goal: z.looseObject({ type: z.enum(Object.keys(GOAL_STEPS)), targetRate: z.number(), stepId: z.string() }).nullable(),
  metrics: z.looseObject({ period: z.string(), steps: z.array(z.looseObject({ stepId: z.string(), visits: z.number(), conversions: z.number() })) }).nullable(),
  publishedAt: z.string().nullable(), publishedUrl: z.string().nullable(),
});

const byName = (ctx, name) => ctx.all('funnels').find((f) => f.name === name);
const stepList = (f) => f.steps.map((s) => `${s.id} '${s.name}' (${s.type})`).join(', ') || 'none';
const findStep = (f, sid) => f.steps.find((s) => s.id === sid) || fail('NOT_FOUND', `step ${sid} is not in funnel ${f.id}; its steps are: ${stepList(f)}`);

export default defineModule({
  id: 'funnels',
  code: 'M36',
  name: 'Funnels',
  description: 'Configure ordered journeys toward conversion.',
  tables: { funnels: { prefix: 'fnl', schema: funnel } },
  actions: [
    {
      id: 'create_funnel', name: 'Create funnel',
      description: 'Create an empty draft sales/lead funnel (an ordered sequence of steps such as opt-in → sales → thank-you). Optionally attach it to a website domain. Not for single landing pages.',
      keywords: ['new funnel', 'sales funnel', 'lead funnel', 'webinar funnel'],
      ...ops.create('funnels', {
        input: z.object({ name: z.string().min(1).max(80), description: z.string().max(300).optional(), websiteId: z.string().optional().describe('website whose domain hosts the funnel') }),
        check: (i, ctx) => {
          const dup = ctx.all('funnels').find((f) => f.name.toLowerCase() === i.name.toLowerCase());
          if (dup) fail('DUPLICATE', `a funnel named '${i.name}' already exists (${dup.id})`, { existingId: dup.id });
          if (i.websiteId) ctx.get('websites', i.websiteId, 'website');
        },
        build: (i) => ({ description: i.description ?? null, websiteId: i.websiteId ?? null, status: 'draft', steps: [], goal: null, metrics: null, publishedAt: null, publishedUrl: null }),
      }),
      example: () => ({ name: 'Teeth Whitening Spring Promo', description: 'Ad → offer page → booking' }),
    },
    {
      id: 'get_funnel', name: 'Get funnel definition',
      description: 'Fetch one funnel by ID with its ordered steps (type, path, linked landing page), conversion goal and status.',
      keywords: ['funnel steps', 'funnel details'],
      ...ops.get('funnels', { what: 'funnel' }),
      example: (ctx) => ({ id: byName(ctx, 'Marketing Masterclass Webinar').id }),
    },
    {
      id: 'list_funnels', name: 'List funnels',
      description: 'List funnels, filterable by status, website, or name text.',
      keywords: ['all funnels', 'find funnel'],
      ...ops.search('funnels', { text: ['name', 'description'], filters: { status: z.enum(STATUSES).optional(), websiteId: z.string().optional() } }),
      example: () => ({ status: 'published' }),
    },
    {
      id: 'add_funnel_step', name: 'Add funnel step',
      description: `Append a step to a funnel (types: ${STEP_TYPES.join(', ')}). A funnel may have at most one thankyou step and ${MAX_STEPS} steps; new steps are inserted before an existing thankyou step.`,
      keywords: ['new step', 'add upsell', 'add optin page'],
      risk: 'write',
      input: z.object({
        id: id('funnel'), name: z.string().min(1).max(60), type: z.enum(STEP_TYPES),
        path: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'path must be a lowercase slug').optional().describe('URL path for the step; defaults to a slug of the name'),
      }),
      output: z.looseObject({ ...funnel.shape, added: step }),
      handler: ({ id: fid, name, type, path }, ctx) => {
        const f = ctx.get('funnels', fid, 'funnel');
        if (f.steps.length >= MAX_STEPS) fail('LIMIT_EXCEEDED', `funnel ${f.id} already has ${MAX_STEPS} steps (the maximum); remove one first`);
        const thanks = f.steps.find((s) => s.type === 'thankyou');
        if (type === 'thankyou' && thanks) fail('CONFLICT', `funnel ${f.id} already has a thankyou step (${thanks.id} '${thanks.name}')`);
        const p = path || slugify(name);
        const dup = f.steps.find((s) => s.path === p);
        if (dup) fail('DUPLICATE', `path '/${p}' is already used by step ${dup.id} '${dup.name}'; pass a different path`);
        const added = { id: ctx.newId('fstp'), name, type, path: p, landingPageId: null };
        const at = thanks ? f.steps.indexOf(thanks) : f.steps.length;
        f.steps.splice(at, 0, added);
        ctx.patch(f, {});
        return { ...f, added };
      },
      example: (ctx) => ({ id: byName(ctx, 'Free 7-Day Meal Plan').id, name: 'Trial Membership Offer', type: 'sales' }),
    },
    {
      id: 'reorder_funnel_steps', name: 'Reorder funnel steps',
      description: 'Set the order of a funnel\'s steps by passing every step ID in the new order. A thankyou step must stay last.',
      ...(() => {
        const base = ops.reorder('funnels', 'steps', { what: 'funnel' });
        return {
          ...base,
          handler: (inp, ctx) => {
            const f = ctx.get('funnels', inp.id, 'funnel');
            const types = inp.orderedIds.map((x) => f.steps.find((s) => s.id === x)?.type);
            if (types.includes('thankyou') && types.at(-1) !== 'thankyou') fail('VALIDATION', 'the thankyou step must be the last step');
            return base.handler(inp, ctx);
          },
        };
      })(),
      example: (ctx) => {
        const s = byName(ctx, 'Marketing Masterclass Webinar').steps;
        return { id: byName(ctx, 'Marketing Masterclass Webinar').id, orderedIds: [s[0].id, s[2].id, s[1].id, s[3].id] };
      },
    },
    {
      id: 'remove_funnel_step', name: 'Remove funnel step',
      description: 'Delete a step from a draft or unpublished funnel (its landing-page link and step metrics are lost). Steps of a live (published) funnel cannot be removed; a step used by the conversion goal cannot be removed.',
      keywords: ['delete step'],
      ...ops.removeItem('funnels', 'steps', {
        itemParam: 'stepId', what: 'funnel', risk: 'destructive',
        guard: (f, s) => {
          if (f.status === 'published') fail('INVALID_STATE', `funnel ${f.id} is published (live); steps can only be removed from draft or unpublished funnels`);
          if (f.goal?.stepId === s.id) fail('CONFLICT', `step ${s.id} '${s.name}' is the conversion-goal step; change the goal with Set funnel conversion goal first`);
        },
      }),
      example: (ctx) => {
        const f = byName(ctx, 'Free 7-Day Meal Plan');
        return { id: f.id, stepId: f.steps.find((s) => s.type === 'thankyou').id };
      },
    },
    {
      id: 'link_landing_page_to_step', name: 'Link landing page to step',
      description: 'Attach an existing landing page (landing_pages ID) as the page shown for one funnel step. A landing page can back only one funnel step at a time; steps of a published funnel need a published page.',
      keywords: ['assign page to step', 'connect page'],
      risk: 'write',
      input: z.object({ id: id('funnel'), stepId: id('funnel step'), landingPageId: id('landing page') }),
      output: funnel,
      handler: ({ id: fid, stepId, landingPageId }, ctx) => {
        const f = ctx.get('funnels', fid, 'funnel');
        const s = findStep(f, stepId);
        const lp = ctx.get('landing_pages', landingPageId, 'landing page');
        if (s.landingPageId === lp.id) fail('DUPLICATE', `landing page ${lp.id} is already linked to step ${s.id}`);
        for (const other of ctx.all('funnels'))
          for (const os of other.steps)
            if (os.landingPageId === lp.id)
              fail('CONFLICT', `landing page ${lp.id} '${lp.name}' is already used by step ${os.id} '${os.name}' of funnel ${other.id} '${other.name}'; create or pick another landing page`);
        if (f.status === 'published' && lp.status !== 'published')
          fail('INVALID_STATE', `funnel ${f.id} is live and landing page ${lp.id} '${lp.name}' is ${lp.status}; publish the page first (Publish landing page)`);
        s.landingPageId = lp.id;
        return ctx.patch(f, {});
      },
      example: (ctx) => {
        const f = byName(ctx, 'Free 7-Day Meal Plan');
        const lp = ctx.all('landing_pages').find((p) => !ctx.all('funnels').some((x) => x.steps.some((s) => s.landingPageId === p.id)));
        return { id: f.id, stepId: f.steps[1].id, landingPageId: lp.id };
      },
    },
    {
      id: 'set_funnel_conversion_goal', name: 'Set funnel conversion goal',
      description: 'Define what counts as a conversion for a funnel (form_submit on an optin step, purchase on a sales/upsell/downsell step, booking on a booking step) and the target conversion rate in percent.',
      keywords: ['funnel kpi', 'target rate', 'conversion target'],
      risk: 'write',
      input: z.object({
        id: id('funnel'), type: z.enum(Object.keys(GOAL_STEPS)),
        targetRate: z.number().gt(0).max(100).describe('target conversion rate in percent of first-step visitors, e.g. 3.5'),
        stepId: z.string().optional().describe('step where the conversion happens; defaults to the first compatible step'),
      }),
      output: funnel,
      handler: ({ id: fid, type, targetRate, stepId }, ctx) => {
        const f = ctx.get('funnels', fid, 'funnel');
        const ok = GOAL_STEPS[type];
        const s = stepId ? findStep(f, stepId) : f.steps.find((x) => ok.includes(x.type));
        if (!s) fail('INVALID_STATE', `a '${type}' goal needs a ${ok.join('/')} step and funnel ${f.id} has none (steps: ${stepList(f)}); add one with Add funnel step`);
        if (!ok.includes(s.type)) fail('VALIDATION', `step ${s.id} is a ${s.type} step; a '${type}' goal must be on a ${ok.join('/')} step`);
        return ctx.patch(f, { goal: { type, targetRate, stepId: s.id } });
      },
      example: (ctx) => ({ id: byName(ctx, 'New Patient $99 Cleaning').id, type: 'booking', targetRate: 12 }),
    },
    {
      id: 'publish_funnel', name: 'Publish funnel',
      description: 'Make a whole multi-step funnel live. Every step must be linked to a published landing page; otherwise fails and lists the steps that are not ready. Publishing a single landing page or a website are separate actions.',
      keywords: ['launch funnel', 'go live funnel'],
      ...ops.transition('funnels', {
        to: 'published', from: ['draft', 'unpublished'], risk: 'external', what: 'funnel',
        guard: (f, i, ctx) => {
          if (!f.steps.length) fail('INVALID_STATE', `funnel ${f.id} has no steps; add steps with Add funnel step first`);
          const failingSteps = [];
          for (const s of f.steps) {
            const lp = s.landingPageId && ctx.find('landing_pages', s.landingPageId);
            const reason = !s.landingPageId ? 'no landing page linked' : !lp ? `linked landing page ${s.landingPageId} no longer exists` : lp.status !== 'published' ? `landing page ${lp.id} '${lp.name}' is ${lp.status}` : null;
            if (reason) failingSteps.push({ stepId: s.id, name: s.name, reason });
          }
          if (failingSteps.length)
            fail('INVALID_STATE', `cannot publish funnel ${f.id}: ${failingSteps.length} of ${f.steps.length} steps not ready — ${failingSteps.map((x) => `${x.stepId} '${x.name}': ${x.reason}`).join('; ')}. Publish or link a landing page for each.`, { failingSteps });
        },
        extra: (f, i, ctx) => {
          const domain = f.websiteId && ctx.find('websites', f.websiteId)?.domain;
          return { publishedAt: ctx.now, publishedUrl: `https://${domain || 'funnels.askai.test'}/${slugify(f.name)}`, metrics: f.metrics || { period: 'last_30_days', steps: [] } };
        },
      }),
      example: (ctx) => ({ id: byName(ctx, 'New Patient $99 Cleaning').id }),
    },
    {
      id: 'get_funnel_metrics', name: 'Get funnel conversion metrics',
      description: 'Per-step visits, conversions, conversion rate and drop-off to the next step for a funnel (last 30 days), plus overall conversion vs. the goal target. Only for funnels that have been published.',
      keywords: ['funnel analytics', 'drop off', 'conversion rate', 'funnel performance'],
      risk: 'read',
      input: z.object({ id: id('funnel') }),
      output: z.looseObject({
        funnelId: z.string(), period: z.string(), overallConversionRate: z.number(), goalMet: z.boolean().nullable(),
        steps: z.array(z.looseObject({ stepId: z.string(), visits: z.number(), conversions: z.number(), conversionRate: z.number(), dropOffRate: z.number().nullable() })),
      }),
      handler: ({ id: fid }, ctx) => {
        const f = ctx.get('funnels', fid, 'funnel');
        if (!f.metrics) fail('INVALID_STATE', `funnel ${f.id} '${f.name}' is ${f.status} and has never been published, so it has no traffic yet`);
        const steps = f.steps.map((s) => {
          const m = f.metrics.steps.find((x) => x.stepId === s.id) || { visits: 0, conversions: 0 };
          return { stepId: s.id, name: s.name, type: s.type, visits: m.visits, conversions: m.conversions, conversionRate: pct(m.conversions, m.visits) };
        });
        steps.forEach((s, i) => (s.dropOffRate = i < steps.length - 1 ? pct(s.visits - steps[i + 1].visits, s.visits) : null));
        const goalStep = steps.find((s) => s.stepId === f.goal?.stepId) || steps.filter((s) => s.type !== 'thankyou').at(-1);
        const overall = pct(goalStep?.conversions || 0, steps[0]?.visits || 0);
        const worst = steps.filter((s) => s.dropOffRate != null).sort((a, b) => b.dropOffRate - a.dropOffRate)[0];
        return {
          funnelId: f.id, name: f.name, status: f.status, period: f.metrics.period, steps,
          overallConversionRate: overall, goal: f.goal, goalMet: f.goal ? overall >= f.goal.targetRate : null,
          biggestDropOff: worst ? { stepId: worst.stepId, name: worst.name, dropOffRate: worst.dropOffRate } : null,
        };
      },
      example: (ctx) => ({ id: byName(ctx, 'Marketing Masterclass Webinar').id }),
    },
  ],

  // Landing-page links are filled in by the landing_pages seed (it runs after this one).
  seed(ctx, h) {
    const site = (n) => ctx.all('websites').find((w) => w.name === n) ?? null;
    const funnels = [
      { name: 'Marketing Masterclass Webinar', description: 'Free live webinar → replay offer → VIP coaching upsell', status: 'published',
        steps: [['Webinar Registration', 'optin', 4200, 1260], ['Replay Offer', 'sales', 1180, 71], ['VIP Coaching Upsell', 'upsell', 71, 18], ['Thank You', 'thankyou', 71, 71]],
        goal: { type: 'purchase', targetRate: 2.5, step: 1 } },
      { name: 'Free 7-Day Meal Plan', site: 'Summit Fitness Studio', description: 'Lead magnet: meal plan PDF download in exchange for email', status: 'draft',
        steps: [['Meal Plan Opt-in', 'optin'], ['Download Page', 'thankyou']] },
      { name: 'New Patient $99 Cleaning', site: 'Bright Smile Dental', description: 'Paid-ads offer for new dental patients', status: 'draft',
        steps: [['Offer Page', 'optin'], ['Book Your Visit', 'booking'], ['See You Soon', 'thankyou']] },
      { name: 'Summer Shred Challenge', site: 'Summit Fitness Studio', description: '6-week challenge enrolment (ended in September)', status: 'unpublished',
        steps: [['Challenge Signup', 'sales', 2300, 138], ['Nutrition Add-on', 'upsell', 138, 41], ['Welcome', 'thankyou', 138, 138]],
        goal: { type: 'purchase', targetRate: 8, step: 0 } },
      { name: 'Holiday Gift Card Sale', site: 'Crescent Spa', description: 'Not built yet', status: 'draft', steps: [] },
      { name: 'Free Case Review', site: 'Northstar Legal', description: 'Personal-injury consult booking', status: 'published',
        steps: [['Case Details', 'optin', 1850, 420], ['Pick a Time', 'booking', 410, 160], ['Confirmed', 'thankyou', 160, 160]],
        goal: { type: 'booking', targetRate: 10, step: 1 } },
    ];
    funnels.forEach((d, i) => {
      const steps = d.steps.map(([name, type]) => ({ id: ctx.newId('fstp'), name, type, path: slugify(name), landingPageId: null }));
      const hasTraffic = d.steps[0]?.length > 2;
      const createdAt = h.daysAgo(160 - i * 20);
      const w = d.site ? site(d.site) : null;
      ctx.insert('funnels', {
        name: d.name, description: d.description, websiteId: w?.id ?? null, status: d.status, steps,
        goal: d.goal ? { type: d.goal.type, targetRate: d.goal.targetRate, stepId: steps[d.goal.step].id } : null,
        metrics: hasTraffic ? { period: 'last_30_days', steps: d.steps.map(([, , visits, conversions], j) => ({ stepId: steps[j].id, visits, conversions })) } : null,
        publishedAt: hasTraffic ? h.daysAgo(90 - i * 10) : null,
        publishedUrl: hasTraffic ? `https://${w?.domain || 'funnels.askai.test'}/${slugify(d.name)}` : null, // same rule as publish_funnel
        createdAt, updatedAt: createdAt,
      });
    });
  },
});
