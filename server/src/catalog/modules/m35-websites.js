import { defineModule, ops, z, id, entity, fail } from '../kit.js';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOMAIN = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const STATUSES = ['draft', 'published', 'unpublished'];
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const httpUrl = () => z.url({ protocol: /^https?$/ });

const pageItem = z.looseObject({ id: z.string(), title: z.string(), slug: z.string() });
const navItem = z.looseObject({ id: z.string(), label: z.string(), pageId: z.string().nullable(), url: z.string().nullable() });
const website = entity({
  name: z.string(), domain: z.string().nullable(), status: z.enum(STATUSES),
  pages: z.array(pageItem), homePageId: z.string().nullable(), navigation: z.array(navItem),
  seo: z.looseObject({ titleTemplate: z.string().nullable(), metaDescription: z.string().nullable(), ogImage: z.string().nullable() }).nullable(),
  publishedAt: z.string().nullable(), publishedUrl: z.string().nullable(),
});

const pageList = (w) => w.pages.map((p) => `${p.id} '${p.title}' (/${p.slug})`).join(', ') || 'none';
const byName = (ctx, name) => ctx.all('websites').find((w) => w.name === name);

function uniqueName(ctx, name, selfId) {
  const dup = ctx.all('websites').find((w) => w.id !== selfId && w.name.toLowerCase() === name.toLowerCase());
  if (dup) fail('DUPLICATE', `a website named '${name}' already exists (${dup.id})`, { existingId: dup.id });
}

export default defineModule({
  id: 'websites',
  code: 'M35',
  name: 'Websites',
  description: 'Manage sites and their page collections.',
  tables: { websites: { prefix: 'web', schema: website } },
  actions: [
    {
      id: 'create_website', name: 'Create website',
      description: 'Create a new multi-page website (draft, no pages yet). Optionally connect a custom domain; names and domains must be unique. For a single conversion page use Create landing page; for a step-by-step journey use Create funnel.',
      keywords: ['new site', 'build website', 'add domain'],
      ...ops.create('websites', {
        input: z.object({
          name: z.string().min(1).max(80),
          domain: z.string().regex(DOMAIN, 'domain must look like example.com').optional().describe('custom domain, e.g. brightsmiledental.com'),
        }),
        check: (i, ctx) => {
          uniqueName(ctx, i.name);
          const dup = i.domain && ctx.all('websites').find((w) => w.domain?.toLowerCase() === i.domain.toLowerCase());
          if (dup) fail('DUPLICATE', `domain ${i.domain} is already connected to website ${dup.id} '${dup.name}'`, { existingId: dup.id });
        },
        build: (i) => ({
          domain: i.domain?.toLowerCase() ?? null, status: 'draft', pages: [], homePageId: null, navigation: [], seo: null,
          publishedAt: null, publishedUrl: null,
        }),
      }),
      example: () => ({ name: 'Maple Street Bakery', domain: 'maplestreetbakery.com' }),
    },
    {
      id: 'get_website', name: 'Get website settings',
      description: 'Fetch one website by ID with its domain, status, pages, home page, navigation menu and SEO defaults.',
      keywords: ['site details', 'site config', 'website pages'],
      ...ops.get('websites', { what: 'website' }),
      example: (ctx) => ({ id: byName(ctx, 'Bright Smile Dental').id }),
    },
    {
      id: 'list_websites', name: 'List websites',
      description: 'List websites in the account, filterable by status (draft/published/unpublished) or name/domain text.',
      keywords: ['all sites', 'my websites', 'find site'],
      ...ops.search('websites', { text: ['name', 'domain'], filters: { status: z.enum(STATUSES).optional() } }),
      example: () => ({ status: 'published' }),
    },
    {
      id: 'rename_website', name: 'Rename website',
      description: 'Change the display name of a website (not its domain or page slugs). Names must be unique.',
      ...ops.set('websites', 'name', z.string().min(1).max(80), { what: 'website', guard: (r, i, ctx) => uniqueName(ctx, i.name, r.id) }),
      example: (ctx) => ({ id: byName(ctx, 'Summit Fitness Studio').id, name: 'Summit Fitness & Yoga' }),
    },
    {
      id: 'add_website_page', name: 'Add website page',
      description: 'Add a page (title + URL slug) to a website. Slugs must be unique within that site. Not for standalone landing pages or blog posts.',
      keywords: ['new page', 'add page to site'],
      ...ops.addItem('websites', 'pages', {
        title: z.string().min(1).max(80),
        slug: z.string().regex(SLUG, 'slug must be lowercase letters, digits and single hyphens, e.g. patient-forms').describe('URL path segment, e.g. patient-forms'),
      }, {
        prefix: 'wpg', what: 'website',
        guard: (rec, item) => {
          const dup = rec.pages.find((p) => p.slug === item.slug);
          if (dup) fail('DUPLICATE', `website ${rec.id} already has a page with slug '/${item.slug}' (${dup.id} '${dup.title}'); choose another slug`);
        },
      }),
      example: (ctx) => ({ id: byName(ctx, 'Bright Smile Dental').id, title: 'Patient Forms', slug: 'patient-forms' }),
    },
    {
      id: 'set_website_home_page', name: 'Set website home page',
      description: 'Choose which of the website\'s own pages is served at the root URL (/). The page must already belong to that site.',
      keywords: ['homepage', 'landing route', 'root page'],
      ...ops.set('websites', 'homePageId', id('website page'), {
        param: 'pageId', what: 'website',
        guard: (rec, i) => {
          if (!rec.pages.some((p) => p.id === i.pageId))
            fail('NOT_FOUND', `page ${i.pageId} is not a page of website ${rec.id}; its pages are: ${pageList(rec)}. Add the page first with Add website page.`);
        },
      }),
      example: (ctx) => {
        const w = byName(ctx, 'Greenleaf Landscaping');
        return { id: w.id, pageId: w.pages[0].id };
      },
    },
    {
      id: 'update_site_navigation', name: 'Update site navigation',
      description: 'Replace a website\'s menu with an ordered list of items; each item links either to one of the site\'s pages (pageId) or to an external URL (url), never both.',
      keywords: ['menu', 'nav bar', 'header links'],
      risk: 'write',
      input: z.object({
        id: id('website'),
        items: z.array(z.object({
          label: z.string().min(1).max(30),
          pageId: z.string().optional().describe('ID of a page on this website'),
          url: httpUrl().optional().describe('external http(s) URL'),
        })).min(1).max(10).describe('menu items in display order'),
      }),
      output: website,
      handler: ({ id: wid, items }, ctx) => {
        const w = ctx.get('websites', wid, 'website');
        items.forEach((it, i) => {
          if (!it.pageId === !it.url) fail('VALIDATION', `items[${i}] '${it.label}' must have exactly one of pageId or url`);
          if (it.pageId && !w.pages.some((p) => p.id === it.pageId))
            fail('NOT_FOUND', `items[${i}] pageId ${it.pageId} is not a page of website ${w.id}; its pages are: ${pageList(w)}`);
        });
        const navigation = items.map((it) => ({ id: ctx.newId('wnav'), label: it.label, pageId: it.pageId ?? null, url: it.url ?? null }));
        return ctx.patch(w, { navigation });
      },
      example: (ctx) => {
        const w = byName(ctx, 'Summit Fitness Studio');
        return {
          id: w.id,
          items: [
            { label: 'Home', pageId: w.pages[0].id }, { label: 'Classes', pageId: w.pages[1].id },
            { label: 'Shop', url: 'https://shop.summitfitness.studio' },
          ],
        };
      },
    },
    {
      id: 'set_site_seo_defaults', name: 'Set site SEO defaults',
      description: 'Set site-wide SEO defaults for a whole website: page title template (must contain %s for the page title), default meta description (max 160 chars) and default social share (og) image. Per-page SEO for landing pages or blog posts is a different action.',
      keywords: ['meta tags', 'search engine', 'og image', 'title template'],
      risk: 'write',
      input: z.object({
        id: id('website'),
        titleTemplate: z.string().max(70).refine((s) => s.includes('%s'), 'titleTemplate must contain %s where the page title goes, e.g. "%s | Bright Smile Dental"').optional(),
        metaDescription: z.string().min(1).max(160, 'metaDescription must be 160 characters or fewer').optional(),
        ogImage: httpUrl().optional().describe('absolute image URL used when the site is shared'),
      }),
      output: website,
      handler: ({ id: wid, ...seo }, ctx) => {
        const w = ctx.get('websites', wid, 'website');
        if (!Object.keys(seo).length) fail('VALIDATION', 'provide at least one of titleTemplate, metaDescription, ogImage');
        return ctx.patch(w, { seo: { titleTemplate: null, metaDescription: null, ogImage: null, ...w.seo, ...seo } });
      },
      example: (ctx) => ({
        id: byName(ctx, 'Summit Fitness Studio').id, titleTemplate: '%s | Summit Fitness Studio',
        metaDescription: 'Boutique HIIT, yoga and strength classes in Denver. Book your first class free.',
      }),
    },
    {
      id: 'publish_website', name: 'Publish website',
      description: 'Make an entire website live on its domain (or a default subdomain). Requires a home page. Only for draft/unpublished sites — publishing a funnel, landing page or blog post are separate actions.',
      keywords: ['go live', 'launch site', 'deploy website'],
      ...ops.transition('websites', {
        to: 'published', from: ['draft', 'unpublished'], risk: 'external', what: 'website',
        guard: (rec) => {
          if (!rec.homePageId) fail('INVALID_STATE', `website ${rec.id} has no home page; set one first with Set website home page (pages: ${pageList(rec)})`);
        },
        extra: (rec, i, ctx) => ({ publishedAt: ctx.now, publishedUrl: rec.domain ? `https://${rec.domain}` : `https://${slugify(rec.name)}.sites.askai.test` }),
      }),
      example: (ctx) => ({ id: byName(ctx, 'Summit Fitness Studio').id }),
    },
    {
      id: 'unpublish_website', name: 'Unpublish website',
      description: 'Take a published website offline (visitors get a not-found page). Content is kept and it can be republished. Does not affect funnels or landing pages.',
      keywords: ['take site down', 'offline', 'disable website'],
      ...ops.transition('websites', { to: 'unpublished', from: ['published'], risk: 'external', what: 'website', extra: (r, i, ctx) => ({ unpublishedAt: ctx.now }) }),
      example: (ctx) => ({ id: byName(ctx, 'Bright Smile Dental').id }),
    },
  ],

  seed(ctx, h) {
    const sites = [
      { name: 'Bright Smile Dental', domain: 'brightsmiledental.com', status: 'published', pages: ['Home', 'Services', 'Meet the Team', 'New Patients', 'Contact'], home: true, nav: true,
        seo: { titleTemplate: '%s | Bright Smile Dental', metaDescription: 'Family and cosmetic dentistry in Austin, TX. New patients welcome — book online today.', ogImage: null } },
      { name: 'Summit Fitness Studio', domain: 'summitfitness.studio', status: 'draft', pages: ['Home', 'Classes', 'Pricing', 'Trainers'], home: true },
      { name: 'Greenleaf Landscaping', domain: 'greenleaflandscaping.com', status: 'draft', pages: ['Home', 'Services'], home: false },
      { name: 'Urban Roast Cafe', domain: 'urbanroastcafe.com', status: 'unpublished', pages: ['Home', 'Menu', 'Catering'], home: true, nav: true },
      { name: 'Northstar Legal', domain: 'northstarlegal.com', status: 'published', pages: ['Home', 'Practice Areas', 'Attorneys', 'Free Case Review'], home: true, nav: true },
      { name: 'Crescent Spa', domain: null, status: 'draft', pages: [], home: false },
    ];
    sites.forEach((s, i) => {
      const pages = s.pages.map((t) => ({ id: ctx.newId('wpg'), title: t, slug: slugify(t) }));
      const navigation = s.nav ? pages.slice(0, 4).map((p) => ({ id: ctx.newId('wnav'), label: p.title, pageId: p.id, url: null })) : [];
      const createdAt = h.daysAgo(200 - i * 25);
      const live = s.status !== 'draft';
      ctx.insert('websites', {
        name: s.name, domain: s.domain, status: s.status, pages, homePageId: s.home ? pages[0].id : null, navigation, seo: s.seo || null,
        publishedAt: live ? h.daysAgo(150 - i * 20) : null, publishedUrl: live ? `https://${s.domain}` : null,
        ...(s.status === 'unpublished' ? { unpublishedAt: h.daysAgo(12) } : {}),
        createdAt, updatedAt: createdAt,
      });
    });
  },
});
