import { defineModule, ops, z, id, entity, fail } from '../kit.js';

const VISIBILITY = ['public', 'private', 'team'];
const OPEN = ['booked', 'confirmed'];
const TIMEZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
const timezone = z
  .string()
  .refine((s) => TIMEZONES.has(s), 'must be a valid IANA timezone, e.g. America/New_York, Europe/London, Asia/Kolkata or UTC')
  .describe('IANA timezone, e.g. America/New_York');
const duration = z.number().int().min(5).max(480).describe('meeting length in minutes (5-480)');
const buffer = z.number().int().min(0).max(240).describe('minutes kept free before and after each appointment (0-240)');

const calendar = entity({
  name: z.string(), description: z.string().nullable().optional(), timezone: z.string(), hostUserIds: z.array(z.string()),
  durationMin: z.number(), bufferMin: z.number(), visibility: z.enum(VISIBILITY), status: z.enum(['active', 'archived']),
});

const activeCal = (c) => {
  if (c.status !== 'active') fail('INVALID_STATE', `calendar ${c.id} (${c.name}) is archived and cannot be changed; create a new calendar instead`);
};
function activeUser(ctx, uid) {
  const u = ctx.get('users', uid, 'user');
  if (u.status !== 'active') fail('INVALID_STATE', `user ${uid} (${u.name}) is ${u.status}; only active users can host calendars`);
  return u;
}
function uniqueName(ctx, name, selfId) {
  const d = ctx.all('calendars').find((c) => c.id !== selfId && c.status === 'active' && c.name.toLowerCase() === name.toLowerCase());
  if (d) fail('DUPLICATE', `an active calendar named '${name}' already exists (${d.id})`, { existingId: d.id });
}
const upcoming = (ctx, calId) =>
  ctx.all('appointments').filter((a) => a.calendarId === calId && OPEN.includes(a.status) && Date.parse(a.startAt) > Date.parse(ctx.now));

export default defineModule({
  id: 'calendars',
  code: 'M20',
  name: 'Calendars',
  description: 'Configure calendars used for appointment booking.',
  tables: { calendars: { prefix: 'cal', schema: calendar } },
  actions: [
    {
      id: 'create_calendar', name: 'Create calendar',
      description: 'Create a bookable calendar (meeting type such as "Discovery Call") with hosts, default duration, buffer, timezone and visibility. Defines what can be booked; to book an actual meeting use Create appointment.',
      keywords: ['new meeting type', 'booking calendar', 'new calendar'],
      ...ops.create('calendars', {
        input: z.object({
          name: z.string().min(1), description: z.string().optional(), timezone: timezone.optional(),
          hostUserIds: z.array(z.string()).optional().describe('active users who take meetings on this calendar'),
          durationMin: duration.optional(), bufferMin: buffer.optional(), visibility: z.enum(VISIBILITY).optional(),
        }),
        check: (i, ctx) => {
          uniqueName(ctx, i.name);
          (i.hostUserIds || []).forEach((u) => activeUser(ctx, u));
        },
        build: (i) => ({
          description: i.description ?? null, timezone: i.timezone || 'America/New_York', hostUserIds: [...new Set(i.hostUserIds || [])],
          durationMin: i.durationMin ?? 30, bufferMin: i.bufferMin ?? 0, visibility: i.visibility || 'public', status: 'active',
        }),
      }),
      example: () => ({ name: 'Strategy Session', hostUserIds: ['usr_003'], durationMin: 60 }),
    },
    {
      id: 'get_calendar_settings', name: 'Get calendar settings',
      description: 'Settings of one calendar (timezone, hosts with status/out-of-office, duration, buffer, visibility) plus its count of upcoming booked appointments. For a person\'s working hours use Get weekly working hours.',
      risk: 'read',
      input: z.object({ id: id('calendar') }),
      output: calendar,
      handler: ({ id: cid }, ctx) => {
        const c = ctx.get('calendars', cid, 'calendar');
        const hosts = c.hostUserIds.map((u) => {
          const usr = ctx.find('users', u) || {};
          return { id: u, name: usr.name, status: usr.status, outOfOffice: !!usr.outOfOffice };
        });
        return { ...c, hosts, upcomingAppointments: upcoming(ctx, cid).length };
      },
      example: (ctx) => ({ id: ctx.all('calendars')[0].id }),
    },
    {
      id: 'list_calendars', name: 'List calendars',
      description: 'List booking calendars (meeting types), filterable by name text, host, visibility or status. Archived calendars are excluded unless status is given.',
      keywords: ['meeting types', 'which calendars'],
      ...ops.search('calendars', {
        text: ['name', 'description'],
        filters: {
          hostUserIds: z.string().optional().describe('user ID that must be one of the hosts'),
          visibility: z.enum(VISIBILITY).optional(), status: z.enum(['active', 'archived']).optional(),
        },
        where: (r, i) => i.status || r.status === 'active',
      }),
      example: () => ({}),
    },
    {
      id: 'update_calendar_details', name: 'Update calendar details', description: 'Rename a calendar or change its description. Timezone, hosts, duration, buffer and visibility have their own actions.',
      ...ops.update('calendars', {
        what: 'calendar',
        fields: { name: z.string().min(1), description: z.string() },
        guard: (c, i, ctx) => {
          activeCal(c);
          if (i.name) uniqueName(ctx, i.name, c.id);
        },
      }),
      example: (ctx) => ({ id: ctx.all('calendars')[0].id, description: 'Free 30-minute intro call for new prospects.' }),
    },
    {
      id: 'set_calendar_timezone', name: 'Set calendar timezone', description: 'Set the IANA timezone a calendar displays booking times in (e.g. America/Chicago). Not a user\'s personal timezone.',
      ...ops.set('calendars', 'timezone', timezone, { what: 'calendar', guard: activeCal }),
      example: (ctx) => ({ id: ctx.all('calendars')[0].id, timezone: 'America/Chicago' }),
    },
    {
      id: 'assign_calendar_host', name: 'Assign calendar host',
      description: 'Add an active user as a host who can be booked on this calendar. To change who runs one specific meeting use Assign appointment host.',
      keywords: ['add host', 'add team member to calendar'],
      risk: 'write',
      input: z.object({ id: id('calendar'), userId: id('user') }),
      output: calendar,
      handler: ({ id: cid, userId }, ctx) => {
        const c = ctx.get('calendars', cid, 'calendar');
        activeCal(c);
        const u = activeUser(ctx, userId);
        if (c.hostUserIds.includes(userId)) fail('DUPLICATE', `${u.name} is already a host of ${c.name}`);
        return ctx.patch(c, { hostUserIds: [...c.hostUserIds, userId] });
      },
      example: (ctx) => ({ id: ctx.all('calendars')[0].id, userId: 'usr_001' }),
    },
    {
      id: 'set_appointment_duration', name: 'Set appointment duration',
      description: 'Set the default meeting length (5-480 minutes) for new bookings on a calendar. Existing appointments keep their times.',
      ...ops.set('calendars', 'durationMin', duration, { param: 'durationMin', what: 'calendar', guard: activeCal }),
      example: (ctx) => ({ id: ctx.all('calendars')[0].id, durationMin: 45 }),
    },
    {
      id: 'set_booking_buffer', name: 'Set booking buffer',
      description: 'Set the buffer minutes kept free around each appointment on a calendar (applied when finding available slots). Per-user booking notice/horizon are availability settings instead.',
      keywords: ['gap between meetings', 'padding'],
      ...ops.set('calendars', 'bufferMin', buffer, { param: 'bufferMin', what: 'calendar', guard: activeCal }),
      example: (ctx) => ({ id: ctx.all('calendars')[0].id, bufferMin: 15 }),
    },
    {
      id: 'set_calendar_visibility', name: 'Set calendar visibility',
      description: 'Who can see/book the calendar: public (anyone with the link), private (internal only), or team (team members only).',
      ...ops.set('calendars', 'visibility', z.enum(VISIBILITY), { what: 'calendar', guard: activeCal }),
      example: (ctx) => ({ id: ctx.all('calendars')[0].id, visibility: 'private' }),
    },
    {
      id: 'archive_calendar', name: 'Archive calendar',
      description: 'Archive a calendar so it can no longer be booked; published booking pages linked to it are unpublished. Fails with CONFLICT if it has upcoming booked/confirmed appointments unless force=true, which also cancels them.',
      keywords: ['delete calendar', 'remove calendar', 'retire meeting type'],
      risk: 'destructive',
      input: z.object({ id: id('calendar'), force: z.boolean().default(false).describe('also cancel upcoming booked/confirmed appointments on this calendar') }),
      output: calendar,
      handler: ({ id: cid, force }, ctx) => {
        const c = ctx.get('calendars', cid, 'calendar');
        if (c.status === 'archived') fail('INVALID_STATE', `calendar ${c.id} (${c.name}) is already archived`);
        const future = upcoming(ctx, cid);
        if (future.length && !force)
          fail('CONFLICT', `${c.name} has ${future.length} upcoming booked/confirmed appointment(s): ${future.slice(0, 10).map((a) => `${a.id} at ${a.startAt}`).join(', ')}. Reschedule or cancel them first, or retry with force: true to cancel them all.`, { appointmentIds: future.map((a) => a.id) });
        for (const a of future) ctx.patch(a, { status: 'cancelled', cancelReason: `Calendar ${c.name} archived`, cancelledAt: ctx.now });
        // A live booking page must not keep taking bookings into an archived calendar (publish requires an active one).
        const pages = ctx.all('booking_pages').filter((p) => p.calendarId === cid && p.status === 'published');
        for (const p of pages) ctx.patch(p, { status: 'unpublished', url: null, unpublishedAt: ctx.now });
        ctx.patch(c, { status: 'archived', archivedAt: ctx.now });
        return { ...c, cancelledAppointmentIds: future.map((a) => a.id), unpublishedBookingPageIds: pages.map((p) => p.id) };
      },
      example: (ctx) => ({ id: ctx.all('calendars').find((c) => c.status === 'active' && !upcoming(ctx, c.id).length).id }),
    },
  ],

  seed(ctx, h) {
    const rows = [
      ['Sales Discovery Call', 'Free intro call to qualify new prospects.', ['usr_002', 'usr_003', 'usr_004', 'usr_005'], 30, 0, 'public'],
      ['Product Demo', 'Live walkthrough of the platform for qualified prospects.', ['usr_001', 'usr_003'], 45, 15, 'public'],
      ['Support Session', 'Screen-share troubleshooting with the support team.', ['usr_006', 'usr_007'], 30, 10, 'public'],
      ['Customer Onboarding', 'Kickoff session for newly signed customers.', ['usr_001', 'usr_006'], 60, 15, 'private'],
      ['Partner Introduction', 'Internal intro meetings with agency partners.', ['usr_001'], 30, 0, 'team'],
      ['Legacy Strategy Consult', 'Retired 2025 consulting offer.', ['usr_009'], 60, 0, 'public', 'archived'],
    ];
    for (const [name, description, hostUserIds, durationMin, bufferMin, visibility, status = 'active'] of rows)
      ctx.insert('calendars', {
        name, description, timezone: 'America/New_York', hostUserIds, durationMin, bufferMin, visibility, status,
        createdAt: h.daysAgo(h.int(90, 400)),
      });
  },
});
