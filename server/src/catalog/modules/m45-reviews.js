import { defineModule, ops, z, id, entity, isoDate, fail, addDays, toTime } from '../kit.js';

const PLATFORMS = ['google', 'facebook', 'yelp'];
const CHANNELS = ['email', 'sms'];
const REQ_STATUS = ['draft', 'sent', 'completed', 'cancelled'];

const request = entity({
  contactId: z.string(), channel: z.enum(CHANNELS), platform: z.enum(PLATFORMS), status: z.enum(REQ_STATUS),
  message: z.string().nullable().optional(), sentAt: z.string().nullable().optional(), messageId: z.string().nullable().optional(),
  reviewId: z.string().nullable().optional(), completedAt: z.string().nullable().optional(),
});
const review = entity({
  platform: z.enum(PLATFORMS), rating: z.number().int().min(1).max(5), text: z.string().nullable(), authorName: z.string(),
  contactId: z.string().nullable().optional(), requestId: z.string().nullable().optional(), postedAt: z.string(),
  responded: z.boolean(), responseDraft: z.string().nullable().optional(), responseText: z.string().nullable().optional(),
  respondedAt: z.string().nullable().optional(),
});
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const reviewLink = (p) => ({ google: 'https://g.page/r/acme/review', facebook: 'https://fb.com/acme/reviews', yelp: 'https://yelp.com/writeareview/biz/acme' })[p];

function summarize(rows) {
  const n = rows.length;
  const responded = rows.filter((r) => r.responded).length;
  return {
    count: n,
    average: n ? round(rows.reduce((s, r) => s + r.rating, 0) / n) : null,
    responseRate: n ? round((responded / n) * 100, 1) : null,
  };
}

export default defineModule({
  id: 'reviews',
  code: 'M45',
  name: 'Reviews',
  description: 'Collect and respond to customer reviews.',
  tables: { review_requests: { prefix: 'rrq', schema: request }, reviews: { prefix: 'rev', schema: review } },
  actions: [
    {
      id: 'create_review_request', name: 'Create review request',
      description: 'Draft (not send) a request asking a contact to leave a review on Google, Facebook, or Yelp via email or SMS. Use send_review_request to deliver it.',
      keywords: ['ask for review', 'request feedback', 'get reviews'],
      ...ops.create('review_requests', {
        input: z.object({
          contactId: id('contact'), channel: z.enum(CHANNELS), platform: z.enum(PLATFORMS),
          message: z.string().optional().describe('custom message; default text includes the review link'),
        }),
        check: (i, ctx) => {
          const c = ctx.get('contacts', i.contactId, 'contact');
          if (c.status !== 'active') fail('INVALID_STATE', `contact ${c.id} is ${c.status}; use an active contact`);
          const open = ctx.all('review_requests').find((r) => r.contactId === i.contactId && r.platform === i.platform && ['draft', 'sent'].includes(r.status));
          if (open) fail('DUPLICATE', `contact already has an open ${open.status} ${i.platform} review request (${open.id})`, { existingId: open.id });
        },
        build: (i, ctx) => ({
          status: 'draft', message: i.message ?? `Hi ${ctx.find('contacts', i.contactId).firstName}, thanks for choosing us! Would you leave a quick review? ${reviewLink(i.platform)}`,
          sentAt: null, messageId: null, reviewId: null, completedAt: null,
        }),
      }),
      example: (ctx) => ({ contactId: ctx.all('contacts')[30].id, channel: 'email', platform: 'google' }),
    },
    {
      id: 'send_review_request', name: 'Send review request',
      description: 'Deliver a draft review request to the contact by its email/SMS channel (logs an outbound message). Fails if the contact opted out of that channel.',
      risk: 'external',
      input: z.object({ id: id('review request') }),
      output: z.looseObject({ request, message: z.looseObject({ id: z.string(), channel: z.string(), status: z.string() }) }),
      handler: ({ id: rid }, ctx) => {
        const r = ctx.get('review_requests', rid, 'review request');
        if (r.status !== 'draft') fail('INVALID_STATE', `review request ${r.id} is '${r.status}'; only draft requests can be sent`);
        const c = ctx.get('contacts', r.contactId, 'contact');
        if (c.status !== 'active') fail('INVALID_STATE', `contact ${c.id} is ${c.status}`);
        if (c.preferences?.[r.channel] === false) {
          const alt = CHANNELS.find((ch) => ch !== r.channel && c.preferences[ch] !== false);
          fail('PERMISSION', `${c.name} has opted out of ${r.channel}. ${alt ? `Cancel this request and create one with channel '${alt}'.` : 'They cannot be contacted.'}`);
        }
        const to = r.channel === 'email' ? c.email : c.phone;
        if (!to) fail('VALIDATION', `${c.name} has no ${r.channel === 'email' ? 'email address' : 'phone number'}; update the contact or use the other channel`);
        const msg = ctx.insert('messages', {
          channel: r.channel, direction: 'outbound', contactId: c.id, conversationId: null, to,
          from: r.channel === 'email' ? 'reviews@acme.test' : '+1-555-0100', subject: r.channel === 'email' ? 'How did we do?' : null,
          body: r.message, status: 'sent', scheduledAt: null, sentAt: ctx.now, deliveredAt: null, failureReason: null, templateId: null,
          relatedType: 'review_requests', relatedId: r.id, purpose: 'review_request',
        });
        ctx.patch(r, { status: 'sent', sentAt: ctx.now, messageId: msg.id });
        return { request: r, message: msg };
      },
      example: (ctx) => ({
        id: ctx.all('review_requests').find((r) => r.status === 'draft' && ctx.find('contacts', r.contactId)?.preferences?.[r.channel] !== false).id,
      }),
    },
    {
      id: 'cancel_review_request', name: 'Cancel unsent review request',
      description: 'Cancel a review request that is still a draft (already-sent requests cannot be recalled).',
      ...ops.transition('review_requests', { to: 'cancelled', from: ['draft'], risk: 'destructive', what: 'review request' }),
      example: (ctx) => ({ id: ctx.all('review_requests').find((r) => r.status === 'draft').id }),
    },
    {
      id: 'list_review_requests', name: 'List review requests',
      description: 'List outgoing review requests by status (draft/sent/completed/cancelled), channel, platform, contact, or created date.',
      ...ops.search('review_requests', {
        filters: {
          status: z.enum(REQ_STATUS).optional(), channel: z.enum(CHANNELS).optional(), platform: z.enum(PLATFORMS).optional(),
          contactId: z.string().optional(), createdAtAfter: isoDate().optional(), createdAtBefore: isoDate().optional(),
        },
        sort: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      }),
      example: () => ({ status: 'sent' }),
    },
    {
      id: 'record_review', name: 'Record simulated customer review',
      description: 'Record a review a customer posted (simulated inbound from Google/Facebook/Yelp). If requestId is given, that sent request is marked completed.',
      keywords: ['new review', 'customer left a review', 'log review'],
      risk: 'write',
      input: z.object({
        rating: z.number().int().min(1).max(5), text: z.string().optional(), platform: z.enum(PLATFORMS),
        authorName: z.string().optional(), contactId: z.string().optional(), requestId: z.string().optional().describe('review request this answers'),
      }),
      output: review,
      handler: (i, ctx) => {
        let contactId = i.contactId ?? null;
        let req = null;
        if (i.requestId) {
          req = ctx.get('review_requests', i.requestId, 'review request');
          if (req.status !== 'sent') fail('INVALID_STATE', `review request ${req.id} is '${req.status}'; only sent requests can be completed`);
          if (req.platform !== i.platform) fail('VALIDATION', `review request ${req.id} asked for a ${req.platform} review, not ${i.platform}`);
          if (contactId && contactId !== req.contactId) fail('VALIDATION', `review request ${req.id} belongs to contact ${req.contactId}, not ${contactId}`);
          contactId = req.contactId;
        }
        const c = contactId ? ctx.get('contacts', contactId, 'contact') : null;
        const rev = ctx.insert('reviews', {
          platform: i.platform, rating: i.rating, text: i.text ?? null, authorName: i.authorName || c?.name || 'Anonymous',
          contactId, requestId: req?.id ?? null, postedAt: ctx.now, responded: false, responseDraft: null, responseText: null, respondedAt: null,
        });
        if (req) ctx.patch(req, { status: 'completed', reviewId: rev.id, completedAt: ctx.now });
        return rev;
      },
      example: (ctx) => {
        const r = ctx.all('review_requests').find((x) => x.status === 'sent');
        return { rating: 5, text: 'Fantastic service, highly recommend!', platform: r.platform, requestId: r.id };
      },
    },
    {
      id: 'search_reviews', name: 'Search reviews',
      description: 'Find received customer reviews by rating range, platform, responded yes/no, posted date range, contact, or text. Newest first.',
      keywords: ['bad reviews', 'negative reviews', 'unanswered reviews', 'feedback'],
      ...ops.search('reviews', {
        text: ['text', 'authorName'],
        filters: {
          ratingMin: z.number().int().min(1).max(5).optional(), ratingMax: z.number().int().min(1).max(5).optional(),
          platform: z.enum(PLATFORMS).optional(), responded: z.boolean().optional(), contactId: z.string().optional(),
          postedAtAfter: isoDate().optional(), postedAtBefore: isoDate().optional(),
        },
        sort: (a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt),
      }),
      example: () => ({ ratingMax: 2, responded: false }),
    },
    {
      id: 'get_review', name: 'Get review details', description: 'Fetch one received review, including any draft or published response.',
      ...ops.get('reviews', { what: 'review' }),
      example: (ctx) => ({ id: ctx.all('reviews')[0].id }),
    },
    {
      id: 'draft_review_response', name: 'Draft review response',
      description: 'Save a draft public reply on a review (not visible to anyone until publish_review_response).',
      keywords: ['reply to review', 'write response'],
      risk: 'write',
      input: z.object({ id: id('review'), text: z.string().min(1).max(4000) }),
      output: review,
      handler: ({ id: rid, text }, ctx) => {
        const r = ctx.get('reviews', rid, 'review');
        if (r.responded) fail('INVALID_STATE', `review ${r.id} already has a published response: "${r.responseText}"`);
        return ctx.patch(r, { responseDraft: text, responseDraftedAt: ctx.now });
      },
      example: (ctx) => ({ id: ctx.all('reviews').find((r) => !r.responded).id, text: 'Thank you for the feedback. We are sorry and would like to make it right.' }),
    },
    {
      id: 'publish_review_response', name: 'Publish review response',
      description: 'Post a public reply on the review platform, using the given text or the saved draft.',
      risk: 'external',
      input: z.object({ id: id('review'), text: z.string().min(1).max(4000).optional().describe('reply text; omit to publish the saved draft') }),
      output: review,
      handler: ({ id: rid, text }, ctx) => {
        const r = ctx.get('reviews', rid, 'review');
        if (r.responded) fail('INVALID_STATE', `review ${r.id} already has a published response`);
        const body = text || r.responseDraft;
        if (!body) fail('VALIDATION', `review ${r.id} has no draft response; pass text or call draft_review_response first`);
        return ctx.patch(r, { responded: true, responseText: body, responseDraft: null, respondedAt: ctx.now, responderId: ctx.actorId });
      },
      example: (ctx) => ({ id: ctx.all('reviews').find((r) => r.responseDraft && !r.responded).id }),
    },
    {
      id: 'get_review_summary', name: 'Get review rating summary',
      description: 'Reputation overview: average star rating, review count, 1-5 star distribution, response rate, and per-platform breakdown.',
      keywords: ['average rating', 'reputation', 'star rating'],
      risk: 'read',
      input: z.object({ platform: z.enum(PLATFORMS).optional(), postedAtAfter: isoDate().optional(), postedAtBefore: isoDate().optional() }),
      output: z.looseObject({
        count: z.number(), average: z.number().nullable(), responseRate: z.number().nullable(), distribution: z.record(z.string(), z.number()),
        unrespondedNegative: z.number(), byPlatform: z.array(z.looseObject({ platform: z.string(), count: z.number() })),
      }),
      handler: ({ platform, postedAtAfter, postedAtBefore }, ctx) => {
        const rows = ctx.all('reviews').filter((r) => (!platform || r.platform === platform)
          && (!postedAtAfter || Date.parse(r.postedAt) >= toTime(postedAtAfter))
          && (!postedAtBefore || Date.parse(r.postedAt) <= toTime(postedAtBefore, true))); // date-only "before" includes that whole day, like search_reviews
        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        for (const r of rows) distribution[r.rating]++;
        return {
          ...summarize(rows), distribution,
          unrespondedNegative: rows.filter((r) => r.rating <= 2 && !r.responded).length,
          byPlatform: PLATFORMS.map((p) => ({ platform: p, ...summarize(rows.filter((r) => r.platform === p)) })).filter((p) => p.count),
        };
      },
      example: () => ({}),
    },
  ],

  seed(ctx, h) {
    const contacts = ctx.all('contacts').filter((c) => c.status === 'active');
    const optedOut = contacts.find((c) => c.preferences?.sms === false);
    const pool = contacts.filter((c) => c !== optedOut);
    // Requests: [contact, channel, platform, status, daysAgo]
    const reqSpecs = [
      [pool[0], 'email', 'google', 'completed', 20], [pool[1], 'sms', 'google', 'completed', 18], [pool[2], 'email', 'facebook', 'completed', 15],
      [pool[3], 'email', 'yelp', 'completed', 12], [pool[4], 'email', 'google', 'sent', 6], [pool[5], 'sms', 'google', 'sent', 4],
      [pool[6], 'email', 'facebook', 'sent', 3], [pool[7], 'sms', 'yelp', 'sent', 2], [pool[8], 'email', 'google', 'draft', 1],
      [optedOut, 'sms', 'google', 'draft', 1], [pool[9], 'sms', 'facebook', 'draft', 0], [pool[11], 'email', 'yelp', 'cancelled', 9],
    ].filter((s) => s[0]);
    const reqs = reqSpecs.map(([c, channel, platform, status, d]) => {
      const createdAt = h.daysAgo(d + 1);
      return ctx.insert('review_requests', {
        contactId: c.id, channel, platform, status, message: `Hi ${c.firstName}, thanks for choosing us! Would you leave a quick review? ${reviewLink(platform)}`,
        sentAt: ['sent', 'completed'].includes(status) ? h.daysAgo(d) : null, messageId: null, reviewId: null, completedAt: null, createdAt,
      });
    });
    const completed = reqs.filter((r) => r.status === 'completed');

    const ratings = [5, 4, 5, 5, 1, 2, 5, 4, 3, 5, 1, 5, 4, 2, 5, 5, 3, 4, 5, 1, 5, 4, 2, 5, 5];
    const good = ['Fantastic service, highly recommend!', 'Friendly staff and quick turnaround.', 'Great experience from start to finish.', 'Very professional, will come back.', 'Exceeded my expectations.'];
    const meh = ['It was okay, a bit of a wait.', 'Decent, but communication could be better.'];
    const bad = ['Waited 45 minutes past my appointment and nobody apologized.', 'Billing was wrong twice and support never called back.', 'Rude front desk, would not return.', 'Service was rushed and the issue came back a week later.'];
    ratings.forEach((rating, i) => {
      const req = completed[i];
      const contact = req ? ctx.find('contacts', req.contactId) : i % 3 === 0 ? pool[20 + i] : null;
      const postedAt = req ? addDays(req.sentAt, 1) : h.daysAgo(i < 8 ? i + 1 : h.int(10, 150));
      const negative = rating <= 2;
      // Older positive reviews were answered; most negative ones are not (fixture: rev_006 has an unpublished draft, rev_014 answered).
      const responded = (!negative && i > 6 && i % 2 === 0) || i === 13;
      const responseText = responded ? (negative ? 'We are sorry to hear this. Our manager will reach out today to make it right.' : 'Thank you so much for the kind words!') : null;
      const rev = ctx.insert('reviews', {
        platform: req?.platform || PLATFORMS[i % 3], rating, text: negative ? bad[i % bad.length] : rating === 3 ? meh[i % 2] : good[i % good.length],
        authorName: contact?.name || `${h.firstNames[(i * 7) % 30]} ${h.lastNames[(i * 3) % 20][0]}.`, contactId: contact?.id ?? null, requestId: req?.id ?? null,
        postedAt, responded, responseText, respondedAt: responded ? postedAt : null,
        responseDraft: i === 5 ? 'Hi, we apologize for the billing confusion. Please call us so we can fix it.' : null, createdAt: postedAt,
      });
      if (req) Object.assign(req, { status: 'completed', reviewId: rev.id, completedAt: postedAt });
    });
  },
});
