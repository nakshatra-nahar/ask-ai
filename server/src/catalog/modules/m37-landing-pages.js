import { defineModule, ops, z, id, entity, fail } from '../kit.js';

const STATUSES = ['draft', 'published', 'unpublished'];
const SECTION_TYPES = ['hero', 'features', 'benefits', 'testimonials', 'pricing', 'faq', 'video', 'form', 'cta', 'text', 'gallery', 'download'];
const MAX_SECTIONS = 20;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const section = z.looseObject({ id: z.string(), type: z.enum(SECTION_TYPES), heading: z.string(), content: z.string().nullable().optional(), mediaUrl: z.string().nullable().optional() });
const landingPage = entity({
  name: z.string(), slug: z.string(), websiteId: z.string().nullable(), status: z.enum(STATUSES),
  headline: z.string().nullable(), body: z.string().nullable(), cta: z.looseObject({ text: z.string(), url: z.string().nullable().optional() }).nullable(),
  sections: z.array(section), formId: z.string().nullable(),
  seo: z.looseObject({ title: z.string().nullable().optional(), description: z.string().nullable().optional(), keywords: z.array(z.string()).optional(), noIndex: z.boolean().optional() }).nullable(),
  publishedAt: z.string().nullable(), publishedUrl: z.string().nullable(),
});

const byName = (ctx, name) => ctx.all('landing_pages').find((p) => p.name === name);
const usedBy = (ctx, lpId) => {
  for (const f of ctx.all('funnels')) for (const s of f.steps || []) if (s.landingPageId === lpId) return { funnel: f, step: s };
  return null;
};

export default defineModule({
  id: 'landing_pages',
  code: 'M37',
  name: 'Landing Pages',
  description: 'Build and publish individual conversion pages.',
  tables: { landing_pages: { prefix: 'lp', schema: landingPage } },
  actions: [
    {
      id: 'create_landing_page', name: 'Create landing page',
      description: 'Create a standalone draft landing page (single conversion page with a unique URL slug). Use Add website page for pages of a multi-page site.',
      keywords: ['new landing page', 'squeeze page', 'opt-in page', 'sales page'],
      ...ops.create('landing_pages', {
        input: z.object({
          name: z.string().min(1).max(80), slug: z.string().regex(SLUG, 'slug must be lowercase letters, digits and single hyphens').describe('URL slug, e.g. free-consult'),
          headline: z.string().min(1).max(120).optional(), websiteId: z.string().optional().describe('website whose domain serves the page'),
        }),
        check: (i, ctx) => {
          const dup = ctx.all('landing_pages').find((p) => p.slug === i.slug);
          if (dup) fail('DUPLICATE', `slug '${i.slug}' is already used by landing page ${dup.id} '${dup.name}'`, { existingId: dup.id });
          if (i.websiteId) ctx.get('websites', i.websiteId, 'website');
        },
        build: (i) => ({ headline: i.headline ?? null, websiteId: i.websiteId ?? null, status: 'draft', body: null, cta: null, sections: [], formId: null, seo: null, publishedAt: null, publishedUrl: null }),
      }),
      example: () => ({ name: 'Botox Intro Offer', slug: 'botox-intro-offer', headline: '$50 off your first Botox visit' }),
    },
    {
      id: 'get_landing_page', name: 'Get landing page',
      description: 'Fetch one landing page by ID with headline, body, CTA, sections, attached form, SEO metadata and publish status.',
      ...ops.get('landing_pages', { what: 'landing page' }),
      example: (ctx) => ({ id: byName(ctx, 'Masterclass Registration').id }),
    },
    {
      id: 'search_landing_pages', name: 'Search landing pages',
      description: 'Find landing pages by name/headline/slug text, status, website, or attached form.',
      keywords: ['find landing page', 'list landing pages'],
      ...ops.search('landing_pages', {
        text: ['name', 'headline', 'slug'],
        filters: { status: z.enum(STATUSES).optional(), websiteId: z.string().optional(), formId: z.string().optional() },
      }),
      example: () => ({ status: 'draft' }),
    },
    {
      id: 'update_page_content', name: 'Update page content',
      description: 'Edit a landing page\'s main copy: headline, body text, and call-to-action button (text + optional link). Sections are managed separately.',
      keywords: ['edit headline', 'change copy', 'cta button'],
      ...ops.update('landing_pages', {
        what: 'landing page',
        fields: {
          headline: z.string().min(1).max(120), body: z.string().max(5000),
          cta: z.object({ text: z.string().min(1).max(40), url: z.url({ protocol: /^https?$/ }).optional() }).describe('call-to-action button'),
        },
      }),
      example: (ctx) => ({ id: byName(ctx, 'Holiday Gift Cards').id, headline: 'Give the gift of calm this season', cta: { text: 'Buy a gift card' } }),
    },
    {
      id: 'add_page_section', name: 'Add page section',
      description: `Append a content block to a landing page (types: ${SECTION_TYPES.join(', ')}). Max ${MAX_SECTIONS} sections. A form section on a live page needs a form attached first.`,
      keywords: ['add block', 'testimonials section', 'faq section'],
      ...ops.addItem('landing_pages', 'sections', {
        type: z.enum(SECTION_TYPES), heading: z.string().min(1).max(120), content: z.string().max(5000).optional(),
        mediaUrl: z.string().optional().describe('image/video URL, e.g. a media asset url'),
      }, {
        prefix: 'lsec', what: 'landing page',
        guard: (rec, item) => {
          if (rec.sections.length >= MAX_SECTIONS) fail('LIMIT_EXCEEDED', `landing page ${rec.id} already has ${MAX_SECTIONS} sections (the maximum)`);
          if (item.type === 'form' && rec.status === 'published' && !rec.formId)
            fail('INVALID_STATE', `landing page ${rec.id} is live and has no form attached; use Attach form to page before adding a form section`);
        },
      }),
      example: (ctx) => ({ id: byName(ctx, 'Holiday Gift Cards').id, type: 'pricing', heading: 'Gift card options', content: '$50 · $100 · $200 — never expire' }),
    },
    {
      id: 'reorder_page_sections', name: 'Reorder page sections',
      description: 'Set the order of a landing page\'s sections by passing every section ID in the new order.',
      ...ops.reorder('landing_pages', 'sections', { what: 'landing page' }),
      example: (ctx) => {
        const p = byName(ctx, 'Masterclass Registration');
        return { id: p.id, orderedIds: [...p.sections.map((s) => s.id)].reverse() };
      },
    },
    {
      id: 'attach_form_to_page', name: 'Attach form to page',
      description: 'Embed an existing form (forms ID) on a landing page so submissions are captured there. Replaces any previously attached form; archived forms are rejected.',
      keywords: ['embed form', 'opt-in form', 'lead form'],
      ...ops.set('landing_pages', 'formId', id('form'), {
        param: 'formId', what: 'landing page',
        guard: (rec, i, ctx) => {
          const f = ctx.get('forms', i.formId, 'form');
          if (f.status === 'archived') fail('INVALID_STATE', `form ${f.id} is archived; restore it or choose an active form`);
          if (rec.formId === f.id) fail('DUPLICATE', `form ${f.id} is already attached to landing page ${rec.id}`);
        },
      }),
      example: (ctx) => {
        const formId = ctx.all('forms').find((f) => f.status !== 'archived')?.id;
        return { id: byName(ctx, 'Free Trial Class Signup').id, formId };
      },
    },
    {
      id: 'set_page_seo', name: 'Set page SEO metadata',
      description: 'Set search/social metadata for one landing page: SEO title (max 60), meta description (max 160), keywords, noIndex. Not for site-wide defaults or blog posts.',
      keywords: ['meta description', 'page title', 'noindex'],
      risk: 'write',
      input: z.object({
        id: id('landing page'),
        title: z.string().min(1).max(60, 'SEO title must be 60 characters or fewer').optional(),
        description: z.string().min(1).max(160, 'meta description must be 160 characters or fewer').optional(),
        keywords: z.array(z.string().min(1)).max(10).optional(),
        noIndex: z.boolean().optional().describe('hide from search engines'),
      }),
      output: landingPage,
      handler: ({ id: pid, ...seo }, ctx) => {
        const p = ctx.get('landing_pages', pid, 'landing page');
        if (!Object.keys(seo).length) fail('VALIDATION', 'provide at least one of title, description, keywords, noIndex');
        return ctx.patch(p, { seo: { ...p.seo, ...seo } });
      },
      example: (ctx) => ({ id: byName(ctx, 'Invisalign Info Night').id, title: 'Invisalign Info Night | Bright Smile Dental', description: 'Free Q&A evening with Dr. Patel. Learn how clear aligners work and get a $500 treatment credit.' }),
    },
    {
      id: 'publish_landing_page', name: 'Publish landing page',
      description: 'Make one landing page live at its URL. Requires a headline and at least one section; a page with a form section must have a form attached. Publishing a whole funnel or website are separate actions.',
      keywords: ['go live page', 'launch landing page'],
      ...ops.transition('landing_pages', {
        to: 'published', from: ['draft', 'unpublished'], risk: 'external', what: 'landing page',
        guard: (p) => {
          const missing = [!p.headline && 'a headline (Update page content)', !p.sections.length && 'at least one section (Add page section)'].filter(Boolean);
          if (missing.length) fail('INVALID_STATE', `landing page ${p.id} cannot be published; it needs ${missing.join(' and ')}`);
          if (!p.formId && p.sections.some((s) => s.type === 'form')) fail('INVALID_STATE', `landing page ${p.id} has a form section but no form attached; use Attach form to page first`);
        },
        extra: (p, i, ctx) => {
          const domain = p.websiteId && ctx.find('websites', p.websiteId)?.domain;
          return { publishedAt: ctx.now, publishedUrl: `https://${domain || 'pages.askai.test'}/${p.slug}` };
        },
      }),
      example: (ctx) => ({ id: byName(ctx, 'Invisalign Info Night').id }),
    },
    {
      id: 'unpublish_landing_page', name: 'Unpublish landing page',
      description: 'Take one published landing page offline. Blocked while it backs a step of a published funnel (link another published page to that step first).',
      keywords: ['take page down', 'disable landing page'],
      ...ops.transition('landing_pages', {
        to: 'unpublished', from: ['published'], risk: 'external', what: 'landing page',
        guard: (p, i, ctx) => {
          const u = usedBy(ctx, p.id);
          if (u?.funnel.status === 'published')
            fail('CONFLICT', `landing page ${p.id} backs step ${u.step.id} '${u.step.name}' of published funnel ${u.funnel.id} '${u.funnel.name}'; link another published landing page to that step first (Link landing page to step)`);
        },
        extra: (p, i, ctx) => ({ unpublishedAt: ctx.now }),
      }),
      example: (ctx) => ({ id: byName(ctx, 'Teeth Whitening Promo').id }),
    },
  ],

  seed(ctx, h) {
    const site = (n) => ctx.all('websites').find((w) => w.name === n);
    const form = ctx.all('forms').find((f) => f.status !== 'archived') || null;
    // [name, slug, website, status, headline, sections[[type, heading, content]], funnel link [funnelName, stepName]]
    const pages = [
      ['Masterclass Registration', 'masterclass-register', null, 'published', 'Free Masterclass: Fill Your Calendar in 30 Days', [['hero', 'Live this Thursday at 1pm ET', 'Join 2,000+ owners'], ['benefits', 'What you will learn', '3 ad templates, the follow-up script, the 5-minute booking flow'], ['form', 'Save my seat', null]], ['Marketing Masterclass Webinar', 'Webinar Registration']],
      ['Masterclass Replay Offer', 'masterclass-replay', null, 'published', 'Watch the replay + get the full playbook', [['video', 'Masterclass replay', null], ['pricing', 'Playbook — $297', 'One-time payment, lifetime access']], ['Marketing Masterclass Webinar', 'Replay Offer']],
      ['VIP Coaching Upsell', 'vip-coaching', null, 'published', 'Add 4 weeks of 1:1 coaching', [['pricing', 'VIP Coaching — $997', 'Weekly calls + Slack access']], ['Marketing Masterclass Webinar', 'VIP Coaching Upsell']],
      ['Masterclass Thank You', 'masterclass-thanks', null, 'published', "You're in!", [['text', 'Check your inbox', 'Your login details are on the way.']], ['Marketing Masterclass Webinar', 'Thank You']],
      ['Meal Plan Opt-in', 'free-meal-plan', 'Summit Fitness Studio', 'published', 'Get our free 7-day high-protein meal plan', [['hero', 'Eat for your goals', 'Designed by our in-house nutritionist'], ['form', 'Send me the plan', null]], ['Free 7-Day Meal Plan', 'Meal Plan Opt-in']],
      ['Meal Plan Download', 'meal-plan-download', 'Summit Fitness Studio', 'draft', 'Your meal plan is ready', [['download', 'Download the PDF', null]], ['Free 7-Day Meal Plan', 'Download Page']],
      ['New Patient Cleaning Offer', 'new-patient-99', 'Bright Smile Dental', 'published', 'New patients: exam, X-rays & cleaning for $99', [['hero', 'Gentle care for the whole family', null], ['testimonials', '4.9★ from 600+ patients', null], ['cta', 'Claim your $99 visit', null]], ['New Patient $99 Cleaning', 'Offer Page']],
      ['Book Your Cleaning', 'book-cleaning', 'Bright Smile Dental', 'published', 'Pick a time that works for you', [['text', 'Choose a slot', 'Morning, evening and Saturday appointments']], ['New Patient $99 Cleaning', 'Book Your Visit']],
      ['Cleaning Confirmed', 'cleaning-confirmed', 'Bright Smile Dental', 'published', 'See you soon!', [['text', 'What to bring', 'Photo ID and insurance card']], ['New Patient $99 Cleaning', 'See You Soon']],
      ['Summer Shred Signup', 'summer-shred', 'Summit Fitness Studio', 'unpublished', '6 weeks. 3 coaches. Your strongest summer.', [['hero', 'Summer Shred Challenge', null], ['pricing', '$149 for 6 weeks', null]], ['Summer Shred Challenge', 'Challenge Signup']],
      ['Free Case Review', 'free-case-review', 'Northstar Legal', 'published', 'Injured? Get a free case review in 24 hours', [['hero', 'No fee unless we win', null], ['form', 'Tell us what happened', null]], ['Free Case Review', 'Case Details']],
      ['Consult Scheduler', 'consult-schedule', 'Northstar Legal', 'published', 'Book your free 20-minute consultation', [['text', 'Pick a time', null]], ['Free Case Review', 'Pick a Time']],
      ['Consult Confirmed', 'consult-confirmed', 'Northstar Legal', 'published', 'Your consultation is booked', [['text', 'Next steps', 'An attorney will call you at the scheduled time.']], ['Free Case Review', 'Confirmed']],
      ['Teeth Whitening Promo', 'whitening-promo', 'Bright Smile Dental', 'published', 'Professional whitening — 40% off in November', [['hero', 'Brighter in one visit', null], ['faq', 'Whitening FAQ', 'Is it safe? How long does it last?']], null],
      ['Invisalign Info Night', 'invisalign-night', 'Bright Smile Dental', 'draft', 'Straighter teeth without metal braces', [['hero', 'Free Invisalign Info Night — Nov 20', null], ['faq', 'Your questions answered', null]], null],
      ['Holiday Gift Cards', 'spa-gift-cards', 'Crescent Spa', 'draft', null, [], null],
      ['Free Trial Class Signup', 'free-trial-class', 'Summit Fitness Studio', 'draft', 'Your first class is on us', [['hero', 'Try any class free', null], ['form', 'Claim your free class', null]], null],
    ];
    pages.forEach(([name, slug, siteName, status, headline, secs0, link], i) => {
      const w = siteName ? site(siteName) : null;
      const live = status !== 'draft';
      // A live page with a form section must have a form (publish rule); without any usable form, drop the section.
      const secs = live && !form ? secs0.filter((s) => s[0] !== 'form') : secs0;
      const createdAt = h.daysAgo(140 - i * 6);
      const rec = ctx.insert('landing_pages', {
        name, slug, websiteId: w?.id ?? null, status, headline, body: null,
        cta: headline ? { text: secs.some((s) => s[0] === 'form') ? 'Submit' : 'Get started', url: null } : null,
        sections: secs.map(([type, heading, content]) => ({ id: ctx.newId('lsec'), type, heading, content, mediaUrl: null })),
        formId: live && secs.some((s) => s[0] === 'form') ? form.id : null,
        seo: live ? { title: name, description: headline, keywords: [], noIndex: false } : null,
        publishedAt: live ? h.daysAgo(100 - i * 4) : null,
        publishedUrl: live ? `https://${w?.domain || 'pages.askai.test'}/${slug}` : null,
        createdAt, updatedAt: createdAt,
      });
      if (!link) return;
      const step = ctx.all('funnels').find((f) => f.name === link[0])?.steps.find((s) => s.name === link[1]);
      if (step) step.landingPageId = rec.id;
    });
  },
});
