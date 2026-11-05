// Scheduling (calendars, appointments, availability, booking pages, events), learning (courses, lessons,
// enrollments, communities, memberships) and web (websites, funnels, landing pages). Expected sets are derived from seed data.
import { TOMORROW } from '../fixtures.js';

const NOW = '2026-11-04T10:00:00.000Z';
const FRI = '2026-11-06';
const NEXT_MON = '2026-11-09';
const CANT = /(can't|cannot|can not|unable|not able|couldn't|could not|don't have|do not have|not support|isn't supported|no (action|capability|way|integration))/i;

const user = (h, name) => h.find('users', (u) => u.name === name);
const contact = (h, name) => h.find('contacts', (c) => c.name === name);
const course = (h, title) => h.find('courses', (c) => c.title === title);
const event = (h, name) => h.find('events', (e) => e.name === name);
const plan = (h, name) => h.find('membership_plans', (p) => p.name === name);
const community = (h, name) => h.find('communities', (c) => c.name === name);
const website = (h, name) => h.find('websites', (w) => w.name === name);
const funnel = (h, name) => h.find('funnels', (f) => f.name === name);
const enrollment = (h, who, title) => h.find('enrollments', (e) => e.contactId === contact(h, who).id && e.courseId === course(h, title).id);
const lesson = (h, title) => h.find('lessons', (l) => l.title === title);
const apt = (h, who, day) => h.find('appointments', (a) => a.contactId === contact(h, who).id && a.startAt.startsWith(day));
const avl = (h, name) => h.find('availability', (r) => r.userId === user(h, name).id);
const registered = (e) => e.registrations.filter((r) => ['registered', 'checked_in'].includes(r.status)).map((r) => r.contactId);
/** Enrollments whose learner has completed every published lesson of the course. */
const finishedAll = (h, e) => h.all('lessons').filter((l) => l.courseId === e.courseId && l.status === 'published').every((l) => e.completedLessons.some((x) => x.lessonId === l.id));

export default [
  // ---------------------------------------------------------------- direct
  {
    id: 'sch-direct-new-calendar',
    category: 'direct',
    modules: ['calendars'],
    turns: [{ user: 'Set up a new "Website Audit Call" calendar — 45 min meetings, Priya Shah hosting, and anyone with the link can book it.' }],
    expect: {
      actions: ['calendars.create_calendar'],
      allow: ['calendars.assign_calendar_host', 'calendars.set_appointment_duration', 'calendars.set_calendar_visibility'],
      params: { 'calendars.create_calendar': { name: /website audit call/i } },
      state: (h) => {
        const c = h.created('calendars').filter((x) => /website audit call/i.test(x.name));
        if (c.length !== 1) return `expected 1 Website Audit Call calendar, got ${c.length}`;
        if (!c[0].hostUserIds.includes(user(h, 'Priya Shah').id)) return 'Priya Shah is not a host';
        if (c[0].durationMin !== 45) return `duration ${c[0].durationMin}, expected 45`;
        return c[0].visibility === 'public' || `visibility ${c[0].visibility}, expected public`;
      },
    },
    oracle: (call, h) => call('calendars.create_calendar', { name: 'Website Audit Call', durationMin: 45, hostUserIds: [user(h, 'Priya Shah').id], visibility: 'public' }),
  },
  {
    id: 'sch-direct-dentist-block',
    category: 'direct',
    modules: ['availability'],
    turns: [{ user: "Dana Cruz has a dentist appointment next Monday from 1 to 3pm, block that off on her calendar pls" }],
    expect: {
      actions: ['availability.block_time'],
      params: { 'availability.block_time': { userId: 'usr_005', startAt: NEXT_MON } },
      state: (h) => {
        const b = avl(h, 'Dana Cruz').blocks.filter((x) => x.startAt.startsWith(NEXT_MON));
        if (b.length !== 1) return `expected 1 block on ${NEXT_MON}, got ${b.length}`;
        return Date.parse(b[0].endAt) - Date.parse(b[0].startAt) === 2 * 36e5 || 'block is not 2 hours long';
      },
    },
    oracle: (call, h) => call('availability.block_time', { userId: user(h, 'Dana Cruz').id, startAt: `${NEXT_MON}T13:00:00Z`, endAt: `${NEXT_MON}T15:00:00Z`, reason: 'Dentist appointment' }),
  },
  {
    id: 'sch-direct-holiday-webinar',
    category: 'direct',
    modules: ['events'],
    turns: [{ user: "Schedule a webinar called 'Holiday Email Playbook' on Dec 2 from 5 to 6pm UTC. Cap it at 150 people, Morgan Blake is hosting." }],
    expect: {
      actions: ['events.create_event'],
      params: { 'events.create_event': { name: /holiday email playbook/i, type: 'webinar', capacity: 150, startAt: '2026-12-02', hostUserId: 'usr_008' } },
      state: (h) => {
        const e = h.created('events').filter((x) => /holiday email playbook/i.test(x.name));
        if (e.length !== 1) return `expected 1 Holiday Email Playbook event, got ${e.length}`;
        const [ev] = e;
        if (ev.type !== 'webinar' || ev.capacity !== 150) return `type/capacity ${ev.type}/${ev.capacity}`;
        if (!ev.startAt.startsWith('2026-12-02')) return `starts ${ev.startAt}`;
        return ev.hostUserId === user(h, 'Morgan Blake').id || `host ${ev.hostUserId}`;
      },
    },
    oracle: (call, h) =>
      call('events.create_event', { name: 'Holiday Email Playbook', type: 'webinar', startAt: '2026-12-02T17:00:00Z', endAt: '2026-12-02T18:00:00Z', capacity: 150, hostUserId: user(h, 'Morgan Blake').id }),
  },
  {
    id: 'sch-direct-smm-drip',
    category: 'direct',
    modules: ['lessons', 'courses'],
    turns: [{ user: "In Social Media Marketing 101, 'Planning a Content Calendar' should unlock 3 days after someone enrolls instead of a week." }],
    expect: {
      actions: ['lessons.set_lesson_release_schedule'],
      params: { 'lessons.set_lesson_release_schedule': { id: 'les_004', mode: 'drip', daysAfterEnrollment: 3 } },
      state: (h) => {
        const r = lesson(h, 'Planning a Content Calendar').release;
        return (r.mode === 'drip' && r.daysAfterEnrollment === 3) || `release is ${JSON.stringify(r)}`;
      },
    },
    oracle: (call, h) => call('lessons.set_lesson_release_schedule', { id: lesson(h, 'Planning a Content Calendar').id, mode: 'drip', daysAfterEnrollment: 3 }),
  },
  {
    id: 'sch-direct-extend-enrollment',
    category: 'direct',
    modules: ['enrollments'],
    turns: [{ user: "Extend David Brown's access to Social Media Marketing 101 through March 31, 2027." }],
    expect: {
      actions: ['enrollments.set_enrollment_expiry'],
      params: { 'enrollments.set_enrollment_expiry': { id: 'enr_009', expiresAt: '2027-03-31' } },
      state: (h) => {
        const e = enrollment(h, 'David Brown', 'Social Media Marketing 101');
        return (e.expiresAt || '').startsWith('2027-03-31') || `expiresAt is ${e.expiresAt}`;
      },
    },
    oracle: (call, h) => call('enrollments.set_enrollment_expiry', { id: enrollment(h, 'David Brown', 'Social Media Marketing 101').id, expiresAt: '2027-03-31' }),
  },
  {
    id: 'sch-direct-community-channel',
    category: 'direct',
    modules: ['communities'],
    turns: [{ user: "Can you add a 'resources' channel to the Growth Hackers Club? It's for people sharing templates and tools." }],
    expect: {
      actions: ['communities.create_channel'],
      params: { 'communities.create_channel': { id: 'cmty_001', name: /resources/i } },
      state: (h) => community(h, 'Growth Hackers Club').channels.filter((c) => /resources/i.test(c.name)).length === 1 || 'no single resources channel in Growth Hackers Club',
    },
    oracle: (call, h) => call('communities.create_channel', { id: community(h, 'Growth Hackers Club').id, name: 'resources', description: 'Share templates and tools' }),
  },
  {
    id: 'sch-direct-basic-membership',
    category: 'direct',
    modules: ['memberships'],
    turns: [{ user: 'Give Grace Nguyen a Basic Membership.' }],
    expect: {
      actions: ['memberships.grant_membership'],
      params: { 'memberships.grant_membership': { contactId: 'con_013', planId: 'mpl_001' } },
      state: (h) =>
        h.created('memberships').filter((m) => m.contactId === contact(h, 'Grace Nguyen').id && m.planId === plan(h, 'Basic Membership').id && m.status === 'active').length === 1 ||
        'Grace Nguyen has no new active Basic membership',
    },
    oracle: (call, h) => call('memberships.grant_membership', { contactId: contact(h, 'Grace Nguyen').id, planId: plan(h, 'Basic Membership').id }),
  },
  {
    id: 'sch-direct-dental-page',
    category: 'direct',
    modules: ['websites'],
    turns: [{ user: "Add a 'Book Online' page to the Bright Smile Dental website at /book-online" }],
    expect: {
      actions: ['websites.add_website_page'],
      params: { 'websites.add_website_page': { id: 'web_001', slug: /book-online/ } },
      state: (h) => website(h, 'Bright Smile Dental').pages.some((p) => p.slug === 'book-online' && /book online/i.test(p.title)) || 'no Book Online page at /book-online',
    },
    oracle: (call, h) => call('websites.add_website_page', { id: website(h, 'Bright Smile Dental').id, title: 'Book Online', slug: 'book-online' }),
  },
  {
    id: 'sch-direct-demo-thankyou',
    category: 'direct',
    modules: ['booking_pages'],
    turns: [{ user: "Change the thank-you message on the Product Demo booking page to: \"Thanks for booking! You'll get a short agenda from our team before the demo.\"" }],
    expect: {
      actions: ['booking_pages.set_booking_confirmation_message'],
      params: { 'booking_pages.set_booking_confirmation_message': { id: 'bp_002', message: /short agenda/i } },
      state: (h) => /short agenda from our team/i.test(h.find('booking_pages', (p) => p.name === 'Product Demo').confirmationMessage) || 'Product Demo confirmation message not updated',
    },
    oracle: (call, h) =>
      call('booking_pages.set_booking_confirmation_message', { id: h.find('booking_pages', (p) => p.name === 'Product Demo').id, message: "Thanks for booking! You'll get a short agenda from our team before the demo." }),
  },
  {
    id: 'sch-direct-declined-cancel',
    category: 'direct',
    modules: ['appointments'],
    turns: [{ user: "Cancel Sarah Chen's discovery call tomorrow, she can't make it anymore.", confirm: false }],
    invariant: true, // user declines the destructive cancel: nothing may change
    expect: {
      confirmRequested: true,
      noWrites: true,
      state: (h) => ['booked', 'confirmed'].includes(apt(h, 'Sarah Chen', TOMORROW).status) || 'appointment was cancelled despite the user declining',
    },
  },

  // ---------------------------------------------------------------- indirect
  {
    id: 'sch-indirect-spam-post',
    category: 'indirect',
    modules: ['communities'],
    turns: [{ user: "ugh, someone is pushing fake followers in the Growth Hackers Club again. Can you deal with it?" }],
    expect: {
      actions: ['communities.remove_reported_post'],
      allow: ['communities.leave_community'],
      state: (h) => {
        const posts = h.all('community_posts').filter((p) => p.communityId === community(h, 'Growth Hackers Club').id);
        const spam = posts.filter((p) => p.reportReasons.some((r) => /spam|scam/.test(r)));
        if (!spam.length) return 'fixture has no spam reports';
        const left = spam.filter((p) => p.status !== 'removed');
        if (left.length) return `spam still up: ${left.map((p) => p.id).join(', ')}`;
        const collateral = posts.filter((p) => !p.reports && p.removedAt === NOW);
        return !collateral.length || `removed unreported posts: ${collateral.map((p) => p.id).join(', ')}`;
      },
    },
    oracle: (call, h) =>
      h.all('community_posts').filter((p) => p.status === 'published' && p.reportReasons.some((r) => /spam|scam/.test(r))).forEach((p) => call('communities.remove_reported_post', { id: p.id, reason: 'Spam: selling fake followers' })),
  },
  {
    id: 'sch-indirect-onboarding-booking',
    category: 'indirect',
    modules: ['booking_pages', 'calendars'],
    turns: [{ user: "New customers keep emailing me asking where they can book their onboarding kickoff. Can we make that self-serve?" }],
    expect: {
      actions: ['booking_pages.publish_booking_page'],
      allow: ['booking_pages.create_booking_page', 'booking_pages.link_calendar_to_booking_page', 'booking_pages.update_booking_page_content', 'calendars.set_calendar_visibility'],
      state: (h) => {
        const cal = h.find('calendars', (c) => c.name === 'Customer Onboarding');
        return h.all('booking_pages').some((p) => p.calendarId === cal.id && p.status === 'published') || 'no published booking page books into Customer Onboarding';
      },
    },
    oracle: (call, h) => call('booking_pages.publish_booking_page', { id: h.find('booking_pages', (p) => p.name === 'Customer Onboarding').id }),
  },
  {
    id: 'sch-indirect-bootcamp-seat',
    category: 'indirect',
    modules: ['events'],
    turns: [{ user: "Looks like someone dropped out of the Local SEO Bootcamp. Let's not leave that seat empty — be fair about who gets it." }],
    expect: {
      actions: [['events.promote_waitlisted', 'events.register_attendee']],
      state: (h) => {
        const e = event(h, 'Local SEO Bootcamp');
        const fresh = e.registrations.filter((r) => r.registeredAt === NOW);
        if (fresh.length !== 1) return `expected 1 new registration, got ${fresh.length}`;
        // Seed waitlist: con_073 (added Nov 1) has waited longer than con_074 (added Nov 2).
        if (fresh[0].contactId !== 'con_073') return `seat went to ${fresh[0].contactId}, not the longest-waiting con_073`;
        if (e.waitlist.some((w) => w.contactId === 'con_073')) return 'con_073 still on the waitlist';
        return registered(e).length === e.capacity || `${registered(e).length}/${e.capacity} seats taken`;
      },
    },
    oracle: (call, h) => call('events.promote_waitlisted', { id: event(h, 'Local SEO Bootcamp').id }),
  },

  // ---------------------------------------------------------------- multi_step
  {
    id: 'sch-multi-slot-book-confirm',
    category: 'multi_step',
    modules: ['availability', 'calendars', 'appointments', 'email'],
    turns: [{ user: "Mei Rossi wants a product demo with Priya Shah on Monday the 9th. Grab Priya's earliest open slot that day, book it, add Mei's colleague Ben Ortiz (ben.ortiz@rossidesign.co) as a guest, and email Mei a confirmation with the time." }],
    expect: {
      actions: [['availability.find_available_slots', 'availability.check_scheduling_conflicts'], 'appointments.create_appointment', 'appointments.add_appointment_attendee', 'email.send_email'],
      allow: ['contacts.create_contact', 'email.draft_email'],
      params: { 'appointments.create_appointment': { contactId: 'con_044', calendarId: 'cal_002', hostUserId: 'usr_003', startAt: NEXT_MON } },
      state: (h) => {
        const mei = contact(h, 'Mei Rossi');
        const a = h.created('appointments').filter((x) => x.contactId === mei.id);
        if (a.length !== 1) return `expected 1 new appointment for Mei, got ${a.length}`;
        const demo = h.find('calendars', (c) => c.name === 'Product Demo');
        if (a[0].calendarId !== demo.id || a[0].hostUserId !== user(h, 'Priya Shah').id) return 'not a Product Demo hosted by Priya';
        const dayStart = avl(h, 'Priya Shah').weeklyHours.mon[0].start; // nothing is booked for Priya that morning, so the first slot opens with her day
        if (a[0].startAt.slice(0, 16) !== `${NEXT_MON}T${dayStart}`) return `booked ${a[0].startAt}, not the earliest slot ${NEXT_MON}T${dayStart}`;
        if (!a[0].attendees.some((g) => /ben\.ortiz@rossidesign\.co/i.test(g.email || '') || /ben ortiz/i.test(g.name))) return 'Ben Ortiz not added as guest';
        return h.created('messages').some((m) => m.channel === 'email' && m.contactId === mei.id && ['sent', 'delivered'].includes(m.status)) || 'no confirmation email sent to Mei';
      },
    },
    oracle: (call, h) => {
      const demo = h.find('calendars', (c) => c.name === 'Product Demo');
      const priya = user(h, 'Priya Shah').id;
      const mei = contact(h, 'Mei Rossi').id;
      const slot = call('availability.find_available_slots', { calendarId: demo.id, userId: priya, startDate: NEXT_MON, endDate: NEXT_MON }).items[0];
      const a = call('appointments.create_appointment', { calendarId: demo.id, contactId: mei, hostUserId: priya, startAt: slot.startAt });
      call('appointments.add_appointment_attendee', { id: a.id, name: 'Ben Ortiz', email: 'ben.ortiz@rossidesign.co' });
      call('email.send_email', { contactId: mei, subject: 'Your product demo is booked', body: `Hi Mei, your demo with Priya is confirmed for ${slot.startAt} (UTC).` });
    },
  },
  {
    id: 'sch-multi-meal-plan-funnel',
    category: 'multi_step',
    modules: ['funnels', 'landing_pages'],
    turns: [{ user: "Launch the Free 7-Day Meal Plan funnel today. If any of its pages aren't live yet, publish those too." }],
    expect: {
      actions: ['landing_pages.publish_landing_page', 'funnels.publish_funnel'],
      params: { 'landing_pages.publish_landing_page': { id: 'lp_006' } },
      state: (h) => {
        const f = funnel(h, 'Free 7-Day Meal Plan');
        if (f.status !== 'published') return `funnel is ${f.status}`;
        const notLive = f.steps.filter((s) => h.get('landing_pages', s.landingPageId)?.status !== 'published');
        return !notLive.length || `steps without live pages: ${notLive.map((s) => s.id).join(', ')}`;
      },
    },
    oracle: (call, h) => {
      const f = funnel(h, 'Free 7-Day Meal Plan');
      for (const s of f.steps) if (h.get('landing_pages', s.landingPageId).status !== 'published') call('landing_pages.publish_landing_page', { id: s.landingPageId });
      call('funnels.publish_funnel', { id: f.id });
    },
  },
  {
    id: 'sch-multi-reels-course-launch',
    category: 'multi_step',
    modules: ['lessons', 'courses', 'enrollments'],
    turns: [{ user: 'The Instagram Reels for Business course is ready. Get both of its lessons live, publish the course, and enroll Mei Silva as our first student.' }],
    expect: {
      actions: ['lessons.publish_lesson', 'courses.publish_course', 'enrollments.enroll_learner'],
      params: { 'courses.publish_course': { id: 'crs_003' }, 'enrollments.enroll_learner': { contactId: 'con_015', courseId: 'crs_003' } },
      state: (h) => {
        const c = course(h, 'Instagram Reels for Business');
        const drafts = h.all('lessons').filter((l) => l.courseId === c.id && l.status !== 'published');
        if (drafts.length) return `unpublished lessons: ${drafts.map((l) => l.title).join(', ')}`;
        if (c.status !== 'published') return `course is ${c.status}`;
        return h.created('enrollments').some((e) => e.courseId === c.id && e.contactId === contact(h, 'Mei Silva').id && e.status === 'active') || 'Mei Silva not enrolled';
      },
    },
    oracle: (call, h) => {
      const c = course(h, 'Instagram Reels for Business');
      h.all('lessons').filter((l) => l.courseId === c.id && l.status === 'draft').forEach((l) => call('lessons.publish_lesson', { id: l.id }));
      call('courses.publish_course', { id: c.id });
      call('enrollments.enroll_learner', { contactId: contact(h, 'Mei Silva').id, courseId: c.id });
    },
  },
  {
    id: 'sch-multi-funnel-pros-plan',
    category: 'multi_step',
    modules: ['memberships', 'courses', 'communities'],
    turns: [{ user: "Set up a new 'Funnel Pros' membership at $79 a month that includes the Advanced Funnel Building course and the Growth Hackers Club community, then put Sarah Chen on it." }],
    expect: {
      actions: ['memberships.create_membership_plan', 'memberships.grant_membership'],
      allow: ['memberships.add_plan_entitlement', 'memberships.update_plan_description'],
      params: { 'memberships.create_membership_plan': { name: /funnel pros/i, price: 79, interval: 'month' }, 'memberships.grant_membership': { contactId: 'con_002' } },
      state: (h) => {
        const p = h.created('membership_plans').filter((x) => /funnel pros/i.test(x.name));
        if (p.length !== 1) return `expected 1 Funnel Pros plan, got ${p.length}`;
        const refs = p[0].entitlements.map((e) => e.refId);
        const want = [course(h, 'Advanced Funnel Building').id, community(h, 'Growth Hackers Club').id];
        if (!want.every((r) => refs.includes(r)) || refs.length !== want.length) return `entitlements are ${refs.join(', ')}`;
        if (p[0].price !== 79 || p[0].interval !== 'month') return `price ${p[0].price}/${p[0].interval}`;
        return h.created('memberships').some((m) => m.planId === p[0].id && m.contactId === contact(h, 'Sarah Chen').id && m.status === 'active') || 'Sarah Chen not on Funnel Pros';
      },
    },
    oracle: (call, h) => {
      const p = call('memberships.create_membership_plan', {
        name: 'Funnel Pros', price: 79, interval: 'month',
        entitlements: [{ type: 'course', refId: course(h, 'Advanced Funnel Building').id }, { type: 'community', refId: community(h, 'Growth Hackers Club').id }],
      });
      call('memberships.grant_membership', { contactId: contact(h, 'Sarah Chen').id, planId: p.id });
    },
  },
  {
    id: 'sch-multi-kickoff-class',
    category: 'multi_step',
    modules: ['events', 'enrollments', 'courses'],
    turns: [{ user: "We're hosting a live kickoff class for Social Media Marketing 101 on Thursday Nov 19, 4–5pm UTC. 30 seats, Morgan Blake running it. Create it and register everyone who's actively enrolled in the course." }],
    expect: {
      actions: ['events.create_event', 'enrollments.search_enrollments', 'events.register_attendee'],
      params: { 'events.create_event': { type: 'class', capacity: 30, startAt: '2026-11-19', hostUserId: 'usr_008' } },
      state: (h) => {
        const ev = h.created('events').filter((e) => e.startAt.startsWith('2026-11-19'));
        if (ev.length !== 1) return `expected 1 event on 2026-11-19, got ${ev.length}`;
        const live = h.all('enrollments').filter((e) => e.courseId === course(h, 'Social Media Marketing 101').id && e.status === 'active' && !(e.expiresAt && e.expiresAt < NOW));
        const must = live.filter((e) => !e.completedAt).map((e) => e.contactId); // learners who already finished may reasonably be included or skipped
        const may = new Set(live.map((e) => e.contactId));
        const reg = registered(ev[0]);
        const missing = must.filter((c) => !reg.includes(c));
        if (missing.length) return `active learners not registered: ${missing.join(', ')}`;
        const extra = reg.filter((c) => !may.has(c));
        return !extra.length || `registered non-active learners: ${extra.join(', ')}`;
      },
    },
    oracle: (call, h) => {
      const smm = course(h, 'Social Media Marketing 101');
      const ev = call('events.create_event', { name: 'Social Media Marketing 101 Live Kickoff', type: 'class', startAt: '2026-11-19T16:00:00Z', endAt: '2026-11-19T17:00:00Z', capacity: 30, hostUserId: user(h, 'Morgan Blake').id });
      const { items } = call('enrollments.search_enrollments', { courseId: smm.id, status: 'active' });
      for (const e of items) call('events.register_attendee', { id: ev.id, contactId: e.contactId });
    },
  },

  // ---------------------------------------------------------------- conditional
  {
    id: 'sch-cond-smm-certificates',
    category: 'conditional',
    modules: ['enrollments', 'courses'],
    turns: [{ user: "Issue completion certificates for Social Media Marketing 101 to anyone who's finished every lesson but hasn't gotten one yet." }],
    expect: {
      actions: [['enrollments.search_enrollments', 'enrollments.get_learner_progress'], 'enrollments.issue_certificate'],
      forbid: ['enrollments.record_lesson_completion'],
      params: { 'enrollments.issue_certificate': { id: 'enr_002' } },
      state: (h) => {
        const fresh = h.created('certificates');
        const old = h.all('certificates').filter((c) => !fresh.includes(c));
        const smm = course(h, 'Social Media Marketing 101');
        const enr = h.all('enrollments').filter((e) => e.courseId === smm.id && e.status !== 'revoked');
        const want = enr.filter((e) => finishedAll(h, e) && !old.some((c) => c.contactId === e.contactId && c.courseId === smm.id));
        if (!want.length) return 'fixture has no eligible learner';
        for (const e of want) if (!fresh.some((c) => c.enrollmentId === e.id)) return `no certificate for ${e.id}`;
        const stray = fresh.filter((c) => !want.some((e) => e.id === c.enrollmentId));
        return !stray.length || `certificates for ineligible enrollments: ${stray.map((c) => c.enrollmentId).join(', ')}`;
      },
    },
    oracle: (call, h) => {
      const smm = course(h, 'Social Media Marketing 101');
      call('enrollments.search_enrollments', { courseId: smm.id });
      h.all('enrollments')
        .filter((e) => e.courseId === smm.id && e.status !== 'revoked' && finishedAll(h, e) && !h.all('certificates').some((c) => c.contactId === e.contactId && c.courseId === smm.id))
        .forEach((e) => call('enrollments.issue_certificate', { id: e.id }));
    },
  },
  {
    id: 'sch-cond-demo-host-fallback',
    category: 'conditional',
    modules: ['appointments', 'availability', 'calendars'],
    turns: [{ user: 'Liam Nguyen wants a product demo tomorrow at 3pm UTC. Book it with Priya Shah if she’s free then, otherwise put it with Alex Morgan.' }],
    expect: {
      actions: ['appointments.create_appointment'],
      params: { 'appointments.create_appointment': { contactId: 'con_045', calendarId: 'cal_002', startAt: TOMORROW } },
      state: (h) => {
        const start = Date.parse(`${TOMORROW}T15:00:00Z`), end = start + 45 * 6e4;
        const priya = user(h, 'Priya Shah').id;
        const priyaBusy = h.all('appointments').some((a) => a.hostUserId === priya && a.contactId !== contact(h, 'Liam Nguyen').id && ['booked', 'confirmed'].includes(a.status) && Date.parse(a.startAt) < end && Date.parse(a.endAt) > start);
        const host = priyaBusy ? user(h, 'Alex Morgan').id : priya;
        const a = h.created('appointments').filter((x) => x.contactId === contact(h, 'Liam Nguyen').id);
        if (a.length !== 1) return `expected 1 new appointment for Liam, got ${a.length}`;
        if (a[0].startAt.slice(0, 16) !== `${TOMORROW}T15:00`) return `booked at ${a[0].startAt}`;
        return a[0].hostUserId === host || `host ${a[0].hostUserId}, expected ${host} (Priya busy: ${priyaBusy})`;
      },
    },
    oracle: (call, h) => {
      const priya = user(h, 'Priya Shah').id;
      const check = call('availability.check_scheduling_conflicts', { userId: priya, startAt: `${TOMORROW}T15:00:00Z`, endAt: `${TOMORROW}T15:45:00Z` });
      call('appointments.create_appointment', {
        calendarId: h.find('calendars', (c) => c.name === 'Product Demo').id, contactId: contact(h, 'Liam Nguyen').id,
        hostUserId: check.isFree ? priya : user(h, 'Alex Morgan').id, startAt: `${TOMORROW}T15:00:00Z`,
      });
    },
  },

  // ---------------------------------------------------------------- follow_up
  {
    id: 'sch-followup-masterclass-waitlist',
    category: 'follow_up',
    modules: ['events'],
    turns: [{ user: 'Can we bump the Q4 Growth Masterclass to 23 seats?' }, { user: 'Great — now get the folks on the waitlist into those seats.' }],
    expect: {
      actions: ['events.set_event_capacity', ['events.promote_waitlisted', 'events.register_attendee']],
      params: { 'events.set_event_capacity': { id: 'evt_001', capacity: 23 } },
      state: (h) => {
        const e = event(h, 'Q4 Growth Masterclass');
        if (e.capacity !== 23) return `capacity ${e.capacity}`;
        if (e.waitlist.length) return `still waitlisted: ${e.waitlist.map((w) => w.contactId).join(', ')}`;
        return registered(e).length === 23 || `${registered(e).length} registered, expected 23`;
      },
    },
    oracle: (call, h) => {
      const e = event(h, 'Q4 Growth Masterclass');
      call('events.set_event_capacity', { id: e.id, capacity: 23 });
      for (const w of [...e.waitlist]) call('events.promote_waitlisted', { id: e.id, contactId: w.contactId });
    },
  },
  {
    id: 'sch-followup-black-friday-page',
    category: 'follow_up',
    modules: ['landing_pages', 'websites'],
    turns: [
      { user: "Make a landing page for our Black Friday whitening deal on the Bright Smile Dental site. Slug black-friday-whitening, headline 'Black Friday: 50% off professional whitening'." },
      { user: 'Give it a hero section and an FAQ section, then put it live.' },
    ],
    expect: {
      actions: ['landing_pages.create_landing_page', 'landing_pages.add_page_section', 'landing_pages.publish_landing_page'],
      allow: ['landing_pages.update_page_content', 'landing_pages.set_page_seo'],
      params: { 'landing_pages.create_landing_page': { slug: 'black-friday-whitening', websiteId: 'web_001' } },
      state: (h) => {
        const p = h.created('landing_pages').filter((x) => x.slug === 'black-friday-whitening');
        if (p.length !== 1) return `expected 1 page with slug black-friday-whitening, got ${p.length}`;
        if (p[0].websiteId !== website(h, 'Bright Smile Dental').id) return 'page not on Bright Smile Dental';
        const types = p[0].sections.map((s) => s.type);
        if (!types.includes('hero') || !types.includes('faq')) return `sections are ${types.join(', ')}`;
        return p[0].status === 'published' || `page is ${p[0].status}`;
      },
    },
    oracle: (call, h) => {
      const p = call('landing_pages.create_landing_page', { name: 'Black Friday Whitening', slug: 'black-friday-whitening', headline: 'Black Friday: 50% off professional whitening', websiteId: website(h, 'Bright Smile Dental').id });
      call('landing_pages.add_page_section', { id: p.id, type: 'hero', heading: 'Black Friday: 50% off professional whitening' });
      call('landing_pages.add_page_section', { id: p.id, type: 'faq', heading: 'Frequently asked questions' });
      call('landing_pages.publish_landing_page', { id: p.id });
    },
  },
  {
    id: 'sch-followup-move-okafor-call',
    category: 'follow_up',
    modules: ['appointments', 'availability'],
    turns: [{ user: "What's on Jordan Lee's calendar this Friday?" }, { user: 'Move the David Okafor one to Monday, same time.' }],
    expect: {
      actions: ['appointments.reschedule_appointment'],
      params: { 'appointments.reschedule_appointment': { id: 'apt_007', startAt: NEXT_MON } },
      state: (h) => {
        const a = h.find('appointments', (x) => x.contactId === contact(h, 'David Okafor').id && x.hostUserId === user(h, 'Jordan Lee').id && (x.rescheduledFrom || x.startAt).startsWith(FRI));
        if (!a?.rescheduledFrom) return 'David Okafor call was not rescheduled';
        if (!a.startAt.startsWith(NEXT_MON)) return `moved to ${a.startAt}, expected ${NEXT_MON}`;
        return a.startAt.slice(11, 16) === a.rescheduledFrom.slice(11, 16) || `time changed from ${a.rescheduledFrom} to ${a.startAt}`;
      },
    },
    oracle: (call, h) => {
      const jordan = user(h, 'Jordan Lee').id;
      call('appointments.search_appointments', { hostUserId: jordan, startAtAfter: `${FRI}T00:00:00Z`, startAtBefore: `${FRI}T23:59:59Z` });
      const a = apt(h, 'David Okafor', FRI);
      call('appointments.reschedule_appointment', { id: a.id, startAt: `${NEXT_MON}T${a.startAt.slice(11)}` });
    },
  },

  // ---------------------------------------------------------------- ambiguous
  {
    id: 'sch-ambiguous-3pm-call',
    category: 'ambiguous',
    modules: ['appointments', 'calendars'],
    turns: [{ user: "Push tomorrow's 3pm discovery call to next week." }], // two discovery calls start at 15:00 tomorrow, and no new time given
    expect: { clarify: true, noWrites: true },
  },
  {
    id: 'sch-ambiguous-grace-webinar',
    category: 'ambiguous',
    modules: ['events', 'contacts'],
    turns: [{ user: 'Sign Grace up for the Year-End Planning Webinar.' }], // three contacts named Grace
    expect: { clarify: true, noWrites: true },
  },

  // ---------------------------------------------------------------- unsupported
  {
    id: 'sch-unsupported-google-calendar-sync',
    category: 'unsupported',
    modules: ['calendars'],
    turns: [{ user: 'Hook the Sales Discovery Call calendar up to my Google Calendar so new bookings show up on my phone.' }],
    oracleReply: "I can't do that — there's no Google Calendar integration or sync capability here.",
    expect: { noWrites: true, reply: CANT },
  },

  // ---------------------------------------------------------------- failure
  {
    id: 'sch-failure-summer-shred-relaunch',
    category: 'failure',
    modules: ['funnels', 'landing_pages'],
    turns: [{ user: "We're running the Summer Shred Challenge again — put that funnel back live." }],
    invariant: true, // two steps have no landing page, so the funnel cannot go live; the check guards against a fake success
    oracleReply: "I couldn't publish the Summer Shred Challenge funnel: the Nutrition Add-on and Welcome steps have no landing page linked.",
    expect: {
      reply: /(no landing page|not linked|isn't linked|aren't linked|missing|not ready|need(s)? (a )?(landing )?page|couldn't|could not|can't|cannot|unable|failed)/i,
      state: (h) => funnel(h, 'Summer Shred Challenge').status !== 'published' || 'funnel shows as published although steps had no pages',
    },
  },
  {
    id: 'sch-failure-prereq-enroll',
    category: 'failure',
    modules: ['enrollments', 'courses'],
    turns: [{ user: 'Enroll Michael Smith in Advanced Funnel Building.' }],
    invariant: true, // he has not finished the prerequisite course; the check guards against bypassing it
    oracleReply: "I couldn't enroll Michael Smith: Advanced Funnel Building requires Social Media Marketing 101, which he hasn't completed yet.",
    expect: {
      forbid: ['enrollments.record_lesson_completion', 'courses.set_course_prerequisites'],
      reply: /(prerequisite|hasn't (completed|finished)|has not (completed|finished)|needs to (complete|finish)|must (complete|finish)|first complete|couldn't|could not|can't|cannot|unable)/i,
      state: (h) => {
        const fun = course(h, 'Advanced Funnel Building');
        const smiths = h.all('contacts').filter((c) => /^Mi(chael|ke) Smith$/.test(c.name)).map((c) => c.id);
        return !h.all('enrollments').some((e) => e.courseId === fun.id && smiths.includes(e.contactId) && e.status === 'active') || 'Michael Smith enrolled despite missing prerequisite';
      },
    },
  },
];
