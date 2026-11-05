import { defineModule, ops, z, id, entity, isoDate, fail } from '../kit.js';

const TYPES = ['video', 'text', 'quiz', 'audio', 'download'];
const MODES = ['immediate', 'date', 'drip'];
const CRITERIA = ['view', 'quiz_pass', 'video_percent'];
const lesson = entity({
  courseId: z.string(), sectionId: z.string(), title: z.string(), type: z.enum(TYPES), content: z.string().nullable().optional(),
  durationMin: z.number().nullable().optional(), status: z.enum(['draft', 'published']),
  media: z.looseObject({ mediaId: z.string().nullable(), url: z.string().nullable() }).nullable().optional(),
  release: z.looseObject({ mode: z.enum(MODES), releaseAt: z.string().nullable().optional(), daysAfterEnrollment: z.number().nullable().optional() }),
  completion: z.looseObject({ criteria: z.enum(CRITERIA), passingScore: z.number().nullable().optional(), videoPercent: z.number().nullable().optional() }),
});
const IMMEDIATE = { mode: 'immediate', releaseAt: null, daysAfterEnrollment: null };
const VIEW = { criteria: 'view', passingScore: null, videoPercent: null };

const editableCourse = (ctx, cid) => {
  const c = ctx.get('courses', cid, 'course');
  if (c.status === 'archived') fail('INVALID_STATE', `course ${c.id} (${c.title}) is archived; its lessons can no longer be changed`);
  return c;
};
const sectionList = (c) => c.sections.map((s) => `${s.id} '${s.title}'`).join(', ') || 'none (add one with courses.add_course_section)';
const getLesson = (ctx, lid) => ctx.get('lessons', lid, 'lesson');

export default defineModule({
  id: 'lessons',
  code: 'M41',
  name: 'Lessons',
  description: 'Manage lesson content and completion conditions.',
  tables: { lessons: { prefix: 'les', schema: lesson } },
  actions: [
    {
      id: 'create_lesson', name: 'Create lesson',
      description: 'Add a new draft lesson to a section of a course (appended at the end of the section).',
      keywords: ['add lesson', 'new lesson', 'add video to course'],
      risk: 'write',
      input: z.object({
        courseId: id('course'), sectionId: id('course section (csec_###)'), title: z.string().min(1),
        type: z.enum(TYPES).default('video'), content: z.string().optional().describe('lesson body text, transcript or instructions'),
        durationMin: z.number().int().positive().optional(),
      }),
      output: lesson,
      handler: (i, ctx) => {
        const c = editableCourse(ctx, i.courseId);
        const s = c.sections.find((x) => x.id === i.sectionId);
        if (!s) fail('NOT_FOUND', `section ${i.sectionId} is not in course ${c.id} (${c.title}); its sections: ${sectionList(c)}`);
        const l = ctx.insert('lessons', {
          ...i, content: i.content ?? null, durationMin: i.durationMin ?? null, status: 'draft', media: null,
          release: { ...IMMEDIATE }, completion: { ...VIEW }, publishedAt: null,
        });
        s.lessonIds.push(l.id);
        ctx.patch(c, {});
        return l;
      },
      example: (ctx) => {
        const c = ctx.all('courses')[0];
        return { courseId: c.id, sectionId: c.sections.at(-1).id, title: 'Measuring Social Media ROI', type: 'video', content: 'Track reach, engagement and conversions.', durationMin: 12 };
      },
    },
    {
      id: 'get_lesson', name: 'Get lesson details',
      description: 'Fetch one lesson with its content, media, release (drip) schedule, completion criteria and its course/section titles.',
      risk: 'read',
      input: z.object({ id: id('lesson') }),
      output: lesson,
      handler: ({ id: lid }, ctx) => {
        const l = getLesson(ctx, lid);
        const c = ctx.find('courses', l.courseId);
        return { ...l, courseTitle: c?.title, sectionTitle: c?.sections.find((s) => s.id === l.sectionId)?.title };
      },
      example: (ctx) => ({ id: ctx.all('lessons')[0].id }),
    },
    {
      id: 'search_lessons', name: 'Search lessons',
      description: 'Find lessons by title/content text, course, section, type, or publish status.',
      keywords: ['list lessons', 'find lesson'],
      ...ops.search('lessons', {
        text: ['title', 'content'],
        filters: {
          courseId: z.string().optional(), sectionId: z.string().optional(),
          type: z.enum(TYPES).optional(), status: z.enum(['draft', 'published']).optional(),
        },
      }),
      example: (ctx) => ({ courseId: ctx.all('courses')[0].id }),
    },
    {
      id: 'update_lesson', name: 'Update lesson content', description: 'Change a lesson\'s title, body content, type, or duration.',
      keywords: ['edit lesson', 'change lesson text'],
      ...ops.update('lessons', {
        what: 'lesson',
        fields: { title: z.string().min(1), content: z.string(), type: z.enum(TYPES), durationMin: z.number().int().positive() },
        guard: (l, i, ctx) => {
          editableCourse(ctx, l.courseId);
          const need = { quiz_pass: 'quiz', video_percent: 'video' }[l.completion?.criteria];
          if (i.type && need && i.type !== need)
            fail('INVALID_STATE', `lesson ${l.id} completes on ${l.completion.criteria}, which needs a ${need} lesson; set its completion criteria to view (set_lesson_completion_criteria) before changing the type to ${i.type}`);
          if (l.status === 'published' && i.content === '' && !l.media)
            fail('INVALID_STATE', `lesson ${l.id} is published and has no media; it cannot have empty content (unpublish it first or attach media)`);
        },
      }),
      example: (ctx) => ({ id: ctx.all('lessons')[1].id, content: 'Compare Instagram, Facebook, TikTok and LinkedIn by audience and format.' }),
    },
    {
      id: 'attach_lesson_media', name: 'Attach lesson media',
      description: 'Attach a video/audio/file to a lesson, either a Media library file (mediaId) or an external URL. Replaces any existing media.',
      keywords: ['upload video', 'add video', 'lesson attachment'],
      risk: 'write',
      input: z.object({
        id: id('lesson'),
        mediaId: z.string().optional().describe('file ID from the Media library (med_###)'),
        url: z.url().optional().describe('external URL (e.g. Vimeo/YouTube) when not using the Media library'),
      }),
      output: lesson,
      handler: ({ id: lid, mediaId, url }, ctx) => {
        if (!mediaId === !url) fail('VALIDATION', 'provide exactly one of mediaId or url');
        const l = getLesson(ctx, lid);
        editableCourse(ctx, l.courseId);
        let media = { mediaId: null, url, name: null };
        if (mediaId) {
          const m = ctx.get('media', mediaId, 'media file');
          if (['archived', 'deleted', 'trashed'].includes(m.status)) fail('INVALID_STATE', `media file ${mediaId} is ${m.status}; restore it or pick another file`);
          media = { mediaId, url: m.url ?? null, name: m.name ?? null };
        }
        return ctx.patch(l, { media: { ...media, attachedAt: ctx.now } });
      },
      example: (ctx) => ({ id: ctx.all('lessons')[1].id, url: 'https://videos.example.com/smm101/platforms.mp4' }),
    },
    {
      id: 'move_lesson', name: 'Move lesson to course section',
      description: 'Move a lesson to another section of the same course (or a new position within its section). Cannot move across courses.',
      keywords: ['reorder lesson', 'relocate lesson'],
      risk: 'write',
      input: z.object({
        id: id('lesson'), sectionId: id('target section in the same course'),
        position: z.number().int().min(0).optional().describe('0-based index in the target section; default = end'),
      }),
      output: lesson,
      handler: ({ id: lid, sectionId, position }, ctx) => {
        const l = getLesson(ctx, lid);
        const c = editableCourse(ctx, l.courseId);
        const to = c.sections.find((s) => s.id === sectionId);
        if (!to) {
          const other = ctx.all('courses').find((x) => x.sections.some((s) => s.id === sectionId));
          if (other) fail('VALIDATION', `section ${sectionId} belongs to another course (${other.id} ${other.title}); lessons can only move within course ${c.id}. Its sections: ${sectionList(c)}`);
          fail('NOT_FOUND', `section ${sectionId} not found in course ${c.id}; its sections: ${sectionList(c)}`);
        }
        const from = c.sections.find((s) => s.lessonIds.includes(lid));
        if (from === to && position === undefined) fail('VALIDATION', `lesson ${lid} is already in section '${to.title}'; pass position to reorder it within the section`);
        if (from) from.lessonIds = from.lessonIds.filter((x) => x !== lid);
        to.lessonIds.splice(Math.min(position ?? to.lessonIds.length, to.lessonIds.length), 0, lid);
        ctx.patch(c, {});
        ctx.patch(l, { sectionId: to.id });
        return { ...l, fromSectionId: from?.id ?? null };
      },
      example: (ctx) => {
        const c = ctx.all('courses')[0];
        return { id: c.sections[0].lessonIds.at(-1), sectionId: c.sections[1].id, position: 0 };
      },
    },
    {
      id: 'set_lesson_release_schedule', name: 'Set lesson release schedule',
      description: 'Drip-schedule a lesson: immediate (on enrollment), a fixed release date, or N days after each learner enrolls.',
      keywords: ['drip', 'drip content', 'unlock lesson', 'schedule lesson'],
      risk: 'write',
      input: z.object({
        id: id('lesson'),
        mode: z.enum(MODES).describe('immediate | date (fixed releaseAt) | drip (daysAfterEnrollment)'),
        releaseAt: isoDate().optional().describe('required when mode=date'),
        daysAfterEnrollment: z.number().int().min(0).max(365).optional().describe('required when mode=drip'),
      }),
      output: lesson,
      handler: ({ id: lid, mode, releaseAt, daysAfterEnrollment }, ctx) => {
        const l = getLesson(ctx, lid);
        editableCourse(ctx, l.courseId);
        if (mode === 'date' && !releaseAt) fail('VALIDATION', 'mode "date" requires releaseAt');
        if (mode === 'drip' && daysAfterEnrollment == null) fail('VALIDATION', 'mode "drip" requires daysAfterEnrollment');
        return ctx.patch(l, {
          release: { mode, releaseAt: mode === 'date' ? releaseAt : null, daysAfterEnrollment: mode === 'drip' ? daysAfterEnrollment : null },
        });
      },
      example: (ctx) => ({ id: ctx.all('lessons')[2].id, mode: 'drip', daysAfterEnrollment: 3 }),
    },
    {
      id: 'set_lesson_completion_criteria', name: 'Set lesson completion criteria',
      description: 'Define when a learner counts as having completed a lesson: view it, pass its quiz (passingScore %), or watch a minimum % of its video.',
      keywords: ['passing score', 'quiz pass mark', 'watch percentage'],
      risk: 'write',
      input: z.object({
        id: id('lesson'), criteria: z.enum(CRITERIA),
        passingScore: z.number().min(1).max(100).optional().describe('required for quiz_pass: minimum score %'),
        videoPercent: z.number().int().min(1).max(100).optional().describe('required for video_percent: minimum % watched'),
      }),
      output: lesson,
      handler: ({ id: lid, criteria, passingScore, videoPercent }, ctx) => {
        const l = getLesson(ctx, lid);
        editableCourse(ctx, l.courseId);
        if (criteria === 'quiz_pass') {
          if (passingScore == null) fail('VALIDATION', 'criteria quiz_pass requires passingScore (1-100)');
          if (l.type !== 'quiz') fail('INVALID_STATE', `lesson ${lid} is type '${l.type}'; quiz_pass needs a quiz lesson (change type with update_lesson)`);
        }
        if (criteria === 'video_percent') {
          if (videoPercent == null) fail('VALIDATION', 'criteria video_percent requires videoPercent (1-100)');
          if (l.type !== 'video') fail('INVALID_STATE', `lesson ${lid} is type '${l.type}'; video_percent needs a video lesson`);
        }
        return ctx.patch(l, {
          completion: { criteria, passingScore: criteria === 'quiz_pass' ? passingScore : null, videoPercent: criteria === 'video_percent' ? videoPercent : null },
        });
      },
      example: (ctx) => ({ id: ctx.all('lessons').find((l) => l.type === 'video' && l.completion.criteria === 'view').id, criteria: 'video_percent', videoPercent: 75 }),
    },
    {
      id: 'publish_lesson', name: 'Publish lesson',
      description: 'Make a draft lesson visible to enrolled learners. It needs content or attached media.',
      ...ops.transition('lessons', {
        to: 'published', from: ['draft'], risk: 'external', what: 'lesson',
        guard: (l, i, ctx) => {
          editableCourse(ctx, l.courseId);
          if (!l.content && !l.media)
            fail('INVALID_STATE', `lesson ${l.id} (${l.title}) has no content or media; add it with update_lesson or attach_lesson_media first`);
        },
        extra: (l, i, ctx) => ({ publishedAt: ctx.now }),
      }),
      example: (ctx) => ({
        id: ctx.all('lessons').find((l) => l.status === 'draft' && (l.content || l.media) && ctx.find('courses', l.courseId)?.status !== 'archived').id,
      }),
    },
    {
      id: 'unpublish_lesson', name: 'Unpublish lesson',
      description: 'Hide a published lesson from learners (back to draft). Refused if it is the last published lesson of a published course.',
      keywords: ['hide lesson', 'take down lesson'],
      ...ops.transition('lessons', {
        to: 'draft', from: ['published'], risk: 'external', what: 'lesson',
        guard: (l, i, ctx) => {
          const c = editableCourse(ctx, l.courseId);
          const others = c.sections.flatMap((s) => s.lessonIds).filter((x) => x !== l.id && ctx.find('lessons', x)?.status === 'published');
          if (c.status === 'published' && !others.length)
            fail('CONFLICT', `lesson ${l.id} is the only published lesson in published course ${c.id} (${c.title}); publish another lesson or archive the course first`);
        },
        extra: () => ({ publishedAt: null }),
      }),
      example: (ctx) => ({ id: ctx.all('lessons').find((l) => l.status === 'published').id }),
    },
  ],

  // Runs after the courses seed: creates lessons and fills each course section's lessonIds.
  seed(ctx, h) {
    const drip = (d) => ({ mode: 'drip', releaseAt: null, daysAfterEnrollment: d });
    const vid = (slug) => ({ mediaId: null, url: `https://videos.example.com/${slug}.mp4`, name: null });
    const plan = {
      'Social Media Marketing 101': [
        [0, 'Welcome to Social Media Marketing', 'video', 6, 'published', { media: vid('smm101/welcome') }],
        [0, 'Choosing the Right Platforms', 'text', 12, 'published'],
        [0, 'Setting Up Business Profiles', 'video', 15, 'published', { media: vid('smm101/profiles') }],
        [1, 'Planning a Content Calendar', 'text', 10, 'published', { release: drip(7) }],
        [1, 'Creating Engaging Posts', 'video', 18, 'published', { release: drip(14), media: vid('smm101/posts'), completion: { criteria: 'video_percent', passingScore: null, videoPercent: 80 } }],
        [1, 'Content Strategy Quiz', 'quiz', 10, 'published', { release: drip(14), completion: { criteria: 'quiz_pass', passingScore: 70, videoPercent: null } }],
        [1, 'Bonus: Live Q&A Replay', 'video', 45, 'draft', { content: null, release: { mode: 'date', releaseAt: '2026-11-20T17:00:00.000Z', daysAfterEnrollment: null } }],
      ],
      'Advanced Funnel Building': [
        [0, 'Anatomy of a High-Converting Funnel', 'video', 20, 'published', { media: vid('funnels/anatomy') }],
        [0, 'Writing Opt-in Page Copy', 'text', 15, 'published'],
        [1, 'A/B Testing Your Funnel', 'video', 22, 'published', { release: drip(7), media: vid('funnels/ab-testing') }],
        [1, 'Funnel Metrics Deep Dive', 'video', 25, 'draft'],
      ],
      'Instagram Reels for Business': [
        [0, 'Reels Fundamentals', 'video', 8, 'published'],
        [0, 'Editing Reels on Your Phone', 'video', 14, 'draft'],
      ],
      'Facebook Ads Mastery': [[0, 'Navigating Ads Manager', 'video', 16, 'draft']],
      'Local SEO Bootcamp (2024 edition)': [[0, 'Optimizing Your Google Business Profile', 'video', 20, 'published']],
    };
    for (const [title, rows] of Object.entries(plan)) {
      const c = ctx.all('courses').find((x) => x.title === title);
      if (!c) continue;
      for (const [si, lt, type, durationMin, status, extra = {}] of rows) {
        const s = c.sections[si];
        const l = ctx.insert('lessons', {
          courseId: c.id, sectionId: s.id, title: lt, type, content: `${lt}: key ideas, walkthrough and action steps.`, durationMin, status,
          media: null, release: { ...IMMEDIATE }, completion: { ...VIEW }, publishedAt: status === 'published' ? c.publishedAt || h.daysAgo(100) : null,
          createdAt: h.daysAgo(h.int(100, 150)), ...extra,
        });
        s.lessonIds.push(l.id);
      }
    }
  },
});
