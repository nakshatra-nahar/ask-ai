import { defineModule, ops, z, id, entity, fail, toTime } from '../kit.js';

const STATUSES = ['draft', 'published', 'archived'];
const section = z.looseObject({ id: z.string(), title: z.string(), lessonIds: z.array(z.string()) });
const course = entity({
  title: z.string(), description: z.string().nullable().optional(), status: z.enum(STATUSES),
  instructorId: z.string().nullable().optional(), sections: z.array(section), prerequisiteIds: z.array(z.string()),
});

const notArchived = (c) => {
  if (c.status === 'archived') fail('INVALID_STATE', `course ${c.id} (${c.title}) is archived and can no longer be changed`);
};
const activeUser = (ctx, uid) => {
  const u = ctx.get('users', uid, 'user');
  if (u.status !== 'active') fail('INVALID_STATE', `user ${uid} (${u.name}) is ${u.status}; instructors must be active users`);
  return u;
};
function uniqueTitle(ctx, title, selfId) {
  const dup = ctx.all('courses').find((c) => c.id !== selfId && c.status !== 'archived' && c.title.toLowerCase() === title.toLowerCase());
  if (dup) fail('DUPLICATE', `a course titled '${title}' already exists (${dup.id}, ${dup.status})`, { existingId: dup.id });
}
const hasPublishedLesson = (ctx, c) => c.sections.some((s) => s.lessonIds.some((l) => ctx.find('lessons', l)?.status === 'published'));
const activeEnrollments = (ctx, cid) =>
  ctx.all('enrollments').filter((e) => e.courseId === cid && e.status === 'active' && !(e.expiresAt && toTime(e.expiresAt, true) < toTime(ctx.now)));
// true if `target` is reachable from course `start` by following prerequisiteIds
function reaches(ctx, start, target, seen = new Set()) {
  if (start === target) return true;
  if (seen.has(start)) return false;
  seen.add(start);
  return (ctx.find('courses', start)?.prerequisiteIds || []).some((p) => reaches(ctx, p, target, seen));
}

export default defineModule({
  id: 'courses',
  code: 'M40',
  name: 'Courses',
  description: 'Configure learning programs and their structure.',
  tables: { courses: { prefix: 'crs', schema: course } },
  actions: [
    {
      id: 'create_course', name: 'Create course',
      description: 'Create a new online course (learning program) as a draft. Add sections and lessons, then publish it. Not for membership plans or communities.',
      keywords: ['new course', 'new program', 'build a course', 'course builder'],
      ...ops.create('courses', {
        input: z.object({
          title: z.string().min(1), description: z.string().optional(),
          instructorId: z.string().optional().describe('active user who teaches the course'),
        }),
        check: (i, ctx) => {
          uniqueTitle(ctx, i.title);
          if (i.instructorId) activeUser(ctx, i.instructorId);
        },
        build: (i) => ({ description: i.description ?? null, instructorId: i.instructorId ?? null, status: 'draft', sections: [], prerequisiteIds: [], publishedAt: null }),
      }),
      example: () => ({ title: 'Email Marketing Essentials', description: 'Build and grow an email list that converts.', instructorId: 'usr_008' }),
    },
    {
      id: 'get_course', name: 'Get course details',
      description: 'Fetch one course with its ordered sections, lesson titles and publish status, prerequisites, instructor and active enrollment count.',
      keywords: ['course outline', 'curriculum', 'syllabus'],
      risk: 'read',
      input: z.object({ id: id('course') }),
      output: course,
      handler: ({ id: cid }, ctx) => {
        const c = ctx.get('courses', cid, 'course');
        return {
          ...c,
          instructor: c.instructorId ? { id: c.instructorId, name: ctx.find('users', c.instructorId)?.name } : null,
          prerequisites: c.prerequisiteIds.map((p) => ({ id: p, title: ctx.find('courses', p)?.title })),
          sections: c.sections.map((s) => ({
            ...s,
            lessons: s.lessonIds.map((l) => {
              const x = ctx.find('lessons', l);
              return { id: l, title: x?.title, status: x?.status };
            }),
          })),
          activeEnrollments: activeEnrollments(ctx, cid).length,
        };
      },
      example: (ctx) => ({ id: ctx.all('courses')[0].id }),
    },
    {
      id: 'search_courses', name: 'Search courses',
      description: 'Find courses by title/description text, status, or instructor. Archived courses excluded unless status is given.',
      keywords: ['list courses', 'find course', 'course catalog'],
      ...ops.search('courses', {
        text: ['title', 'description'],
        filters: { status: z.enum(STATUSES).optional(), instructorId: z.string().optional() },
        where: (r, i) => i.status || r.status !== 'archived',
      }),
      example: () => ({ query: 'marketing' }),
    },
    {
      id: 'update_course', name: 'Update course details', description: 'Change the title or description of a course (not archived).',
      ...ops.update('courses', {
        what: 'course',
        fields: { title: z.string().min(1), description: z.string() },
        guard: (c, i, ctx) => {
          notArchived(c);
          if (i.title) uniqueTitle(ctx, i.title, c.id);
        },
      }),
      example: (ctx) => ({ id: ctx.all('courses')[0].id, description: 'Grow your brand on Instagram, Facebook, TikTok and LinkedIn.' }),
    },
    {
      id: 'add_course_section', name: 'Add course section',
      description: 'Append a new (empty) section/module to a course outline. Lessons are added to sections via the Lessons module.',
      keywords: ['add module', 'new chapter'],
      risk: 'write',
      input: z.object({ id: id('course'), title: z.string().min(1).describe('section title, e.g. "Paid Social Advertising"') }),
      output: course,
      handler: ({ id: cid, title }, ctx) => {
        const c = ctx.get('courses', cid, 'course');
        notArchived(c);
        const dup = c.sections.find((s) => s.title.toLowerCase() === title.toLowerCase());
        if (dup) fail('DUPLICATE', `course ${c.title} already has a section '${dup.title}' (${dup.id})`, { existingId: dup.id });
        const added = { id: ctx.newId('csec'), title, lessonIds: [] };
        ctx.patch(c, { sections: [...c.sections, added] });
        return { ...c, added };
      },
      example: (ctx) => ({ id: ctx.all('courses')[0].id, title: 'Paid Social Advertising' }),
    },
    {
      id: 'reorder_course_sections', name: 'Reorder course sections',
      description: 'Change the order of sections in a course. Pass every section ID of the course in the new order.',
      ...(() => {
        const base = ops.reorder('courses', 'sections', { what: 'course' });
        return { ...base, handler: (inp, ctx) => (notArchived(ctx.get('courses', inp.id, 'course')), base.handler(inp, ctx)) };
      })(),
      example: (ctx) => {
        const c = ctx.all('courses')[0];
        return { id: c.id, orderedIds: c.sections.map((s) => s.id).reverse() };
      },
    },
    {
      id: 'assign_course_instructor', name: 'Assign course instructor', description: 'Set the user who teaches a course. Must be an active user.',
      keywords: ['course teacher', 'course owner', 'coach'],
      ...ops.set('courses', 'instructorId', id('user'), {
        param: 'userId', what: 'course',
        guard: (c, i, ctx) => {
          notArchived(c);
          activeUser(ctx, i.userId);
        },
      }),
      example: (ctx) => ({ id: ctx.all('courses')[0].id, userId: 'usr_003' }),
    },
    {
      id: 'set_course_prerequisites', name: 'Set course prerequisites',
      description: 'Replace the list of courses a learner must complete before enrolling in this course. Pass [] to clear. Rejects self-references and cycles.',
      keywords: ['required course', 'course requirements'],
      risk: 'write',
      input: z.object({ id: id('course'), prerequisiteIds: z.array(z.string()).describe('course IDs that must be completed first; [] clears all') }),
      output: course,
      handler: ({ id: cid, prerequisiteIds }, ctx) => {
        const c = ctx.get('courses', cid, 'course');
        notArchived(c);
        const ids = [...new Set(prerequisiteIds)];
        if (ids.includes(cid)) fail('VALIDATION', `course ${cid} cannot be its own prerequisite`);
        for (const p of ids) {
          const pc = ctx.get('courses', p, 'prerequisite course');
          if (pc.status === 'archived') fail('INVALID_STATE', `prerequisite ${p} (${pc.title}) is archived; pick an active course`);
          if (reaches(ctx, p, cid))
            fail('CONFLICT', `${p} (${pc.title}) already requires ${c.title} directly or indirectly; adding it would create a prerequisite cycle`);
        }
        return ctx.patch(c, { prerequisiteIds: ids });
      },
      example: (ctx) => {
        const target = ctx.all('courses').find((c) => c.status === 'draft' && !c.prerequisiteIds.length);
        return { id: target.id, prerequisiteIds: [ctx.all('courses')[0].id] };
      },
    },
    {
      id: 'publish_course', name: 'Publish course',
      description: 'Make a draft course live so learners can be enrolled. Requires at least one section containing a published lesson.',
      keywords: ['launch course', 'go live', 'make course available'],
      ...ops.transition('courses', {
        to: 'published', from: ['draft'], risk: 'external', what: 'course',
        guard: (c, i, ctx) => {
          if (!hasPublishedLesson(ctx, c))
            fail('INVALID_STATE', `course ${c.id} (${c.title}) has no section containing a published lesson; publish a lesson (lessons.publish_lesson) first`);
        },
        extra: (c, i, ctx) => ({ publishedAt: ctx.now }),
      }),
      example: (ctx) => ({ id: ctx.all('courses').find((c) => c.status === 'draft' && hasPublishedLesson(ctx, c)).id }),
    },
    {
      id: 'archive_course', name: 'Archive course',
      description: 'Archive (retire) a course so it can no longer be edited or enrolled in. Fails if learners are actively enrolled unless force is true.',
      keywords: ['delete course', 'retire course', 'remove course'],
      risk: 'destructive',
      input: z.object({ id: id('course'), force: z.boolean().default(false).describe('archive even if learners are actively enrolled') }),
      output: course,
      handler: ({ id: cid, force }, ctx) => {
        const c = ctx.get('courses', cid, 'course');
        if (c.status === 'archived') fail('INVALID_STATE', `course ${cid} (${c.title}) is already archived`);
        const n = activeEnrollments(ctx, cid).length;
        if (n && !force)
          fail('CONFLICT', `course ${cid} (${c.title}) has ${n} active enrollment(s). Suspend/revoke them first, or retry with force:true to archive anyway`, { activeEnrollments: n });
        ctx.patch(c, { status: 'archived', archivedAt: ctx.now });
        return { ...c, activeEnrollmentsAtArchive: n };
      },
      example: (ctx) => ({ id: ctx.all('courses').find((c) => c.status !== 'archived' && !activeEnrollments(ctx, c.id).length).id }),
    },
  ],

  // Lessons are created by the lessons seed (M41), which also fills each section's lessonIds.
  seed(ctx, h) {
    const mk = (title, description, status, instructorId, sections, extra = {}) =>
      ctx.insert('courses', {
        title, description, status, instructorId, prerequisiteIds: [],
        sections: sections.map((t) => ({ id: ctx.newId('csec'), title: t, lessonIds: [] })),
        publishedAt: status === 'draft' ? null : h.daysAgo(h.int(100, 140)),
        createdAt: h.daysAgo(h.int(150, 200)), ...extra,
      });
    const smm = mk('Social Media Marketing 101', 'Foundations of growing a business on social media: platforms, profiles and content strategy.', 'published', 'usr_008', ['Getting Started', 'Content Strategy']);
    mk('Advanced Funnel Building', 'Design, launch and optimize high-converting sales funnels.', 'published', 'usr_001', ['Funnel Foundations', 'Conversion Optimization'], { prerequisiteIds: [smm.id] });
    mk('Instagram Reels for Business', 'Short-form video that drives reach and leads.', 'draft', 'usr_008', ['Reels Basics']);
    mk('Facebook Ads Mastery', 'Plan, target and scale profitable Facebook ad campaigns.', 'draft', null, ['Campaign Setup', 'Audiences & Targeting']);
    mk('Local SEO Bootcamp (2024 edition)', 'Rank in the local map pack. Superseded by newer material.', 'archived', 'usr_008', ['Google Business Profile'], { archivedAt: h.daysAgo(40) });
  },
});
