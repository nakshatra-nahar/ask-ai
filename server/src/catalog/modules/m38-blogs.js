import { defineModule, ops, z, id, entity, isoDate, fail, addDays } from '../kit.js';

const STATUSES = ['draft', 'scheduled', 'published'];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const post = entity({
  title: z.string(), slug: z.string(), websiteId: z.string().nullable(), authorId: z.string().nullable(), status: z.enum(STATUSES),
  excerpt: z.string().nullable(), body: z.string(), categories: z.array(z.string()), featuredImage: z.string().nullable(),
  seo: z.looseObject({ metaTitle: z.string().nullable().optional(), metaDescription: z.string().nullable().optional(), focusKeyword: z.string().nullable().optional(), canonicalUrl: z.string().nullable().optional() }).nullable(),
  scheduledAt: z.string().nullable(), publishedAt: z.string().nullable(),
});

const byTitle = (ctx, t) => ctx.all('blog_posts').find((p) => p.title === t);

function activeAuthor(ctx, uid) {
  const u = ctx.get('users', uid, 'user');
  if (u.status !== 'active') fail('INVALID_STATE', `user ${uid} (${u.name}) is ${u.status} and cannot author posts; pick an active user`);
  return u;
}
function readyToGoLive(ctx, p) {
  if (!p.authorId) fail('INVALID_STATE', `post ${p.id} has no author; assign one with Assign post author first`);
  const u = ctx.find('users', p.authorId);
  if (u && u.status !== 'active') fail('INVALID_STATE', `post ${p.id} author ${u.id} (${u.name}) is ${u.status}; assign an active author first`);
  if (!p.body?.trim()) fail('INVALID_STATE', `post ${p.id} has an empty body`);
}
function uniqueSlug(ctx, slug, selfId) {
  const dup = ctx.all('blog_posts').find((p) => p.id !== selfId && p.slug === slug);
  if (dup) fail('DUPLICATE', `slug '${slug}' is already used by post ${dup.id} '${dup.title}'`, { existingId: dup.id });
}
function checkImage(ctx, ref) {
  // A media id, or a media-library CDN url (which embeds the id); other external URLs are not checked.
  const mid = ref.match(/^(?:https:\/\/cdn\.askai-media\.test\/assets\/)?(med_\d+)$/)?.[1];
  if (!mid) return;
  const m = ctx.get('media', mid, 'media asset');
  if (m.kind !== 'image') fail('VALIDATION', `media asset ${m.id} is a ${m.kind} (${m.mimeType}); featuredImage must be an image`);
}

export default defineModule({
  id: 'blogs',
  code: 'M38',
  name: 'Blogs',
  description: 'Manage articles and editorial publishing.',
  tables: { blog_posts: { prefix: 'blog', schema: post } },
  actions: [
    {
      id: 'create_blog_post', name: 'Create blog post',
      description: 'Draft a new blog article (title, body, optional excerpt/categories/website). The slug is derived from the title unless given and must be unique.',
      keywords: ['write article', 'new post', 'draft blog'],
      ...ops.create('blog_posts', {
        input: z.object({
          title: z.string().min(1).max(150), body: z.string().min(1), excerpt: z.string().max(300).optional(),
          slug: z.string().regex(SLUG, 'slug must be lowercase letters, digits and single hyphens').optional(),
          websiteId: z.string().optional().describe('website whose blog hosts the post'), categories: z.array(z.string().min(1).max(40)).max(5).optional(),
        }),
        check: (i, ctx) => {
          uniqueSlug(ctx, i.slug || slugify(i.title));
          if (i.websiteId) ctx.get('websites', i.websiteId, 'website');
        },
        build: (i, ctx) => ({
          slug: i.slug || slugify(i.title), excerpt: i.excerpt ?? null, websiteId: i.websiteId ?? null, categories: i.categories || [],
          authorId: ctx.find('users', ctx.actorId)?.status === 'active' ? ctx.actorId : null, status: 'draft',
          featuredImage: null, seo: null, scheduledAt: null, publishedAt: null,
        }),
      }),
      example: () => ({ title: 'Flossing 101: A Quick Guide', body: 'Flossing once a day removes plaque your brush misses...', categories: ['Oral Health'] }),
    },
    {
      id: 'get_blog_post', name: 'Get blog post',
      description: 'Fetch one blog post by ID with body, author, categories, SEO, featured image and publish/schedule status.',
      ...ops.get('blog_posts', { what: 'blog post' }),
      example: (ctx) => ({ id: byTitle(ctx, 'Invisalign vs. Braces: Which Is Right for You?').id }),
    },
    {
      id: 'search_blog_posts', name: 'Search blog posts',
      description: 'Find blog posts by title/excerpt/body text, status (draft/scheduled/published), author, website, category, or published date range.',
      keywords: ['find article', 'list posts', 'scheduled posts'],
      ...ops.search('blog_posts', {
        text: ['title', 'excerpt', 'body'],
        filters: {
          status: z.enum(STATUSES).optional(), authorId: z.string().optional(), websiteId: z.string().optional(),
          categories: z.string().optional().describe('single category the post must have'),
          publishedAtAfter: isoDate().optional(), publishedAtBefore: isoDate().optional(),
        },
        sort: (a, b) => (b.publishedAt || b.createdAt).localeCompare(a.publishedAt || a.createdAt),
      }),
      example: () => ({ status: 'published' }),
    },
    {
      id: 'update_blog_post', name: 'Update blog post',
      description: 'Edit a blog post\'s title, excerpt, body, slug or featured image (media asset ID or image URL). Edits to a published post go live immediately.',
      keywords: ['edit article', 'revise post', 'featured image'],
      ...ops.update('blog_posts', {
        what: 'blog post',
        fields: {
          title: z.string().min(1).max(150), excerpt: z.string().max(300), body: z.string().min(1),
          slug: z.string().regex(SLUG, 'slug must be lowercase letters, digits and single hyphens'),
          featuredImage: z.string().min(1).describe('media asset ID (med_###) or image URL'),
        },
        guard: (rec, i, ctx) => {
          if (i.slug) uniqueSlug(ctx, i.slug, rec.id);
          if (i.featuredImage) checkImage(ctx, i.featuredImage);
        },
      }),
      example: (ctx) => ({ id: byTitle(ctx, 'Teeth Whitening Myths Debunked').id, excerpt: 'No, whitening does not weaken enamel — here is what the research says.' }),
    },
    {
      id: 'assign_post_author', name: 'Assign post author',
      description: 'Set the byline author of a blog post. Author must be an active user.',
      keywords: ['byline', 'writer'],
      ...ops.set('blog_posts', 'authorId', id('user'), { param: 'authorId', what: 'blog post', guard: (r, i, ctx) => activeAuthor(ctx, i.authorId) }),
      example: (ctx) => ({ id: byTitle(ctx, 'Our New Saturday Hours').id, authorId: ctx.all('users').find((u) => u.status === 'active')?.id ?? 'usr_001' }),
    },
    {
      id: 'set_post_categories', name: 'Set post categories',
      description: 'Replace a blog post\'s categories (1-5, duplicates ignored case-insensitively).',
      keywords: ['categorize', 'post topics'],
      ...ops.set('blog_posts', 'categories', z.array(z.string().trim().min(1).max(40)).min(1).max(5), {
        what: 'blog post',
        map: (cats) => cats.filter((c, i) => cats.findIndex((x) => x.toLowerCase() === c.toLowerCase()) === i),
      }),
      example: (ctx) => ({ id: byTitle(ctx, 'Teeth Whitening Myths Debunked').id, categories: ['Cosmetic Dentistry', 'Myths'] }),
    },
    {
      id: 'set_post_seo', name: 'Set post SEO metadata',
      description: 'Set search metadata for one blog post: meta title (max 60), meta description (max 160), focus keyword, canonical URL. Not for landing pages or site-wide defaults.',
      keywords: ['meta description', 'focus keyword', 'canonical'],
      risk: 'write',
      input: z.object({
        id: id('blog post'),
        metaTitle: z.string().min(1).max(60, 'metaTitle must be 60 characters or fewer').optional(),
        metaDescription: z.string().min(1).max(160, 'metaDescription must be 160 characters or fewer').optional(),
        focusKeyword: z.string().min(1).max(60).optional(),
        canonicalUrl: z.url({ protocol: /^https?$/ }).optional(),
      }),
      output: post,
      handler: ({ id: pid, ...seo }, ctx) => {
        const p = ctx.get('blog_posts', pid, 'blog post');
        if (!Object.keys(seo).length) fail('VALIDATION', 'provide at least one of metaTitle, metaDescription, focusKeyword, canonicalUrl');
        return ctx.patch(p, { seo: { ...p.seo, ...seo } });
      },
      example: (ctx) => ({ id: byTitle(ctx, 'Teeth Whitening Myths Debunked').id, metaTitle: 'Teeth Whitening Myths Debunked', focusKeyword: 'teeth whitening' }),
    },
    {
      id: 'schedule_post', name: 'Schedule post publication',
      description: 'Schedule a draft blog post to publish automatically at a future date/time. Requires an active author. To publish right now use Publish post.',
      keywords: ['publish later', 'queue post'],
      risk: 'external',
      input: z.object({ id: id('blog post'), publishAt: isoDate('future ISO datetime, e.g. 2026-11-10T14:00:00Z') }),
      output: post,
      handler: ({ id: pid, publishAt }, ctx) => {
        const p = ctx.get('blog_posts', pid, 'blog post');
        if (p.status !== 'draft') fail('INVALID_STATE', `post ${p.id} is '${p.status}'; only draft posts can be scheduled${p.status === 'scheduled' ? ' (unpublish it to clear the current schedule first)' : ''}`);
        const at = new Date(Date.parse(publishAt)).toISOString();
        if (at <= ctx.now) fail('VALIDATION', `publishAt ${publishAt} is not in the future (now is ${ctx.now})`);
        readyToGoLive(ctx, p);
        return ctx.patch(p, { status: 'scheduled', scheduledAt: at });
      },
      example: (ctx) => ({ id: byTitle(ctx, 'Teeth Whitening Myths Debunked').id, publishAt: addDays(ctx.now, 2) }),
    },
    {
      id: 'publish_post', name: 'Publish post',
      description: 'Publish a blog post on the blog right now (from draft or scheduled). Requires an active author and a body. Not for landing pages, funnels or websites.',
      keywords: ['post article', 'go live blog'],
      ...ops.transition('blog_posts', {
        to: 'published', from: ['draft', 'scheduled'], risk: 'external', what: 'blog post',
        guard: (p, i, ctx) => readyToGoLive(ctx, p),
        extra: (p, i, ctx) => ({ publishedAt: ctx.now, scheduledAt: null }),
      }),
      example: (ctx) => ({ id: byTitle(ctx, 'Teeth Whitening Myths Debunked').id }),
    },
    {
      id: 'unpublish_post', name: 'Unpublish post',
      description: 'Pull a published blog post off the blog (or cancel a scheduled one), returning it to draft. Content is kept.',
      keywords: ['take down article', 'unschedule', 'hide post'],
      ...ops.transition('blog_posts', {
        to: 'draft', from: ['published', 'scheduled'], risk: 'external', what: 'blog post',
        extra: (p, i, ctx) => ({ scheduledAt: null, ...(p.status === 'published' ? { unpublishedAt: ctx.now } : {}) }),
      }),
      example: (ctx) => ({ id: byTitle(ctx, 'HIIT vs. Steady-State Cardio: What Burns More?').id }),
    },
  ],

  seed(ctx, h) {
    const site = (n) => ctx.all('websites').find((w) => w.name === n)?.id ?? null;
    const user = (n) => ctx.all('users').find((u) => u.name === n)?.id ?? null;
    // [title, site, author, status, categories, ageDays (published/created) | daysAhead for scheduled]
    const posts = [
      ['5 Signs You Need a Dental Checkup', 'Bright Smile Dental', 'Morgan Blake', 'published', ['Oral Health'], 75],
      ['Invisalign vs. Braces: Which Is Right for You?', 'Bright Smile Dental', 'Morgan Blake', 'published', ['Orthodontics', 'Cosmetic Dentistry'], 40],
      ["Keeping Kids' Teeth Healthy This Halloween", 'Bright Smile Dental', 'Alex Morgan', 'published', ['Family Dentistry'], 8],
      ['What to Expect at Your First Cleaning', 'Bright Smile Dental', 'Alex Morgan', 'scheduled', ['New Patients'], 3],
      ['Teeth Whitening Myths Debunked', 'Bright Smile Dental', 'Morgan Blake', 'draft', ['Cosmetic Dentistry'], 4],
      ['Our New Saturday Hours', 'Bright Smile Dental', null, 'draft', ['News'], 2],
      ['HIIT vs. Steady-State Cardio: What Burns More?', 'Summit Fitness Studio', 'Morgan Blake', 'published', ['Training'], 30],
      ['Meal Prep Sunday: 5 High-Protein Lunches', 'Summit Fitness Studio', 'Morgan Blake', 'scheduled', ['Nutrition'], 5],
      ['Meet Our New Yoga Instructor', 'Summit Fitness Studio', 'Chris Park', 'draft', ['Studio News'], 6],
      ['Summer Shred Results Are In', 'Summit Fitness Studio', 'Morgan Blake', 'published', ['Challenges', 'Success Stories'], 45],
    ];
    posts.forEach(([title, siteName, author, status, categories, n]) => {
      const createdAt = h.daysAgo(status === 'scheduled' ? 7 : n + (status === 'published' ? 3 : 0));
      ctx.insert('blog_posts', {
        title, slug: slugify(title), websiteId: site(siteName), authorId: author ? user(author) : null, status,
        excerpt: `${title} — tips from the ${siteName} team.`,
        body: `${title}\n\nPlaceholder article body written by the ${siteName} team. Covers the essentials in under five minutes of reading.`,
        categories, featuredImage: null,
        seo: status === 'published' ? { metaTitle: title.slice(0, 60), metaDescription: `Read ${title} on the ${siteName} blog.`.slice(0, 160) } : null,
        scheduledAt: status === 'scheduled' ? h.daysFromNow(n, 14) : null,
        publishedAt: status === 'published' ? h.daysAgo(n) : null,
        createdAt, updatedAt: createdAt,
      });
    });
  },
});
