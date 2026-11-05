import { defineModule, z, id, entity, isoDate, fail, page, addDays, daysBetween } from '../kit.js';

// Simplification: working hours are evaluated as UTC (record.timezone is informational), so every time in/out is UTC.
const UTC_NOTE = 'Working hours are evaluated as UTC in this system; all times are UTC.';
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const OPEN = ['booked', 'confirmed'];
const STEP_MIN = 30; // slot start granularity
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM (24h, UTC)');
const range = z.object({ start: hhmm, end: hhmm }).refine((r) => r.start < r.end, 'start must be before end');
const ranges = z.array(range).describe('working ranges, e.g. [{start:"09:00",end:"17:00"}]; [] = day off');

const timeRange = z.looseObject({ start: z.string(), end: z.string() });
const availability = entity({
  userId: z.string(), timezone: z.string(), weeklyHours: z.record(z.string(), z.array(timeRange)),
  dateOverrides: z.array(z.looseObject({ date: z.string(), unavailable: z.boolean(), slots: z.array(timeRange) })),
  blocks: z.array(z.looseObject({ id: z.string(), startAt: z.string(), endAt: z.string(), reason: z.string() })),
  minNoticeHours: z.number(), maxHorizonDays: z.number(),
});

const ms = (s) => Date.parse(s);
const iso = (s) => new Date(s).toISOString();
const WORKWEEK = () => Object.fromEntries(DAYS.map((d) => [d, ['sat', 'sun'].includes(d) ? [] : [{ start: '09:00', end: '17:00' }]]));

function recFor(ctx, userId, create = false) {
  const u = ctx.get('users', userId, 'user');
  let r = ctx.all('availability').find((x) => x.userId === userId);
  if (!r && create) {
    if (u.status !== 'active') fail('INVALID_STATE', `${u.name} is ${u.status}; only active users have availability`);
    r = ctx.insert('availability', { userId, timezone: 'UTC', weeklyHours: WORKWEEK(), dateOverrides: [], blocks: [], minNoticeHours: 4, maxHorizonDays: 60 });
  }
  if (!r) fail('NOT_FOUND', `no availability configured for ${u.name} (${userId}); create it with Set weekly working hours`);
  return r;
}
function noOverlap(list, where) {
  const s = [...list].sort((a, b) => (a.start < b.start ? -1 : 1));
  for (let i = 1; i < s.length; i++)
    if (s[i].start < s[i - 1].end) fail('VALIDATION', `${where}: ranges ${s[i - 1].start}-${s[i - 1].end} and ${s[i].start}-${s[i].end} overlap`);
  return s;
}
/** Working windows for a date: a date override wins over the weekly schedule. */
function windowsFor(r, date) {
  const o = r.dateOverrides.find((x) => x.date === date);
  const list = o ? (o.unavailable ? [] : o.slots) : r.weeklyHours[DAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]] || [];
  return list.map((w) => [ms(`${date}T${w.start}:00Z`), ms(`${date}T${w.end}:00Z`)]);
}
const hostApts = (ctx, uid) => ctx.all('appointments').filter((a) => a.hostUserId === uid && OPEN.includes(a.status));
const overlaps = (s, e, x) => ms(x.startAt) < e && ms(x.endAt) > s;
const aptBrief = (a) => ({ id: a.id, title: a.title, startAt: a.startAt, endAt: a.endAt, calendarId: a.calendarId, contactId: a.contactId, status: a.status });
const userParam = { userId: id('user') };
const setNumber = (field, schema) => ({
  risk: 'write',
  input: z.object({ ...userParam, [field]: schema }),
  output: availability,
  handler: (i, ctx) => ctx.patch(recFor(ctx, i.userId), { [field]: i[field] }),
});

export default defineModule({
  id: 'availability',
  code: 'M22',
  name: 'Availability',
  description: 'Manage bookable time and scheduling constraints.',
  tables: { availability: { prefix: 'avl', schema: availability } },
  actions: [
    {
      id: 'set_weekly_hours', name: 'Set weekly working hours',
      description: `Set a user's recurring weekly bookable hours per weekday (only the days given are replaced; [] = day off). ${UTC_NOTE}`,
      keywords: ['working hours', 'office hours', 'schedule'],
      risk: 'write',
      input: z.object({
        ...userParam,
        // strict: an unknown key like "saturday" must error, not be silently dropped
        weeklyHours: z.strictObject(Object.fromEntries(DAYS.map((d) => [d, ranges.optional()])))
          .refine((o) => Object.keys(o).length > 0, 'give at least one weekday, e.g. {mon:[{start:"09:00",end:"17:00"}]}'),
      }),
      output: availability,
      handler: ({ userId, weeklyHours }, ctx) => {
        const r = recFor(ctx, userId, true);
        const next = { ...r.weeklyHours };
        for (const [d, list] of Object.entries(weeklyHours)) next[d] = noOverlap(list, d);
        return ctx.patch(r, { weeklyHours: next });
      },
      example: () => ({ userId: 'usr_005', weeklyHours: { mon: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }] } }),
    },
    {
      id: 'get_weekly_hours', name: 'Get weekly working hours',
      description: `A user's availability profile: weekly hours, date overrides, time blocks (out of office etc.), minimum notice and booking horizon. ${UTC_NOTE} To get actual open times use Find available slots.`,
      keywords: ['when does x work', 'out of office', 'availability settings'],
      risk: 'read',
      input: z.object(userParam),
      output: availability,
      handler: ({ userId }, ctx) => recFor(ctx, userId),
      example: () => ({ userId: 'usr_002' }),
    },
    {
      id: 'add_date_override', name: 'Add date-specific availability',
      description: 'Override one date for a user: custom hours (slots) or unavailable=true (day off). Replaces any existing override for that date; the weekly schedule is untouched.',
      keywords: ['day off', 'special hours', 'holiday'],
      risk: 'write',
      input: z.object({
        ...userParam, date: DATE, slots: z.array(range).optional().describe('custom working ranges for that date'),
        unavailable: z.boolean().optional().describe('true = not bookable at all that date'),
      }).refine((o) => Boolean(o.unavailable ? !o.slots?.length : o.slots?.length), 'provide either slots (custom hours) or unavailable: true'),
      output: availability,
      handler: ({ userId, date, slots, unavailable }, ctx) => {
        if (date < ctx.today) fail('VALIDATION', `date ${date} is in the past (today is ${ctx.today})`);
        const r = recFor(ctx, userId);
        const override = { date, unavailable: !!unavailable, slots: unavailable ? [] : noOverlap(slots, date) };
        const dateOverrides = [...r.dateOverrides.filter((o) => o.date !== date), override].sort((a, b) => (a.date < b.date ? -1 : 1));
        return { ...ctx.patch(r, { dateOverrides }), override };
      },
      example: () => ({ userId: 'usr_003', date: '2026-11-16', slots: [{ start: '10:00', end: '14:00' }] }),
    },
    {
      id: 'remove_date_override', name: 'Remove date-specific availability', description: 'Delete a user\'s override for one date so that date follows the weekly schedule again.',
      risk: 'write',
      input: z.object({ ...userParam, date: DATE }),
      output: availability,
      handler: ({ userId, date }, ctx) => {
        const r = recFor(ctx, userId);
        if (!r.dateOverrides.some((o) => o.date === date))
          fail('NOT_FOUND', `no override on ${date}; existing overrides: ${r.dateOverrides.map((o) => o.date).join(', ') || 'none'}`);
        return ctx.patch(r, { dateOverrides: r.dateOverrides.filter((o) => o.date !== date) });
      },
      example: (ctx) => {
        const r = ctx.all('availability').find((x) => x.dateOverrides.length);
        return { userId: r.userId, date: r.dateOverrides[0].date };
      },
    },
    {
      id: 'block_time', name: 'Block time range',
      description: 'Make a user unbookable for a datetime range (out of office, personal time). Existing appointments in the range are NOT cancelled; they are returned as overlappingAppointments to reschedule or reassign.',
      keywords: ['out of office', 'vacation', 'busy', 'time off'],
      risk: 'write',
      input: z.object({ ...userParam, startAt: isoDate('block start, ISO UTC'), endAt: isoDate('block end, ISO UTC'), reason: z.string().optional() }),
      output: availability,
      handler: (i, ctx) => {
        const r = recFor(ctx, i.userId);
        const startAt = iso(i.startAt), endAt = iso(i.endAt);
        if (ms(endAt) <= ms(startAt)) fail('VALIDATION', 'endAt must be after startAt');
        if (ms(endAt) <= ms(ctx.now)) fail('VALIDATION', `the range ends in the past (now is ${ctx.now})`);
        const added = { id: ctx.newId('blk'), startAt, endAt, reason: i.reason || 'Busy' };
        r.blocks.push(added);
        const overlappingAppointments = hostApts(ctx, i.userId).filter((a) => overlaps(ms(startAt), ms(endAt), a)).map(aptBrief);
        return { ...ctx.patch(r, {}), added, overlappingAppointments };
      },
      example: () => ({ userId: 'usr_002', startAt: '2026-11-12T13:00:00Z', endAt: '2026-11-12T14:30:00Z', reason: 'Dentist' }),
    },
    {
      id: 'remove_time_block', name: 'Remove time block', description: 'Delete a time block (by block ID, e.g. blk_001) so that time becomes bookable again.',
      risk: 'write',
      input: z.object({ blockId: id('time block') }),
      output: availability,
      handler: ({ blockId }, ctx) => {
        const r = ctx.all('availability').find((x) => x.blocks.some((b) => b.id === blockId));
        if (!r) fail('NOT_FOUND', `time block '${blockId}' not found; see blocks via Get weekly working hours`);
        const removed = r.blocks.find((b) => b.id === blockId);
        return { ...ctx.patch(r, { blocks: r.blocks.filter((b) => b.id !== blockId) }), removed };
      },
      example: (ctx) => ({ blockId: ctx.all('availability').find((x) => x.blocks.length).blocks[0].id }),
    },
    {
      id: 'set_min_notice', name: 'Set minimum booking notice',
      description: 'Minimum hours ahead a user can be booked (e.g. 24 = no same-day bookings). Per user; calendar buffers are separate.',
      keywords: ['lead time', 'advance notice'],
      ...setNumber('minNoticeHours', z.number().int().min(0).max(720).describe('hours (0-720)')),
      example: () => ({ userId: 'usr_002', minNoticeHours: 12 }),
    },
    {
      id: 'set_max_horizon', name: 'Set maximum booking horizon',
      description: 'How many days into the future a user can be booked (1-365).',
      keywords: ['booking window', 'how far ahead'],
      ...setNumber('maxHorizonDays', z.number().int().min(1).max(365).describe('days (1-365)')),
      example: () => ({ userId: 'usr_002', maxHorizonDays: 30 }),
    },
    {
      id: 'find_available_slots', name: 'Find available slots',
      description: `Open bookable times for a user, or for all active hosts of a calendar (uses its duration and buffer), over a date range of up to 14 days. Subtracts time blocks and booked/confirmed appointments and respects date overrides, minimum notice and booking horizon. ${UTC_NOTE}`,
      keywords: ['free time', 'when is x free', 'open slots', 'availability'],
      risk: 'read',
      input: z.object({
        userId: z.string().optional().describe('user to check; with calendarId, restricts to that host'),
        calendarId: z.string().optional().describe('calendar whose hosts, duration and buffer to use'),
        startDate: DATE.describe('first day, YYYY-MM-DD'),
        endDate: DATE.optional().describe('last day inclusive, YYYY-MM-DD; max 14 days span; default startDate + 6'),
        durationMin: z.number().int().min(5).max(480).optional().describe('defaults to calendar duration, else 30'),
        limit: z.number().int().min(1).max(200).default(50),
      }).refine((o) => o.userId || o.calendarId, 'provide userId or calendarId'),
      output: z.looseObject({ durationMin: z.number(), total: z.number(), items: z.array(z.looseObject({ startAt: z.string(), endAt: z.string(), userIds: z.array(z.string()) })) }),
      handler: ({ userId, calendarId, startDate, endDate, durationMin, limit: lim }, ctx) => {
        const cal = calendarId && ctx.get('calendars', calendarId, 'calendar');
        if (cal && cal.status !== 'active') fail('INVALID_STATE', `calendar ${cal.name} is archived`);
        if (userId) {
          ctx.get('users', userId, 'user');
          if (cal && !cal.hostUserIds.includes(userId)) fail('VALIDATION', `${userId} is not a host of ${cal.name} (hosts: ${cal.hostUserIds.join(', ')})`);
        }
        const users = (userId ? [userId] : cal.hostUserIds).filter((u) => ctx.find('users', u)?.status === 'active');
        const end = endDate ?? addDays(startDate, 6).slice(0, 10);
        const nDays = daysBetween(startDate, end) + 1;
        if (nDays < 1) fail('VALIDATION', 'endDate must be on or after startDate');
        if (nDays > 14) fail('VALIDATION', `range is ${nDays} days; maximum is 14 — split into smaller ranges`);
        const dur = (durationMin ?? cal?.durationMin ?? 30) * 6e4, buf = (cal?.bufferMin ?? 0) * 6e4, now = ms(ctx.now);
        const slots = new Map();
        for (const uid of users) {
          const r = ctx.all('availability').find((x) => x.userId === uid);
          if (!r) continue;
          const earliest = now + r.minNoticeHours * 36e5, latest = now + r.maxHorizonDays * 864e5;
          const busy = [
            ...r.blocks.map((b) => [ms(b.startAt), ms(b.endAt)]),
            ...hostApts(ctx, uid).map((a) => [ms(a.startAt) - buf, ms(a.endAt) + buf]),
          ];
          for (let d = 0; d < nDays; d++)
            for (const [ws, we] of windowsFor(r, addDays(startDate, d).slice(0, 10)))
              for (let s = ws; s + dur <= we; s += STEP_MIN * 6e4) {
                if (s < earliest || s > latest || busy.some(([bs, be]) => bs < s + dur && be > s)) continue;
                const k = new Date(s).toISOString();
                if (!slots.has(k)) slots.set(k, { startAt: k, endAt: new Date(s + dur).toISOString(), userIds: [] });
                slots.get(k).userIds.push(uid);
              }
        }
        const items = [...slots.values()].sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
        return { startDate, endDate: end, durationMin: dur / 6e4, bufferMin: buf / 6e4, timezone: 'UTC', note: UTC_NOTE, ...page(items, lim) };
      },
      example: (ctx) => ({ calendarId: ctx.all('calendars')[0]?.id, startDate: addDays(ctx.now, 1).slice(0, 10), endDate: addDays(ctx.now, 7).slice(0, 10) }),
    },
    {
      id: 'check_scheduling_conflicts', name: 'Check scheduling conflicts',
      description: `Check whether a user is free for a specific time range: lists overlapping booked/confirmed appointments and time blocks, and flags outside working hours, inside minimum notice, or beyond the booking horizon. ${UTC_NOTE}`,
      keywords: ['is x free', 'double booked', 'clash'],
      risk: 'read',
      input: z.object({ ...userParam, startAt: isoDate('start, ISO UTC'), endAt: isoDate('end, ISO UTC') }),
      output: z.looseObject({ userId: z.string(), isFree: z.boolean(), appointments: z.array(z.looseObject({ id: z.string() })), blocks: z.array(z.looseObject({ id: z.string() })), outsideWorkingHours: z.boolean() }),
      handler: (i, ctx) => {
        const r = recFor(ctx, i.userId);
        const s = ms(i.startAt), e = ms(i.endAt), now = ms(ctx.now);
        if (e <= s) fail('VALIDATION', 'endAt must be after startAt');
        const appointments = hostApts(ctx, i.userId).filter((a) => overlaps(s, e, a)).map(aptBrief);
        const blocks = r.blocks.filter((b) => overlaps(s, e, b));
        const outsideWorkingHours = !windowsFor(r, iso(s).slice(0, 10)).some(([ws, we]) => ws <= s && e <= we);
        const withinMinimumNotice = s < now + r.minNoticeHours * 36e5;
        const beyondHorizon = s > now + r.maxHorizonDays * 864e5;
        return {
          userId: i.userId, startAt: iso(s), endAt: iso(e), isFree: !appointments.length && !blocks.length && !outsideWorkingHours,
          appointments, blocks, outsideWorkingHours, withinMinimumNotice, beyondHorizon, note: UTC_NOTE,
        };
      },
      example: () => ({ userId: 'usr_004', startAt: '2026-11-05T15:00:00Z', endAt: '2026-11-05T15:30:00Z' }),
    },
  ],

  seed(ctx) {
    const day = (n) => addDays(ctx.today, n).slice(0, 10);
    const dow = new Date(ctx.now).getUTCDay();
    const monday = day(-((dow + 6) % 7));
    for (const u of ctx.all('users').filter((x) => x.status === 'active'))
      ctx.insert('availability', {
        userId: u.id, timezone: 'UTC', weeklyHours: WORKWEEK(), dateOverrides: [], blocks: [],
        minNoticeHours: u.id === 'usr_001' ? 24 : 4, maxHorizonDays: 60,
      });
    const rec = (uid) => ctx.all('availability').find((r) => r.userId === uid);
    // usr_004 Marcus Reed: out of office the whole current week (Mon 00:00 to next Mon 00:00 UTC).
    rec('usr_004')?.blocks.push({ id: ctx.newId('blk'), startAt: `${monday}T00:00:00.000Z`, endAt: `${addDays(monday, 7).slice(0, 10)}T00:00:00.000Z`, reason: 'Out of office (vacation)' });
    rec('usr_002')?.blocks.push({ id: ctx.newId('blk'), startAt: `${day(1)}T12:00:00.000Z`, endAt: `${day(1)}T13:00:00.000Z`, reason: 'Team lunch' });
    // usr_003 Priya Shah: half day on Friday two weeks out.
    rec('usr_003')?.dateOverrides.push({ date: addDays(monday, 18).slice(0, 10), unavailable: false, slots: [{ start: '09:00', end: '12:00' }] });
  },
});
