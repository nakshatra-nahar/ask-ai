import { defineModule, ops, z, id, entity, isoDate, limit, listOf, fail, page, matchFilters } from '../kit.js';

const STATUSES = ['booked', 'confirmed', 'cancelled', 'completed', 'no_show'];
const OPEN = ['booked', 'confirmed'];
const attendee = z.looseObject({ id: z.string(), name: z.string(), email: z.string().nullable().optional(), contactId: z.string().nullable().optional() });
const appointment = entity({
  calendarId: z.string(), contactId: z.string(), hostUserId: z.string(), title: z.string(),
  startAt: z.string(), endAt: z.string(), status: z.enum(STATUSES), attendees: z.array(attendee),
});

const ms = (s) => Date.parse(s);
const iso = (s) => new Date(s).toISOString();
const plusMin = (s, m) => new Date(ms(s) + m * 6e4).toISOString();

/** Booked/confirmed appointments and availability time blocks of user `uid` overlapping [start, end). */
function clashes(ctx, uid, start, end, excludeId) {
  const s = ms(start), e = ms(end);
  const apts = ctx.all('appointments')
    .filter((a) => a.id !== excludeId && a.hostUserId === uid && OPEN.includes(a.status) && ms(a.startAt) < e && ms(a.endAt) > s)
    .map((a) => `appointment ${a.id} "${a.title}" ${a.startAt}–${a.endAt}`);
  const blocks = (ctx.all('availability').find((r) => r.userId === uid)?.blocks || [])
    .filter((b) => ms(b.startAt) < e && ms(b.endAt) > s)
    .map((b) => `time block ${b.id} (${b.reason}) ${b.startAt}–${b.endAt}`);
  return [...apts, ...blocks];
}
function assertFree(ctx, uid, start, end, excludeId) {
  const c = clashes(ctx, uid, start, end, excludeId);
  if (c.length)
    fail('CONFLICT', `${ctx.find('users', uid)?.name || uid} is not free ${start}–${end}: ${c.join('; ')}. Pick another time (Find available slots) or another host.`, { conflicts: c });
}
function checkHost(ctx, cal, uid) {
  if (!cal.hostUserIds.includes(uid))
    fail('VALIDATION', `${uid} is not a host of calendar ${cal.name}; hosts are ${cal.hostUserIds.join(', ')}. Add them with Assign calendar host first.`);
  const u = ctx.get('users', uid, 'user');
  if (u.status !== 'active') fail('INVALID_STATE', `host ${u.name} is ${u.status}; choose an active host`);
}
const openApt = (a) => {
  if (!OPEN.includes(a.status)) fail('INVALID_STATE', `appointment ${a.id} is '${a.status}'; this action requires booked or confirmed`);
};
function times(i, defaultMin, ctx) {
  const startAt = iso(i.startAt);
  const endAt = i.endAt ? iso(i.endAt) : plusMin(startAt, defaultMin);
  if (ms(endAt) <= ms(startAt)) fail('VALIDATION', 'endAt must be after startAt');
  if (ms(startAt) < ms(ctx.now)) fail('VALIDATION', `startAt ${startAt} is in the past (now is ${ctx.now}); choose a future time`);
  return { startAt, endAt };
}
// Outcome actions (completed / no-show) are only valid once the meeting has started.
const closeOut = (to) => (i, ctx) => {
  const a = ctx.get('appointments', i.id, 'appointment');
  openApt(a);
  if (ms(a.startAt) > ms(ctx.now))
    fail('INVALID_STATE', `appointment ${a.id} starts at ${a.startAt} (now ${ctx.now}); outcomes can only be recorded after the start time. To call it off use Cancel appointment.`);
  return ctx.patch(a, { status: to, outcome: i.outcome ?? a.outcome ?? null, outcomeAt: ctx.now });
};
const pastOpen = (ctx) => ctx.all('appointments').find((a) => OPEN.includes(a.status) && ms(a.startAt) <= ms(ctx.now));
const futureOpen = (ctx) => ctx.all('appointments').filter((a) => OPEN.includes(a.status) && ms(a.startAt) > ms(ctx.now));

export default defineModule({
  id: 'appointments',
  code: 'M21',
  name: 'Appointments',
  description: 'Manage booked meetings and their outcomes.',
  tables: { appointments: { prefix: 'apt', schema: appointment } },
  actions: [
    {
      id: 'create_appointment', name: 'Create appointment',
      description: 'Book a 1:1 meeting with a contact on a calendar at a specific time. Host must be an active calendar host with no overlapping booked/confirmed appointment or time block (CONFLICT lists the clash); as a staff booking it is NOT limited by working hours, minimum notice, booking horizon or calendar buffer (use Find available slots / Check scheduling conflicts first when those matter). endAt defaults to start + calendar duration; host defaults to the first free host. For group sessions use Register attendee (events).',
      keywords: ['book meeting', 'schedule call', 'set up demo', 'book appointment'],
      risk: 'write',
      input: z.object({
        calendarId: id('calendar'), contactId: id('contact'),
        startAt: isoDate('start time, ISO UTC e.g. 2026-11-06T15:00:00Z'),
        endAt: isoDate('end time; defaults to startAt + calendar duration').optional(),
        hostUserId: z.string().optional().describe('calendar host user ID; defaults to the first active host who is free'),
        title: z.string().optional(), notes: z.string().optional(),
      }),
      output: appointment,
      handler: (i, ctx) => {
        const cal = ctx.get('calendars', i.calendarId, 'calendar');
        if (cal.status !== 'active') fail('INVALID_STATE', `calendar ${cal.name} is archived; choose an active calendar (List calendars)`);
        const c = ctx.get('contacts', i.contactId, 'contact');
        if (c.status !== 'active') fail('INVALID_STATE', `contact ${c.id} is ${c.status}${c.mergedInto ? `; use ${c.mergedInto}` : ''}`);
        const { startAt, endAt } = times(i, cal.durationMin, ctx);
        let host = i.hostUserId;
        if (host) {
          checkHost(ctx, cal, host);
          assertFree(ctx, host, startAt, endAt);
        } else {
          host = cal.hostUserIds.find((u) => ctx.find('users', u)?.status === 'active' && !clashes(ctx, u, startAt, endAt).length);
          if (!host) fail('CONFLICT', `no host of ${cal.name} is free ${startAt}–${endAt}; use Find available slots to pick a free time`);
        }
        return ctx.insert('appointments', {
          calendarId: cal.id, contactId: c.id, hostUserId: host, title: i.title || `${cal.name} with ${c.name}`,
          startAt, endAt, status: 'booked', attendees: [], notes: i.notes ?? null,
        });
      },
      example: (ctx) => ({ calendarId: ctx.all('calendars')[0].id, contactId: 'con_002', hostUserId: 'usr_002', startAt: '2026-11-24T14:00:00Z' }),
    },
    {
      id: 'get_appointment', name: 'Get appointment details', description: 'Fetch one booked meeting by ID: time, host, contact, calendar, attendees, status and outcome.',
      ...ops.get('appointments', { what: 'appointment' }),
      example: (ctx) => ({ id: ctx.all('appointments')[0].id }),
    },
    {
      id: 'search_appointments', name: 'Search appointments',
      description: 'Find booked meetings by contact(s), calendar, host, status, start-time range, or upcoming=true (future booked/confirmed). Sorted by start time. Use to check whether contacts/leads already have a meeting.',
      keywords: ['upcoming meetings', 'my calendar', 'scheduled calls', 'who has a meeting'],
      risk: 'read',
      input: z.object({
        contactId: z.string().optional(), contactIds: z.array(z.string()).optional().describe('match any of these contact IDs'),
        calendarId: z.string().optional(), hostUserId: z.string().optional(),
        status: z.union([z.enum(STATUSES), z.array(z.enum(STATUSES))]).optional(),
        startAtAfter: isoDate().optional(), startAtBefore: isoDate().optional(),
        upcoming: z.boolean().optional().describe('true = future booked/confirmed only; false = everything else (past, cancelled, completed, no-show)'),
        limit,
      }),
      output: listOf(appointment),
      handler: ({ upcoming, limit: lim, ...f }, ctx) => {
        const now = ms(ctx.now);
        const rows = ctx.all('appointments').filter((a) => matchFilters(a, f) &&
          (upcoming === undefined || upcoming === (OPEN.includes(a.status) && ms(a.startAt) >= now)));
        return page([...rows].sort((a, b) => ms(a.startAt) - ms(b.startAt)), lim);
      },
      example: () => ({ upcoming: true }),
    },
    {
      id: 'reschedule_appointment', name: 'Reschedule appointment',
      description: 'Move a booked/confirmed meeting to a new future time (keeps its length unless endAt given). Checks the calendar is active and the host is still an active host and free (like Create appointment, working hours/notice/buffer are not enforced); a confirmed meeting returns to booked for reconfirmation.',
      keywords: ['move meeting', 'change time'],
      risk: 'write',
      input: z.object({ id: id('appointment'), startAt: isoDate('new start time, ISO UTC'), endAt: isoDate('new end time; defaults to keeping the current length').optional() }),
      output: appointment,
      handler: (i, ctx) => {
        const a = ctx.get('appointments', i.id, 'appointment');
        openApt(a);
        const cal = ctx.get('calendars', a.calendarId, 'calendar');
        if (cal.status !== 'active') fail('INVALID_STATE', `calendar ${cal.name} is archived; cancel this appointment and book on an active calendar`);
        checkHost(ctx, cal, a.hostUserId); // host may have been deactivated since booking → reassign first
        const { startAt, endAt } = times(i, (ms(a.endAt) - ms(a.startAt)) / 6e4, ctx);
        assertFree(ctx, a.hostUserId, startAt, endAt, a.id);
        return ctx.patch(a, { startAt, endAt, status: 'booked', rescheduledFrom: a.startAt });
      },
      example: (ctx) => ({ id: futureOpen(ctx).find((a) => a.hostUserId !== 'usr_004').id, startAt: '2026-11-25T14:00:00Z' }),
    },
    {
      id: 'cancel_appointment', name: 'Cancel appointment',
      description: 'Cancel a booked/confirmed meeting (frees the host\'s time). Reason optional. For event seats use Cancel attendee registration.',
      keywords: ['call off meeting', 'delete appointment'],
      risk: 'destructive',
      input: z.object({ id: id('appointment'), reason: z.string().optional() }),
      output: appointment,
      handler: ({ id: aid, reason }, ctx) => {
        const a = ctx.get('appointments', aid, 'appointment');
        openApt(a);
        return ctx.patch(a, { status: 'cancelled', cancelReason: reason ?? null, cancelledAt: ctx.now });
      },
      example: (ctx) => ({ id: futureOpen(ctx)[0].id, reason: 'Contact requested cancellation' }),
    },
    {
      id: 'assign_appointment_host', name: 'Assign appointment host',
      description: 'Hand one booked/confirmed meeting to a different host. New host must be an active host of the meeting\'s calendar and free at that time. To add a host to a whole calendar use Assign calendar host.',
      keywords: ['reassign meeting', 'change host', 'cover meeting'],
      risk: 'write',
      input: z.object({ id: id('appointment'), hostUserId: id('new host user') }),
      output: appointment,
      handler: ({ id: aid, hostUserId }, ctx) => {
        const a = ctx.get('appointments', aid, 'appointment');
        openApt(a);
        if (a.hostUserId === hostUserId) fail('VALIDATION', `${hostUserId} already hosts appointment ${a.id}`);
        checkHost(ctx, ctx.get('calendars', a.calendarId, 'calendar'), hostUserId);
        assertFree(ctx, hostUserId, a.startAt, a.endAt, a.id);
        return ctx.patch(a, { hostUserId, previousHostUserId: a.hostUserId });
      },
      example: (ctx) => {
        for (const a of futureOpen(ctx)) {
          const cal = ctx.find('calendars', a.calendarId);
          const to = cal.hostUserIds.find((u) => u !== a.hostUserId && ctx.find('users', u)?.status === 'active' && !clashes(ctx, u, a.startAt, a.endAt, a.id).length);
          if (to) return { id: a.id, hostUserId: to };
        }
      },
    },
    {
      id: 'add_appointment_attendee', name: 'Add appointment attendee',
      description: 'Invite an extra guest (existing contact or name/email) to a booked meeting, beyond its primary contact.',
      keywords: ['invite guest', 'add participant'],
      risk: 'write',
      input: z.object({
        id: id('appointment'), contactId: z.string().optional().describe('existing contact to add'),
        name: z.string().optional(), email: z.email().optional(),
      }).refine((o) => o.contactId || o.name, 'provide contactId, or name (and optionally email)'),
      output: appointment,
      handler: (i, ctx) => {
        const a = ctx.get('appointments', i.id, 'appointment');
        openApt(a);
        const c = i.contactId && ctx.get('contacts', i.contactId, 'contact');
        if (c && c.id === a.contactId) fail('DUPLICATE', `${c.name} is already the primary contact of ${a.id}`);
        const guest = { name: c ? c.name : i.name, email: (c ? c.email : i.email) ?? null, contactId: c ? c.id : null };
        const dup = a.attendees.find((x) => (guest.contactId && x.contactId === guest.contactId) || (guest.email && x.email?.toLowerCase() === guest.email.toLowerCase()));
        if (dup) fail('DUPLICATE', `${guest.name} is already an attendee (${dup.id})`);
        const added = { id: ctx.newId('att'), ...guest };
        a.attendees.push(added);
        return { ...ctx.patch(a, {}), added };
      },
      example: (ctx) => ({ id: futureOpen(ctx)[0].id, name: 'Tom Rivera', email: 'tom.rivera@example.com' }),
    },
    {
      id: 'remove_appointment_attendee', name: 'Remove appointment attendee', description: 'Remove an extra guest (by attendee ID) from a booked meeting. The primary contact cannot be removed; cancel or reassign instead.',
      ...ops.removeItem('appointments', 'attendees', { itemParam: 'attendeeId', what: 'appointment', guard: (a) => openApt(a) }),
      example: (ctx) => {
        const a = ctx.all('appointments').find((x) => OPEN.includes(x.status) && x.attendees.length);
        return { id: a.id, attendeeId: a.attendees[0].id };
      },
    },
    {
      id: 'mark_no_show', name: 'Mark attendee no-show',
      description: 'Record that the contact did not show up to a booked/confirmed meeting. Only allowed after the start time has passed.',
      keywords: ['didn\'t show', 'missed meeting', 'ghosted'],
      risk: 'write',
      input: z.object({ id: id('appointment'), outcome: z.string().optional().describe('optional note') }),
      output: appointment,
      handler: closeOut('no_show'),
      example: (ctx) => ({ id: pastOpen(ctx).id }),
    },
    {
      id: 'mark_completed', name: 'Mark appointment completed',
      description: 'Record that a booked/confirmed meeting took place, with optional outcome notes. Only allowed after the start time has passed.',
      keywords: ['meeting done', 'meeting happened', 'log outcome'],
      risk: 'write',
      input: z.object({ id: id('appointment'), outcome: z.string().optional().describe('meeting result / notes') }),
      output: appointment,
      handler: closeOut('completed'),
      example: (ctx) => ({ id: pastOpen(ctx).id, outcome: 'Good fit; sending proposal.' }),
    },
  ],

  seed(ctx, h) {
    const cals = Object.fromEntries(ctx.all('calendars').map((c) => [c.name, c]));
    const contacts = ctx.all('contacts').filter((c) => c.status === 'active');
    const discovery = cals['Sales Discovery Call'];
    if (!discovery || !contacts.length) return;
    const now = ms(ctx.now);
    const at = (day, hour) => {
      const d = new Date(now + day * 864e5);
      d.setUTCHours(hour, 0, 0, 0);
      return d.toISOString();
    };
    const weekend = (day) => [0, 6].includes(new Date(now + day * 864e5).getUTCDay());
    const bizDay = (day) => {
      while (weekend(day)) day += day > 0 ? 1 : -1;
      return day;
    };
    const busy = (uid, s, e, withBlocks) =>
      ctx.all('appointments').some((a) => a.hostUserId === uid && a.status !== 'cancelled' && ms(a.startAt) < ms(e) && ms(a.endAt) > ms(s)) ||
      (withBlocks && (ctx.all('availability').find((r) => r.userId === uid)?.blocks || []).some((b) => ms(b.startAt) < ms(e) && ms(b.endAt) > ms(s)));
    // First free hour for `uid` on the given days; cancelled rows never block.
    const place = (cal, uid, days, hours, withBlocks) => {
      for (const d of days) for (const hr of hours) {
        const s = at(d, hr);
        if (!busy(uid, s, plusMin(s, cal.durationMin), withBlocks)) return s;
      }
      return null;
    };
    const add = (cal, contact, hostUserId, startAt, status, extra = {}) =>
      ctx.insert('appointments', {
        calendarId: cal.id, contactId: contact.id, hostUserId, title: `${cal.name} with ${contact.name}`,
        startAt, endAt: plusMin(startAt, cal.durationMin), status, attendees: [], notes: null,
        createdAt: new Date(Math.min(now, ms(startAt)) - h.int(2, 10) * 864e5).toISOString(), ...extra,
      });

    // Eval fixture: every 3rd lead created in the last 14 days (table order) has a booked discovery call in the next 7 days.
    const BIZ = [1, 2, 5, 6, 7]; // Thu, Fri, Mon, Tue, Wed after now
    const recent = ctx.all('leads').filter((l) => now - ms(l.createdAt) <= 14 * 864e5 && ms(l.createdAt) <= now);
    let k = 0;
    recent.forEach((lead, i) => {
      if (i % 3 !== 0) return;
      const contact = ctx.find('contacts', lead.contactId);
      if (!contact) return;
      const host = discovery.hostUserIds.includes(lead.ownerId) ? lead.ownerId : 'usr_002';
      const days = BIZ.map((_, j) => BIZ[(k + j) % BIZ.length]);
      const s = place(discovery, host, days, [15, 16, 14, 13, 11, 10, 9]);
      k++;
      if (s) add(discovery, contact, host, s, 'booked', { leadId: lead.id });
    });

    // Named fixtures.
    const byId = (cid) => ctx.find('contacts', cid);
    const demo = cals['Product Demo'], onboarding = cals['Customer Onboarding'];
    if (byId('con_001') && demo) {
      const s = place(demo, 'usr_003', [1, 2], [14, 11, 10], true);
      if (s) add(demo, byId('con_001'), 'usr_003', s, 'confirmed', { attendees: [{ id: ctx.newId('att'), name: 'Tom Johnson', email: 'tom.johnson@example.com', contactId: null }] });
    }
    if (byId('con_001') && onboarding) add(onboarding, byId('con_001'), 'usr_001', at(bizDay(-20), 15), 'completed', { outcome: 'Kickoff done; goals agreed.' });
    // Meetings whose start has passed but outcome not yet recorded.
    if (byId('con_003')) add(discovery, byId('con_003'), 'usr_002', at(0, 8), 'booked');
    if (byId('con_002')) add(discovery, byId('con_002'), 'usr_005', at(bizDay(-1), 16), 'confirmed');

    // ~21 general appointments across active calendars.
    const active = ['Sales Discovery Call', 'Product Demo', 'Support Session', 'Customer Onboarding'].map((n) => cals[n]).filter(Boolean);
    const pattern = ['completed', 'booked', 'completed', 'confirmed', 'no_show', 'completed', 'booked', 'cancelled', 'completed', 'confirmed'];
    for (let j = 0; j < 21; j++) {
      const status = pattern[j % pattern.length];
      const future = OPEN.includes(status) || (status === 'cancelled' && j % 2 === 1);
      const cal = active[j % active.length];
      const host = h.pick(cal.hostUserIds);
      const day = bizDay(future ? h.int(1, 9) : -h.int(1, 30));
      const s = place(cal, host, [day, bizDay(day + 1), bizDay(day + 2)], [h.int(9, 15), 10, 11, 13, 14], true);
      if (!s) continue;
      add(cal, contacts[(j * 7 + 5) % contacts.length], host, s, status, {
        ...(status === 'cancelled' ? { cancelReason: 'Contact requested a different week', cancelledAt: new Date(Math.min(now, ms(s)) - 864e5).toISOString() } : {}),
        ...(status === 'completed' ? { outcome: h.pick(['Qualified; next step booked.', 'Issue resolved.', 'Needs follow-up next quarter.']) } : {}),
      });
    }
  },
});
