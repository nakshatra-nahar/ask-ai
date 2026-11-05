import { defineModule, ops, z, id, entity, isoDate, fail } from '../kit.js';

const TYPES = ['webinar', 'workshop', 'meetup', 'class'];
const STATUSES = ['scheduled', 'completed', 'cancelled'];
const registration = z.looseObject({ id: z.string(), contactId: z.string(), status: z.enum(['registered', 'checked_in', 'cancelled']), registeredAt: z.string() });
const event = entity({
  name: z.string(), description: z.string().nullable().optional(), type: z.enum(TYPES), startAt: z.string(), endAt: z.string(),
  location: z.string().nullable().optional(), capacity: z.number(), hostUserId: z.string().nullable().optional(), status: z.enum(STATUSES),
  registrations: z.array(registration), waitlist: z.array(z.looseObject({ id: z.string(), contactId: z.string(), addedAt: z.string() })),
});

const ms = (s) => Date.parse(s);
const iso = (s) => new Date(s).toISOString();
const taken = (e) => e.registrations.filter((r) => r.status !== 'cancelled').length;
const counts = (e) => ({ ...e, registeredCount: taken(e), seatsLeft: Math.max(0, e.capacity - taken(e)), waitlistCount: e.waitlist.length });
const activeReg = (e, cid) => e.registrations.find((r) => r.contactId === cid && r.status !== 'cancelled');
const capacity = z.number().int().min(1).max(10000).describe('max registered attendees');

function openEvent(e, ctx) {
  if (e.status !== 'scheduled') fail('INVALID_STATE', `event ${e.id} (${e.name}) is ${e.status}; registrations are closed`);
  if (ms(e.endAt) < ms(ctx.now)) fail('INVALID_STATE', `event ${e.name} already ended at ${e.endAt}`);
}
function activeContact(ctx, cid) {
  const c = ctx.get('contacts', cid, 'contact');
  if (c.status !== 'active') fail('INVALID_STATE', `contact ${c.id} is ${c.status}${c.mergedInto ? `; use ${c.mergedInto}` : ''}`);
  return c;
}
function activeHost(ctx, uid) {
  const u = ctx.get('users', uid, 'user');
  if (u.status !== 'active') fail('INVALID_STATE', `host ${u.name} is ${u.status}`);
}
const withEvent = (handler) => (i, ctx) => counts(handler(ctx.get('events', i.id, 'event'), i, ctx));
const eventContact = { id: id('event'), contactId: id('contact') };

export default defineModule({
  id: 'events',
  code: 'M24',
  name: 'Events',
  description: 'Manage group sessions and registrations.',
  tables: { events: { prefix: 'evt', schema: event } },
  actions: [
    {
      id: 'create_event', name: 'Create event',
      description: 'Create a group session (webinar, workshop, meetup, class) with a capacity that contacts register for. For a 1:1 meeting use Create appointment.',
      keywords: ['new webinar', 'host workshop', 'group session'],
      ...ops.create('events', {
        input: z.object({
          name: z.string().min(1), type: z.enum(TYPES), startAt: isoDate('start, ISO UTC'), endAt: isoDate('end, ISO UTC'), capacity,
          description: z.string().optional(), location: z.string().optional().describe('venue or join URL'), hostUserId: z.string().optional(),
        }),
        check: (i, ctx) => {
          if (ms(i.endAt) <= ms(i.startAt)) fail('VALIDATION', 'endAt must be after startAt');
          if (ms(i.startAt) < ms(ctx.now)) fail('VALIDATION', `startAt is in the past (now is ${ctx.now})`);
          if (i.hostUserId) activeHost(ctx, i.hostUserId);
        },
        build: (i) => ({
          startAt: iso(i.startAt), endAt: iso(i.endAt), description: i.description ?? null, location: i.location ?? null,
          hostUserId: i.hostUserId ?? null, status: 'scheduled', registrations: [], waitlist: [],
        }),
      }),
      example: () => ({ name: 'Holiday Sales Workshop', type: 'workshop', startAt: '2026-12-02T15:00:00Z', endAt: '2026-12-02T17:00:00Z', capacity: 25 }),
    },
    {
      id: 'get_event', name: 'Get event details',
      description: 'One event with seat counts (registered, seats left, waitlist) and attendee names/statuses.',
      risk: 'read',
      input: z.object({ id: id('event') }),
      output: event,
      handler: ({ id: eid }, ctx) => {
        const e = counts(ctx.get('events', eid, 'event'));
        const name = (cid) => ctx.find('contacts', cid)?.name;
        return { ...e, registrations: e.registrations.map((r) => ({ ...r, contactName: name(r.contactId) })), waitlist: e.waitlist.map((w) => ({ ...w, contactName: name(w.contactId) })) };
      },
      example: () => ({ id: 'evt_001' }),
    },
    {
      id: 'search_events', name: 'Search events',
      description: 'Find group events by name text, type, status, host or start date range (startAtAfter/startAtBefore).',
      keywords: ['upcoming webinars', 'list events'],
      ...ops.search('events', {
        text: ['name', 'description'],
        filters: {
          type: z.enum(TYPES).optional(), status: z.enum(STATUSES).optional(), hostUserId: z.string().optional(),
          startAtAfter: isoDate().optional(), startAtBefore: isoDate().optional(),
        },
        sort: (a, b) => ms(a.startAt) - ms(b.startAt),
      }),
      example: () => ({ type: 'webinar' }),
    },
    {
      id: 'update_event', name: 'Update event details', description: 'Change a scheduled event\'s name, description, location, host or times. Capacity has its own action.',
      ...ops.update('events', {
        what: 'event',
        fields: { name: z.string().min(1), description: z.string(), location: z.string(), hostUserId: z.string(), startAt: isoDate(), endAt: isoDate() },
        guard: (e, i, ctx) => {
          if (e.status !== 'scheduled') fail('INVALID_STATE', `event ${e.id} is ${e.status}; only scheduled events can be edited`);
          if (ms(i.endAt ?? e.endAt) <= ms(i.startAt ?? e.startAt)) fail('VALIDATION', 'endAt must be after startAt');
          if (i.startAt && ms(i.startAt) < ms(ctx.now)) fail('VALIDATION', `startAt is in the past (now is ${ctx.now})`);
          if (i.hostUserId) activeHost(ctx, i.hostUserId);
        },
        after: (e) => Object.assign(e, { startAt: iso(e.startAt), endAt: iso(e.endAt) }),
      }),
      example: () => ({ id: 'evt_002', location: 'https://webinar.acme.test/ai-smb-live' }),
    },
    {
      id: 'set_event_capacity', name: 'Set event capacity',
      description: 'Change the maximum number of registered attendees. Cannot go below the current registration count. Raising it does not auto-promote the waitlist.',
      ...ops.set('events', 'capacity', capacity, {
        what: 'event',
        guard: (e, i) => {
          if (i.capacity < taken(e))
            fail('CONFLICT', `${taken(e)} attendees are registered for ${e.name}; capacity must be at least ${taken(e)}. Cancel registrations first to go lower.`);
        },
      }),
      example: () => ({ id: 'evt_001', capacity: 25 }),
    },
    {
      id: 'register_attendee', name: 'Register attendee',
      description: 'Register a contact for a group event (takes a seat). Fails LIMIT_EXCEEDED when the event is full (use Add attendee to waitlist) and DUPLICATE if already registered. Not for 1:1 appointments.',
      keywords: ['sign up for webinar', 'rsvp', 'enroll in event'],
      risk: 'write',
      input: z.object(eventContact),
      output: event,
      handler: withEvent((e, i, ctx) => {
        openEvent(e, ctx);
        const c = activeContact(ctx, i.contactId);
        const dup = activeReg(e, c.id);
        if (dup) fail('DUPLICATE', `${c.name} is already registered for ${e.name} (${dup.id}, ${dup.status})`);
        if (taken(e) >= e.capacity)
          fail('LIMIT_EXCEEDED', `${e.name} is full (${taken(e)}/${e.capacity}). Add ${c.name} with Add attendee to waitlist, or raise capacity with Set event capacity.`);
        e.registrations.push({ id: ctx.newId('reg'), contactId: c.id, status: 'registered', registeredAt: ctx.now });
        return ctx.patch(e, { waitlist: e.waitlist.filter((w) => w.contactId !== c.id) });
      }),
      example: () => ({ id: 'evt_002', contactId: 'con_002' }),
    },
    {
      id: 'cancel_registration', name: 'Cancel attendee registration',
      description: 'Cancel a contact\'s event registration, freeing a seat. Does not auto-promote anyone; use Promote waitlisted attendee next. For 1:1 meetings use Cancel appointment.',
      keywords: ['unregister', 'remove from event'],
      risk: 'destructive',
      input: z.object({ ...eventContact, reason: z.string().optional() }),
      output: event,
      handler: withEvent((e, i, ctx) => {
        const r = activeReg(e, i.contactId);
        if (!r) fail('NOT_FOUND', `${i.contactId} has no active registration for ${e.name}`);
        if (r.status === 'checked_in') fail('INVALID_STATE', `${i.contactId} already checked in at ${r.checkedInAt}; cannot cancel`);
        Object.assign(r, { status: 'cancelled', cancelledAt: ctx.now, cancelReason: i.reason ?? null });
        return ctx.patch(e, {});
      }),
      example: (ctx) => ({ id: 'evt_002', contactId: ctx.find('events', 'evt_002').registrations[0].contactId }),
    },
    {
      id: 'add_to_waitlist', name: 'Add attendee to waitlist',
      description: 'Put a contact on a full event\'s waitlist (first come, first served). Only when the event is full; otherwise register directly.',
      risk: 'write',
      input: z.object(eventContact),
      output: event,
      handler: withEvent((e, i, ctx) => {
        openEvent(e, ctx);
        const c = activeContact(ctx, i.contactId);
        if (activeReg(e, c.id)) fail('DUPLICATE', `${c.name} is already registered for ${e.name}`);
        if (e.waitlist.some((w) => w.contactId === c.id)) fail('DUPLICATE', `${c.name} is already on the waitlist for ${e.name}`);
        if (taken(e) < e.capacity) fail('INVALID_STATE', `${e.name} has ${e.capacity - taken(e)} free seat(s); use Register attendee instead`);
        e.waitlist.push({ id: ctx.newId('wtl'), contactId: c.id, addedAt: ctx.now });
        return ctx.patch(e, {});
      }),
      example: () => ({ id: 'evt_001', contactId: 'con_002' }),
    },
    {
      id: 'promote_waitlisted', name: 'Promote waitlisted attendee',
      description: 'Move a contact (default: first in line) from the waitlist into a free seat. Fails LIMIT_EXCEEDED if no seat is free.',
      risk: 'write',
      input: z.object({ id: id('event'), contactId: z.string().optional().describe('waitlisted contact; default = first in line') }),
      output: event,
      handler: withEvent((e, i, ctx) => {
        openEvent(e, ctx);
        if (!e.waitlist.length) fail('INVALID_STATE', `the waitlist for ${e.name} is empty`);
        if (taken(e) >= e.capacity)
          fail('LIMIT_EXCEEDED', `${e.name} is full (${taken(e)}/${e.capacity}); raise capacity or cancel a registration first`);
        const w = i.contactId ? e.waitlist.find((x) => x.contactId === i.contactId) : [...e.waitlist].sort((a, b) => Date.parse(a.addedAt) - Date.parse(b.addedAt))[0]; // first in line = earliest addedAt
        if (!w) fail('NOT_FOUND', `${i.contactId} is not on the waitlist; waitlisted: ${e.waitlist.map((x) => x.contactId).join(', ')}`);
        e.registrations.push({ id: ctx.newId('reg'), contactId: w.contactId, status: 'registered', registeredAt: ctx.now, promotedFromWaitlist: true });
        return ctx.patch(e, { waitlist: e.waitlist.filter((x) => x !== w), lastPromoted: w.contactId });
      }),
      example: () => ({ id: 'evt_005' }),
    },
    {
      id: 'check_in_attendee', name: 'Check in attendee',
      description: 'Mark a registered contact as attended/checked in. Only on or after the event day; cancelled registrations cannot check in.',
      keywords: ['attendance', 'mark attended'],
      risk: 'write',
      input: z.object(eventContact),
      output: event,
      handler: withEvent((e, i, ctx) => {
        if (e.status === 'cancelled') fail('INVALID_STATE', `event ${e.name} was cancelled`);
        if (ctx.today < e.startAt.slice(0, 10)) fail('INVALID_STATE', `check-in opens on the event day ${e.startAt.slice(0, 10)} (today is ${ctx.today})`);
        const r = [...e.registrations].reverse().find((x) => x.contactId === i.contactId);
        if (!r) fail('NOT_FOUND', `${i.contactId} is not registered for ${e.name}; register them first`);
        if (r.status !== 'registered') fail('INVALID_STATE', `registration ${r.id} is '${r.status}'; only 'registered' attendees can check in`);
        Object.assign(r, { status: 'checked_in', checkedInAt: ctx.now });
        return ctx.patch(e, {});
      }),
      example: (ctx) => ({ id: 'evt_004', contactId: ctx.find('events', 'evt_004').registrations[0].contactId }),
    },
  ],

  seed(ctx, h) {
    const pool = ctx.all('contacts').filter((c) => c.status === 'active').map((c) => c.id);
    const at = (day, hour) => {
      const d = new Date(Date.parse(ctx.now) + day * 864e5);
      d.setUTCHours(hour, 0, 0, 0);
      return d.toISOString();
    };
    const regs = (ids, regDaysAgo, status = () => 'registered') =>
      ids.map((contactId, i) => ({ id: ctx.newId('reg'), contactId, status: status(i), registeredAt: h.daysAgo(regDaysAgo()) }));
    const wait = (ids) => ids.map((contactId) => ({ id: ctx.newId('wtl'), contactId, addedAt: h.daysAgo(h.int(1, 3)) }));
    const add = (name, type, day, hour, hours, capacity, extra) =>
      ctx.insert('events', {
        name, type, startAt: at(day, hour), endAt: at(day, hour + hours), capacity, status: 'scheduled', description: null,
        location: type === 'webinar' ? `https://webinar.acme.test/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : 'Acme HQ, 200 Market St',
        hostUserId: 'usr_008', registrations: [], waitlist: [], createdAt: h.daysAgo(h.int(30, 60)), ...extra,
      });
    // evt_001 full workshop (capacity reached) with a waitlist; con_002 deliberately neither registered nor waitlisted.
    add('Q4 Growth Masterclass', 'workshop', 9, 15, 3, 20, {
      description: 'Hands-on growth planning for Q4.', registrations: regs([pool[0], ...pool.slice(5, 24)].filter(Boolean), () => h.int(3, 25)), waitlist: wait(pool.slice(24, 27)),
    });
    add('AI for Small Business', 'webinar', 6, 17, 1, 500, { description: 'How SMBs use AI assistants.', hostUserId: 'usr_001', registrations: regs(pool.slice(30, 42), () => h.int(1, 14)) });
    add('Hands-on CRM Workshop', 'workshop', -14, 14, 3, 30, {
      status: 'completed', description: 'Pipeline and automation basics.',
      registrations: regs(pool.slice(40, 55), () => h.int(15, 40), (i) => (i < 10 ? 'checked_in' : 'registered')).map((r) => (r.status === 'checked_in' ? { ...r, checkedInAt: at(-14, 14) } : r)),
    });
    add('Customer Appreciation Mixer', 'meetup', 0, 17, 2, 60, { description: 'Drinks with customers (today).', hostUserId: 'usr_001', registrations: regs([pool[0], ...pool.slice(55, 62)].filter(Boolean), () => h.int(2, 20)) });
    // evt_005 has one cancellation → one free seat and a waitlist (promote fixture).
    add('Local SEO Bootcamp', 'class', 14, 16, 2, 10, {
      description: 'Rank your business locally.', registrations: regs(pool.slice(62, 72), () => h.int(2, 20), (i) => (i === 9 ? 'cancelled' : 'registered')), waitlist: wait(pool.slice(72, 74)),
    });
    add('Spring Product Launch Preview', 'webinar', 16, 17, 1, 200, { status: 'cancelled', description: 'Postponed to spring.', registrations: regs(pool.slice(2, 5), () => h.int(5, 20), () => 'cancelled') });
    add('Year-End Planning Webinar', 'webinar', 35, 17, 1, 100, { description: 'Plan 2027 budgets and campaigns.', registrations: regs(pool.slice(74, 77), () => h.int(1, 5)) });
  },
});
