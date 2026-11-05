import { defineModule, ops, z, id, entity, isoDate, fail, toTime, addDays } from '../kit.js';

const STATUSES = ['active', 'suspended', 'expired', 'revoked'];
const enrollment = entity({
  contactId: z.string(), courseId: z.string(), status: z.enum(STATUSES), enrolledAt: z.string(),
  expiresAt: z.string().nullable().optional(), completedAt: z.string().nullable().optional(), certificateId: z.string().nullable().optional(),
  completedLessons: z.array(z.looseObject({ lessonId: z.string(), completedAt: z.string() })),
});
const certificate = entity({
  enrollmentId: z.string(), contactId: z.string(), courseId: z.string(), number: z.string(), issuedAt: z.string(), status: z.enum(['issued', 'revoked']),
});
const nextLessonShape = z.looseObject({ id: z.string(), title: z.string(), availableAt: z.string().nullable(), locked: z.boolean() });

const isPast = (ctx, iso) => !!iso && toTime(iso, true) < toTime(ctx.now);
const getEnr = (ctx, eid) => ctx.get('enrollments', eid, 'enrollment');
// Published lessons of a course in outline order (section order, then lesson order).
const courseLessons = (ctx, courseId) =>
  (ctx.find('courses', courseId)?.sections || []).flatMap((s) =>
    s.lessonIds.map((lid) => ({ lesson: ctx.find('lessons', lid), section: s })).filter((x) => x.lesson?.status === 'published'));
// When a lesson unlocks for this enrollment (null = immediately).
function availableAt(l, e) {
  const r = l.release || {};
  if (r.mode === 'date') return r.releaseAt;
  if (r.mode === 'drip') return addDays(e.enrolledAt, r.daysAfterEnrollment);
  return null;
}
const locked = (ctx, l, e) => {
  const at = availableAt(l, e);
  return !!at && toTime(at) > toTime(ctx.now);
};
function progress(ctx, e) {
  const lessons = courseLessons(ctx, e.courseId);
  const done = new Set(e.completedLessons.map((x) => x.lessonId));
  const completed = lessons.filter((x) => done.has(x.lesson.id)).length;
  const nxt = lessons.find((x) => !done.has(x.lesson.id));
  return {
    completedLessons: completed, totalLessons: lessons.length,
    percent: lessons.length ? Math.floor((completed / lessons.length) * 100) : 0,
    nextLesson: nxt ? { id: nxt.lesson.id, title: nxt.lesson.title, sectionTitle: nxt.section.title, availableAt: availableAt(nxt.lesson, e), locked: locked(ctx, nxt.lesson, e) } : null,
  };
}
function assertUsable(ctx, e) {
  const hint = { suspended: 'resume it with resume_enrollment', revoked: 'enroll the learner again', expired: 'extend it with set_enrollment_expiry' };
  if (e.status !== 'active') fail('INVALID_STATE', `enrollment ${e.id} is ${e.status}; ${hint[e.status]}`);
  if (isPast(ctx, e.expiresAt)) fail('INVALID_STATE', `enrollment ${e.id} expired on ${e.expiresAt}; extend it with set_enrollment_expiry`);
}
const completedCourse = (ctx, contactId, courseId) =>
  ctx.all('enrollments').some((e) => e.contactId === contactId && e.courseId === courseId && e.completedAt && e.status !== 'revoked');

export default defineModule({
  id: 'enrollments',
  code: 'M42',
  name: 'Enrollments',
  description: 'Manage learner access and learning progress.',
  tables: {
    enrollments: { prefix: 'enr', schema: enrollment },
    certificates: { prefix: 'cert', schema: certificate },
  },
  actions: [
    {
      id: 'enroll_learner', name: 'Enroll learner in course',
      description: 'Give a contact direct access to one published course (course enrollment). Checks prerequisites. For plan-based access use Memberships; for discussion spaces use Communities.',
      keywords: ['enroll', 'sign up for course', 'give course access', 'register learner'],
      risk: 'write',
      input: z.object({
        contactId: id('contact (learner)'), courseId: id('course'),
        expiresAt: isoDate().optional().describe('optional date course access ends'),
      }),
      output: enrollment,
      handler: ({ contactId, courseId, expiresAt }, ctx) => {
        const ct = ctx.get('contacts', contactId, 'contact');
        if (ct.status !== 'active') fail('INVALID_STATE', `contact ${contactId} (${ct.name}) is ${ct.status}`);
        const c = ctx.get('courses', courseId, 'course');
        if (c.status !== 'published') fail('INVALID_STATE', `course ${courseId} (${c.title}) is ${c.status}; learners can only enroll in published courses`);
        const ex = ctx.all('enrollments').find((e) => e.contactId === contactId && e.courseId === courseId && ['active', 'suspended'].includes(e.status));
        if (ex)
          fail('DUPLICATE', `${ct.name} already has an enrollment in ${c.title} (${ex.id}, ${ex.status})${ex.status === 'suspended' ? '; use resume_enrollment' : ''}`, { existingId: ex.id });
        const missing = c.prerequisiteIds.filter((p) => !completedCourse(ctx, contactId, p)).map((p) => ({ id: p, title: ctx.find('courses', p)?.title }));
        if (missing.length)
          fail('INVALID_STATE', `${ct.name} has not completed the prerequisite course(s) for ${c.title}: ${missing.map((m) => `${m.id} ${m.title}`).join(', ')}. Enroll them in and complete those first`, { missing });
        if (isPast(ctx, expiresAt)) fail('VALIDATION', `expiresAt ${expiresAt} is in the past (now ${ctx.now})`);
        return ctx.insert('enrollments', {
          contactId, courseId, status: 'active', enrolledAt: ctx.now, expiresAt: expiresAt ?? null,
          completedLessons: [], completedAt: null, certificateId: null,
        });
      },
      example: (ctx) => {
        const c = ctx.all('courses').find((x) => x.status === 'published' && !x.prerequisiteIds.length);
        const ct = ctx.all('contacts').find((p) => p.status === 'active' && !ctx.all('enrollments').some((e) => e.contactId === p.id && e.courseId === c.id));
        return { contactId: ct.id, courseId: c.id };
      },
    },
    {
      id: 'get_enrollment', name: 'Get enrollment details',
      description: 'Fetch one course enrollment with learner name, course title, completed lessons and progress summary.',
      risk: 'read',
      input: z.object({ id: id('enrollment') }),
      output: enrollment,
      handler: ({ id: eid }, ctx) => {
        const e = getEnr(ctx, eid);
        return { ...e, contactName: ctx.find('contacts', e.contactId)?.name, courseTitle: ctx.find('courses', e.courseId)?.title, progress: progress(ctx, e) };
      },
      example: (ctx) => ({ id: ctx.all('enrollments')[0].id }),
    },
    {
      id: 'search_enrollments', name: 'Search enrollments',
      description: 'Find course enrollments by learner (contactId), course, status, enrollment date or expiry date.',
      keywords: ['who is enrolled', 'course students', 'learners in course', 'list enrollments'],
      ...ops.search('enrollments', {
        filters: {
          contactId: z.string().optional(), courseId: z.string().optional(), status: z.enum(STATUSES).optional(),
          enrolledAtAfter: isoDate().optional(), enrolledAtBefore: isoDate().optional(),
          expiresAtBefore: isoDate().optional().describe('only enrollments with an expiry on/before this date'),
        },
      }),
      example: (ctx) => ({ courseId: ctx.all('courses')[0].id }),
    },
    {
      id: 'set_enrollment_expiry', name: 'Set enrollment expiry',
      description: 'Set or clear (null) the date a course enrollment\'s access ends. Extending an expired enrollment reactivates it.',
      keywords: ['extend course access', 'access end date'],
      risk: 'write',
      input: z.object({ id: id('enrollment'), expiresAt: isoDate().nullable().describe('when course access ends; null = never expires') }),
      output: enrollment,
      handler: ({ id: eid, expiresAt }, ctx) => {
        const e = getEnr(ctx, eid);
        if (e.status === 'revoked') fail('INVALID_STATE', `enrollment ${eid} is revoked; enroll the learner again instead`);
        if (expiresAt && toTime(expiresAt, true) <= toTime(ctx.now))
          fail('VALIDATION', `expiresAt ${expiresAt} is not in the future (now ${ctx.now}); to end access now use suspend_enrollment or revoke_enrollment`);
        return ctx.patch(e, { expiresAt, ...(e.status === 'expired' ? { status: 'active' } : {}) });
      },
      example: (ctx) => ({ id: ctx.all('enrollments').find((e) => e.status === 'expired').id, expiresAt: '2027-06-30' }),
    },
    {
      id: 'suspend_enrollment', name: 'Suspend enrollment',
      description: 'Temporarily block a learner\'s access to a course (progress kept). Reversible with resume_enrollment.',
      keywords: ['pause course access', 'block learner'],
      ...ops.transition('enrollments', {
        to: 'suspended', from: ['active'], reason: true, what: 'enrollment',
        extra: (e, i, ctx) => ({ suspendedReason: i.reason, suspendedAt: ctx.now }),
      }),
      example: (ctx) => ({ id: ctx.all('enrollments').find((e) => e.status === 'active').id, reason: 'Payment past due' }),
    },
    {
      id: 'resume_enrollment', name: 'Resume enrollment', description: 'Restore a suspended course enrollment to active.',
      keywords: ['unsuspend', 'restore course access'],
      ...ops.transition('enrollments', {
        to: 'active', from: ['suspended'], what: 'enrollment',
        guard: (e, i, ctx) => {
          if (isPast(ctx, e.expiresAt)) fail('INVALID_STATE', `enrollment ${e.id} expired on ${e.expiresAt}; extend it with set_enrollment_expiry before resuming`);
        },
        extra: () => ({ suspendedReason: null, suspendedAt: null }),
      }),
      example: (ctx) => ({ id: ctx.all('enrollments').find((e) => e.status === 'suspended').id }),
    },
    {
      id: 'revoke_enrollment', name: 'Revoke enrollment',
      description: 'Permanently end a learner\'s course access (e.g. refund). Progress is kept for records; re-enrolling creates a new enrollment.',
      keywords: ['remove from course', 'unenroll', 'cancel enrollment'],
      ...ops.transition('enrollments', {
        to: 'revoked', from: ['active', 'suspended', 'expired'], risk: 'destructive', what: 'enrollment',
        extra: (e, i, ctx) => ({ revokedAt: ctx.now, revokedReason: i.reason ?? null }),
      }),
      input: z.object({ id: id('enrollment'), reason: z.string().optional() }),
      example: (ctx) => ({ id: ctx.all('enrollments').find((e) => e.status === 'active').id, reason: 'Refund requested' }),
    },
    {
      id: 'record_lesson_completion', name: 'Record lesson completion',
      description: 'Mark a lesson complete for a course enrollment. The lesson must be published, released (drip) and in the enrolled course, and meet its completion criteria (quiz score / % watched).',
      keywords: ['mark lesson complete', 'complete lesson', 'quiz result'],
      risk: 'write',
      input: z.object({
        id: id('enrollment'), lessonId: id('lesson'),
        score: z.number().min(0).max(100).optional().describe('quiz score %, required for quiz_pass lessons'),
        percentWatched: z.number().min(0).max(100).optional().describe('video % watched, required for video_percent lessons'),
      }),
      output: enrollment,
      handler: ({ id: eid, lessonId, score, percentWatched }, ctx) => {
        const e = getEnr(ctx, eid);
        assertUsable(ctx, e);
        const l = ctx.get('lessons', lessonId, 'lesson');
        if (l.courseId !== e.courseId) fail('VALIDATION', `lesson ${lessonId} belongs to course ${l.courseId}, but enrollment ${eid} is for course ${e.courseId}`);
        if (l.status !== 'published') fail('INVALID_STATE', `lesson ${lessonId} (${l.title}) is not published`);
        if (locked(ctx, l, e)) fail('INVALID_STATE', `lesson '${l.title}' unlocks for this learner on ${availableAt(l, e)} (drip schedule)`, { availableAt: availableAt(l, e) });
        const prev = e.completedLessons.find((x) => x.lessonId === lessonId);
        if (prev) fail('DUPLICATE', `lesson ${lessonId} was already completed on ${prev.completedAt}`);
        const c = l.completion || {};
        if (c.criteria === 'quiz_pass') {
          if (score == null) fail('VALIDATION', `lesson '${l.title}' completes on passing its quiz; provide score (passing score ${c.passingScore})`);
          if (score < c.passingScore) fail('VALIDATION', `quiz score ${score} is below the passing score ${c.passingScore}; the lesson stays incomplete`);
        }
        if (c.criteria === 'video_percent') {
          if (percentWatched == null) fail('VALIDATION', `lesson '${l.title}' requires ${c.videoPercent}% of the video watched; provide percentWatched`);
          if (percentWatched < c.videoPercent) fail('VALIDATION', `only ${percentWatched}% watched; ${c.videoPercent}% required`);
        }
        e.completedLessons.push({ lessonId, completedAt: ctx.now, score: score ?? null, percentWatched: percentWatched ?? null });
        const p = progress(ctx, e);
        ctx.patch(e, p.percent === 100 && !e.completedAt ? { completedAt: ctx.now } : {});
        return { ...e, progress: p };
      },
      example: (ctx) => {
        for (const e of ctx.all('enrollments').filter((x) => x.status === 'active' && !isPast(ctx, x.expiresAt))) {
          const done = new Set(e.completedLessons.map((x) => x.lessonId));
          const l = courseLessons(ctx, e.courseId).map((x) => x.lesson).find((x) => !done.has(x.id) && !locked(ctx, x, e));
          if (l) return { id: e.id, lessonId: l.id, score: 100, percentWatched: 100 };
        }
      },
    },
    {
      id: 'get_learner_progress', name: 'Get learner progress',
      description: 'Course progress for a learner: completed/total published lessons, percent, next lesson (and whether it is drip-locked), per-lesson status. Pass an enrollment id, or contactId + courseId.',
      keywords: ['how far', 'course completion', 'percent complete'],
      risk: 'read',
      input: z.object({
        id: z.string().optional().describe('enrollment ID'),
        contactId: z.string().optional(), courseId: z.string().optional(),
      }),
      output: z.looseObject({
        enrollmentId: z.string(), completedLessons: z.number(), totalLessons: z.number(), percent: z.number(), nextLesson: nextLessonShape.nullable(),
      }),
      handler: ({ id: eid, contactId, courseId }, ctx) => {
        let e;
        if (eid) e = getEnr(ctx, eid);
        else if (contactId && courseId) {
          const rows = ctx.all('enrollments').filter((x) => x.contactId === contactId && x.courseId === courseId);
          e = rows.find((x) => x.status !== 'revoked') || rows.at(-1);
          if (!e) fail('NOT_FOUND', `contact ${contactId} has no enrollment in course ${courseId}`);
        } else fail('VALIDATION', 'provide id (enrollment ID) or both contactId and courseId');
        const done = new Map(e.completedLessons.map((x) => [x.lessonId, x.completedAt]));
        return {
          enrollmentId: e.id, contactId: e.contactId, contactName: ctx.find('contacts', e.contactId)?.name,
          courseId: e.courseId, courseTitle: ctx.find('courses', e.courseId)?.title, status: e.status, expiresAt: e.expiresAt ?? null,
          ...progress(ctx, e), certificateId: e.certificateId ?? null,
          lessons: courseLessons(ctx, e.courseId).map(({ lesson: l, section: s }) => ({
            id: l.id, title: l.title, section: s.title, completed: done.has(l.id), completedAt: done.get(l.id) ?? null,
            availableAt: availableAt(l, e), locked: locked(ctx, l, e),
          })),
        };
      },
      example: (ctx) => ({ id: ctx.all('enrollments').find((e) => e.status === 'active' && !e.completedAt).id }),
    },
    {
      id: 'issue_certificate', name: 'Issue course completion certificate',
      description: 'Issue a completion certificate for a course enrollment. Only allowed at 100% of published lessons; one certificate per learner per course.',
      keywords: ['certificate', 'diploma', 'completion award'],
      risk: 'external',
      input: z.object({ id: id('enrollment') }),
      output: certificate,
      handler: ({ id: eid }, ctx) => {
        const e = getEnr(ctx, eid);
        if (e.status === 'revoked') fail('INVALID_STATE', `enrollment ${eid} is revoked; certificates cannot be issued for it`);
        const dup = ctx.all('certificates').find((c) => c.contactId === e.contactId && c.courseId === e.courseId && c.status === 'issued');
        if (dup) fail('DUPLICATE', `certificate ${dup.number} (${dup.id}) was already issued for this learner and course on ${dup.issuedAt}`, { existingId: dup.id });
        const p = progress(ctx, e);
        if (p.percent < 100)
          fail('INVALID_STATE', `learner has completed ${p.completedLessons}/${p.totalLessons} lessons (${p.percent}%); a certificate requires 100%. Next lesson: ${p.nextLesson?.title}`);
        const n = ctx.all('certificates').length + 1;
        const cert = ctx.insert('certificates', {
          enrollmentId: eid, contactId: e.contactId, courseId: e.courseId,
          number: `CERT-${ctx.today.slice(0, 4)}-${String(n).padStart(4, '0')}`, issuedAt: ctx.now, status: 'issued',
        });
        ctx.patch(e, { certificateId: cert.id });
        return cert;
      },
      example: (ctx) => ({ id: ctx.all('enrollments').find((e) => e.completedAt && !e.certificateId && e.status !== 'revoked').id }),
    },
  ],

  seed(ctx, h) {
    const byTitle = (t) => ctx.all('courses').find((c) => c.title === t);
    const smm = byTitle('Social Media Marketing 101');
    const fun = byTitle('Advanced Funnel Building');
    // [contact, course, enrolled days ago, lessons completed, status, extra]
    const rows = [
      ['con_001', smm, 60, 6, 'active', { cert: true }],
      ['con_002', smm, 45, 6, 'active'], // 100% complete, certificate not issued yet
      ['con_003', smm, 20, 3, 'active'],
      ['con_006', smm, 30, 2, 'suspended', { suspendedReason: 'Payment failed on renewal', suspendedAt: h.daysAgo(4) }],
      ['con_007', smm, 100, 4, 'expired', { expiresAt: h.daysAgo(5) }],
      ['con_008', smm, 3, 1, 'active'], // recent: drip lessons still locked
      ['con_009', smm, 50, 2, 'revoked', { revokedReason: 'Refund issued', revokedAt: h.daysAgo(20) }],
      ['con_001', fun, 25, 1, 'active'],
      ['con_010', smm, 12, 2, 'active', { expiresAt: h.daysFromNow(80) }],
      ['con_011', smm, 35, 5, 'active'],
      ['con_012', smm, 8, 3, 'active'],
      ['con_020', smm, 40, 4, 'active'],
    ];
    for (const [contactId, c, ago, n, status, extra = {}] of rows) {
      if (!c || !ctx.find('contacts', contactId)) continue;
      const enrolledAt = h.daysAgo(ago);
      const completedLessons = courseLessons(ctx, c.id).slice(0, n).map(({ lesson: l }, i) => ({
        lessonId: l.id,
        completedAt: addDays(enrolledAt, Math.max(i + 1, l.release?.daysAfterEnrollment || 0) + 0.1),
        score: l.completion.criteria === 'quiz_pass' ? 85 : null,
        percentWatched: l.completion.criteria === 'video_percent' ? 95 : null,
      }));
      const full = completedLessons.length && completedLessons.length === courseLessons(ctx, c.id).length;
      const { cert, ...rest } = extra;
      const rec = ctx.insert('enrollments', {
        contactId, courseId: c.id, status, enrolledAt, expiresAt: null, completedLessons,
        completedAt: full ? completedLessons.at(-1).completedAt : null, certificateId: null, createdAt: enrolledAt, ...rest,
      });
      if (cert && full) {
        const crt = ctx.insert('certificates', {
          enrollmentId: rec.id, contactId, courseId: c.id, number: `CERT-2026-${String(ctx.all('certificates').length + 1).padStart(4, '0')}`,
          issuedAt: rec.completedAt, status: 'issued', createdAt: rec.completedAt,
        });
        rec.certificateId = crt.id;
      }
    }
  },
});
