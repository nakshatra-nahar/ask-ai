import { defineModule, ops, z, entity, fail } from '../kit.js';

const BASE_URL = 'https://book.acme.test/';
const STATUSES = ['draft', 'published', 'unpublished'];
const FIELD_TYPES = ['text', 'email', 'phone', 'textarea', 'select', 'checkbox'];
const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, digits and single hyphens, e.g. discovery-call');
const intakeField = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'snake_case key'), label: z.string().min(1), type: z.enum(FIELD_TYPES),
  required: z.boolean().default(false), options: z.array(z.string()).optional().describe('choices for select fields'),
});
const intakeFields = z.array(intakeField).min(1).max(20)
  .refine((f) => new Set(f.map((x) => x.key)).size === f.length, 'field keys must be unique')
  .refine((f) => f.every((x) => x.type !== 'select' || x.options?.length), 'select fields need at least one option')
  .refine((f) => f.some((x) => x.type === 'email' && x.required), 'include a required email field (needed to send the booking confirmation)');

const bookingPage = entity({
  name: z.string(), slug: z.string(), title: z.string(), description: z.string().nullable().optional(), calendarId: z.string().nullable(),
  intakeFields: z.array(z.looseObject({ key: z.string(), label: z.string(), type: z.string(), required: z.boolean() })),
  confirmationMessage: z.string(), redirectUrl: z.string().nullable(), status: z.enum(STATUSES), url: z.string().nullable(),
});
const DEFAULT_FIELDS = [
  { key: 'name', label: 'Full name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email', required: true },
  { key: 'phone', label: 'Phone', type: 'phone', required: false },
];
const DEFAULT_CONFIRMATION = 'Thanks! Your booking is confirmed. A calendar invite is on its way.';
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function uniqueSlug(ctx, s, selfId) {
  const d = ctx.all('booking_pages').find((p) => p.slug === s && p.id !== selfId);
  if (d) fail('DUPLICATE', `slug '${s}' is already used by booking page ${d.id} (${d.name}); choose another slug`, { existingId: d.id });
}
function activeCalendar(ctx, cid) {
  const c = ctx.get('calendars', cid, 'calendar');
  if (c.status !== 'active') fail('INVALID_STATE', `calendar ${c.id} (${c.name}) is archived; link an active calendar (List calendars)`);
  return c;
}

export default defineModule({
  id: 'booking_pages',
  code: 'M23',
  name: 'Booking Pages',
  description: 'Configure the public booking experience.',
  tables: { booking_pages: { prefix: 'bp', schema: bookingPage } },
  actions: [
    {
      id: 'create_booking_page', name: 'Create booking page',
      description: 'Create a draft public scheduling page (URL slug, title, intake form) where visitors self-book; optionally linked to a calendar. Not a website/funnel landing page and not a calendar itself.',
      keywords: ['scheduling link', 'booking link', 'self-booking page'],
      ...ops.create('booking_pages', {
        input: z.object({
          name: z.string().min(1).describe('internal name'), slug: slug.optional().describe('URL slug; defaults from name'),
          title: z.string().optional().describe('headline shown to visitors'), description: z.string().optional(),
          calendarId: z.string().optional().describe('active calendar visitors book into'),
        }),
        check: (i, ctx) => {
          const s = i.slug || slugify(i.name);
          if (!s) fail('VALIDATION', 'name has no letters/digits to build a slug; pass slug explicitly');
          uniqueSlug(ctx, s);
          if (i.calendarId) activeCalendar(ctx, i.calendarId);
        },
        build: (i) => ({
          slug: i.slug || slugify(i.name), title: i.title || i.name, description: i.description ?? null, calendarId: i.calendarId ?? null,
          intakeFields: structuredClone(DEFAULT_FIELDS), confirmationMessage: DEFAULT_CONFIRMATION, redirectUrl: null,
          status: 'draft', url: null, publishedAt: null,
        }),
      }),
      example: (ctx) => ({ name: 'Free Strategy Session', calendarId: ctx.all('calendars')[1]?.id }),
    },
    {
      id: 'get_booking_page', name: 'Get booking page', description: 'Fetch one booking page: slug, public URL, linked calendar, intake fields, confirmation message, redirect and publish status.',
      ...ops.get('booking_pages', { what: 'booking page' }),
      example: () => ({ id: 'bp_001' }),
    },
    {
      id: 'list_booking_pages', name: 'List booking pages', description: 'List public booking pages, filterable by status (draft/published/unpublished), linked calendar, or name/slug text.',
      ...ops.search('booking_pages', {
        text: ['name', 'slug', 'title'],
        filters: { status: z.enum(STATUSES).optional(), calendarId: z.string().optional() },
      }),
      example: () => ({}),
    },
    {
      id: 'update_booking_page_content', name: 'Update booking page content',
      description: 'Edit a booking page\'s name, visitor-facing title, description or URL slug. Changes to a published page go live immediately.',
      ...ops.update('booking_pages', {
        what: 'booking page',
        fields: { name: z.string().min(1), title: z.string().min(1), description: z.string(), slug },
        guard: (p, i, ctx) => i.slug && uniqueSlug(ctx, i.slug, p.id),
        after: (p) => p.status === 'published' && (p.url = BASE_URL + p.slug),
      }),
      example: () => ({ id: 'bp_001', title: 'Book your free 30-minute discovery call' }),
    },
    {
      id: 'link_calendar_to_booking_page', name: 'Link calendar to booking page',
      description: 'Choose which active calendar a booking page books into (determines hosts, duration and availability shown). Replaces any previously linked calendar.',
      ...ops.set('booking_pages', 'calendarId', z.string().min(1).describe('active calendar ID'), {
        param: 'calendarId', what: 'booking page', guard: (p, i, ctx) => activeCalendar(ctx, i.calendarId),
      }),
      example: () => ({ id: 'bp_005', calendarId: 'cal_001' }),
    },
    {
      id: 'set_booking_intake_fields', name: 'Set booking intake fields',
      description: 'Replace the questions visitors answer when booking (full list). Keys must be unique and a required email field is mandatory.',
      keywords: ['booking form', 'questions', 'custom fields on booking'],
      ...ops.set('booking_pages', 'intakeFields', intakeFields, { param: 'fields', what: 'booking page' }),
      example: () => ({
        id: 'bp_001',
        fields: [
          { key: 'name', label: 'Full name', type: 'text', required: true },
          { key: 'email', label: 'Work email', type: 'email', required: true },
          { key: 'company_size', label: 'Company size', type: 'select', required: false, options: ['1-10', '11-50', '51+'] },
        ],
      }),
    },
    {
      id: 'set_booking_confirmation_message', name: 'Set booking confirmation message',
      description: 'Set the thank-you text shown on the booking page after a visitor books (ignored when a redirect URL is set). Not an email/SMS confirmation.',
      ...ops.set('booking_pages', 'confirmationMessage', z.string().min(1).max(1000), { param: 'message', what: 'booking page' }),
      example: () => ({ id: 'bp_001', message: 'You are booked! Check your inbox for the invite and prep questions.' }),
    },
    {
      id: 'set_booking_redirect_url', name: 'Set booking redirect URL',
      description: 'Send visitors to this https URL after they book (instead of showing the confirmation message).',
      ...ops.set('booking_pages', 'redirectUrl', z.url().refine((u) => u.startsWith('https://'), 'must be an https:// URL').describe('https URL'), { param: 'url', what: 'booking page' }),
      example: () => ({ id: 'bp_001', url: 'https://acme.test/thank-you' }),
    },
    {
      id: 'publish_booking_page', name: 'Publish booking page',
      description: 'Make a draft/unpublished booking page live at its public URL so anyone can self-book. Requires a linked active calendar with at least one active host.',
      keywords: ['go live', 'make booking link public'],
      ...ops.transition('booking_pages', {
        to: 'published', from: ['draft', 'unpublished'], risk: 'external', what: 'booking page',
        guard: (p, i, ctx) => {
          if (!p.calendarId) fail('INVALID_STATE', `booking page ${p.id} has no calendar; link one first with Link calendar to booking page`);
          const c = activeCalendar(ctx, p.calendarId);
          if (!c.hostUserIds.some((u) => ctx.find('users', u)?.status === 'active'))
            fail('INVALID_STATE', `calendar ${c.name} has no active hosts; add one with Assign calendar host`);
        },
        extra: (p, i, ctx) => ({ url: BASE_URL + p.slug, publishedAt: ctx.now }),
      }),
      example: () => ({ id: 'bp_004' }),
    },
    {
      id: 'unpublish_booking_page', name: 'Unpublish booking page',
      description: 'Take a published booking page offline (public URL stops accepting bookings). Existing appointments are kept. Can be re-published later.',
      keywords: ['take down booking link', 'disable booking page'],
      ...ops.transition('booking_pages', {
        to: 'unpublished', from: ['published'], risk: 'external', what: 'booking page',
        extra: (p, i, ctx) => ({ url: null, unpublishedAt: ctx.now }),
      }),
      example: () => ({ id: 'bp_001' }),
    },
  ],

  seed(ctx, h) {
    const cal = (name) => ctx.all('calendars').find((c) => c.name === name)?.id ?? null;
    const rows = [
      ['Discovery Call', 'discovery-call', 'Book a free discovery call', 'Sales Discovery Call', 'published'],
      ['Product Demo', 'product-demo', 'See the platform in action', 'Product Demo', 'published'],
      ['Support Session', 'support', 'Get hands-on help from our support team', 'Support Session', 'published'],
      ['Customer Onboarding', 'onboarding-kickoff', 'Schedule your onboarding kickoff', 'Customer Onboarding', 'draft'],
      ['Holiday Promo Consult', 'holiday-consult', 'Claim your holiday strategy consult', null, 'draft'],
      ['Legacy Strategy Consult', 'strategy-consult', 'Book a strategy consult', 'Legacy Strategy Consult', 'unpublished'],
    ];
    for (const [name, s, title, calName, status] of rows)
      ctx.insert('booking_pages', {
        name, slug: s, title, description: null, calendarId: calName && cal(calName), intakeFields: structuredClone(DEFAULT_FIELDS),
        confirmationMessage: DEFAULT_CONFIRMATION, redirectUrl: null, status, url: status === 'published' ? BASE_URL + s : null,
        publishedAt: status === 'published' ? h.daysAgo(h.int(20, 120)) : null, createdAt: h.daysAgo(h.int(120, 300)),
      });
  },
});
