import { defineModule, ops, z, id, entity, fail } from '../kit.js';

const Q_TYPES = ['nps', 'rating', 'multiple_choice', 'yes_no', 'text'];
const BR_OPS = ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'in'];
const ns = z.string().nullable().optional();
const question = z.looseObject({ id: z.string(), text: z.string(), type: z.enum(Q_TYPES), required: z.boolean(), branching: z.array(z.looseObject({ goTo: z.string() })).optional() });
const survey = entity({
  name: z.string(), description: ns, status: z.enum(['draft', 'published', 'closed']), questions: z.array(question), responseCount: z.number(), publishedAt: ns, closedAt: ns,
});
const response = entity({
  surveyId: z.string(), contactId: ns, answers: z.array(z.looseObject({ questionId: z.string() })), path: z.array(z.string()), submittedAt: z.string(),
});

const notClosed = (s) => {
  if (s.status === 'closed') fail('INVALID_STATE', `survey ${s.id} '${s.name}' is closed and cannot be edited`);
};
const getQ = (s, qid) => s.questions.find((q) => q.id === qid) || fail('NOT_FOUND', `question ${qid} not in survey ${s.id}; questions: ${s.questions.map((q) => q.id).join(', ')}`);
const norm = (q, a) => (q.type === 'yes_no' && typeof a === 'string' ? { yes: true, no: false }[a.toLowerCase()] ?? a : a);
function answerError(q, a) {
  const max = q.scaleMax || 5;
  if (q.type === 'nps' && !(Number.isInteger(a) && a >= 0 && a <= 10)) return 'NPS answer must be an integer 0-10';
  if (q.type === 'rating' && !(Number.isInteger(a) && a >= 1 && a <= max)) return `rating must be an integer 1-${max}`;
  if (q.type === 'multiple_choice' && !q.options.includes(a)) return `choose one of: ${q.options.join(', ')}`;
  if (q.type === 'yes_no' && typeof a !== 'boolean') return 'answer true/"yes" or false/"no"';
  if (q.type === 'text' && !(typeof a === 'string' && a.trim())) return 'text answer must be a non-empty string';
  return null;
}
const s = (x) => String(x).toLowerCase();
const ruleMatches = (r, a) => ({
  equals: () => s(a) === s(r.value), not_equals: () => s(a) !== s(r.value), gt: () => a > r.value, gte: () => a >= r.value,
  lt: () => a < r.value, lte: () => a <= r.value, in: () => Array.isArray(r.value) && r.value.map(s).includes(s(a)),
})[r.operator]();

/** Walk questions from the first, following the first matching branching rule after each answer. */
function walk(sv, given) {
  const qs = sv.questions;
  const path = [];
  const answers = [];
  const errors = [];
  for (let i = 0; i < qs.length; ) {
    const q = qs[i];
    path.push(q.id);
    const a = norm(q, given[q.id]);
    if (a === undefined || a === null || a === '') {
      if (q.required) errors.push(`${q.id} "${q.text}": required`);
      i++;
      continue;
    }
    const err = answerError(q, a);
    if (err) errors.push(`${q.id} "${q.text}": ${err}`);
    else answers.push({ questionId: q.id, answer: a });
    const rule = !err && (q.branching || []).find((r) => ruleMatches(r, a));
    if (rule?.goTo === 'end') break;
    const j = rule ? qs.findIndex((x) => x.id === rule.goTo) : -1;
    i = j > i ? j : i + 1; // branches only jump forward
  }
  return { path, answers, errors };
}
const round1 = (n) => Math.round(n * 10) / 10;
function summarizeQuestion(q, vals) {
  const base = { questionId: q.id, text: q.text, type: q.type, answered: vals.length };
  const count = (opts) => Object.fromEntries(opts.map((o) => [String(o), vals.filter((v) => v === o).length]));
  const avg = vals.length ? round1(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  if (q.type === 'nps') {
    const p = vals.filter((v) => v >= 9).length, d = vals.filter((v) => v <= 6).length;
    return { ...base, average: avg, promoters: p, passives: vals.length - p - d, detractors: d, npsScore: vals.length ? Math.round(((p - d) / vals.length) * 100) : null };
  }
  if (q.type === 'rating') return { ...base, average: avg, distribution: count([...Array(q.scaleMax || 5)].map((_, k) => k + 1)) };
  if (q.type === 'multiple_choice') return { ...base, counts: count(q.options) };
  if (q.type === 'yes_no') return { ...base, yes: vals.filter((v) => v === true).length, no: vals.filter((v) => v === false).length };
  return { ...base, samples: vals.slice(-3) };
}
const byName = (ctx, n) => ctx.all('surveys').find((x) => x.name === n);

export default defineModule({
  id: 'surveys',
  code: 'M19',
  name: 'Surveys',
  description: 'Run feedback surveys (NPS, ratings, multiple choice) with branching and response analytics.',
  tables: { surveys: { prefix: 'srv', schema: survey }, survey_responses: { prefix: 'sres', schema: response } },
  actions: [
    {
      id: 'create_survey', name: 'Create survey', description: 'Create an empty draft feedback survey (NPS, ratings, multiple choice, yes/no, text). For lead-capture data entry use forms instead.',
      keywords: ['new survey', 'nps survey', 'feedback survey', 'questionnaire'],
      ...ops.create('surveys', {
        input: z.object({ name: z.string().min(1), description: z.string().optional() }),
        check: (i, ctx) => {
          const d = ctx.all('surveys').find((x) => x.name.toLowerCase() === i.name.toLowerCase());
          if (d) fail('DUPLICATE', `survey '${i.name}' already exists (${d.id}, ${d.status})`);
        },
        build: (i) => ({ description: i.description ?? null, status: 'draft', questions: [], responseCount: 0, publishedAt: null, closedAt: null }),
      }),
      example: () => ({ name: 'Event Feedback', description: 'Feedback on the client appreciation evening' }),
    },
    {
      id: 'get_survey', name: 'Get survey definition', description: 'Fetch a survey with its ordered questions, options and branching rules.',
      ...ops.get('surveys', { what: 'survey' }),
      example: (ctx) => ({ id: byName(ctx, 'Customer Satisfaction (NPS)').id }),
    },
    {
      id: 'list_surveys', name: 'List surveys', description: 'List surveys, filterable by status (draft/published/closed) or name text, with response counts.',
      ...ops.search('surveys', { text: ['name', 'description'], filters: { status: z.enum(['draft', 'published', 'closed']).optional() } }),
      example: () => ({ status: 'published' }),
    },
    {
      id: 'add_survey_question', name: 'Add survey question',
      description: 'Append a question (nps 0-10, rating 1-scaleMax, multiple_choice with options, yes_no, text) to a draft or published survey.',
      risk: 'write',
      input: z.object({
        id: id('survey'), text: z.string().min(1), type: z.enum(Q_TYPES), required: z.boolean().default(true),
        options: z.array(z.string()).optional().describe('choices for multiple_choice (2+)'), scaleMax: z.number().int().min(3).max(10).optional().describe('rating scale max, default 5'),
      }),
      output: survey,
      handler: ({ id: sid, ...q }, ctx) => {
        const sv = ctx.get('surveys', sid, 'survey');
        notClosed(sv);
        if (q.type === 'multiple_choice' && !(q.options?.length >= 2)) fail('VALIDATION', 'multiple_choice questions need at least 2 options');
        const added = { id: ctx.newId('srq'), ...q, ...(q.type === 'rating' ? { scaleMax: q.scaleMax ?? 5 } : {}), branching: [] };
        sv.questions.push(added);
        ctx.patch(sv, {});
        return { ...sv, added };
      },
      example: (ctx) => ({ id: byName(ctx, 'Onboarding Experience').id, text: 'How likely are you to recommend us?', type: 'nps' }),
    },
    {
      id: 'update_survey_question', name: 'Update survey question', description: 'Change a question\'s text, required flag, options or rating scale (type is fixed).',
      ...ops.updateItem('surveys', 'questions', { text: z.string().min(1), required: z.boolean(), options: z.array(z.string()).min(2), scaleMax: z.number().int().min(3).max(10) }, { itemParam: 'questionId', what: 'survey', guard: notClosed }),
      example: (ctx) => {
        const sv = byName(ctx, 'Onboarding Experience');
        return { id: sv.id, questionId: sv.questions[0].id, text: 'Overall, how smooth was your onboarding?' };
      },
    },
    {
      id: 'set_question_branching', name: 'Set question branching rules',
      description: 'Replace the skip-logic rules of a question: after it is answered, the first matching rule (operator/value) jumps to a LATER question id or "end"; no match = next question. Text questions cannot branch.',
      keywords: ['skip logic', 'conditional question', 'survey logic'],
      risk: 'write',
      input: z.object({
        id: id('survey'), questionId: id('question'),
        rules: z.array(z.object({ operator: z.enum(BR_OPS), value: z.any().describe('compared to the answer; array for "in"'), goTo: z.string().min(1).describe('later question id, or "end"') })),
      }),
      output: survey,
      handler: ({ id: sid, questionId, rules }, ctx) => {
        const sv = ctx.get('surveys', sid, 'survey');
        notClosed(sv);
        const q = getQ(sv, questionId);
        if (q.type === 'text' && rules.length) fail('VALIDATION', 'text questions cannot have branching rules');
        const idx = sv.questions.indexOf(q);
        const later = sv.questions.slice(idx + 1).map((x) => x.id);
        for (const r of rules) {
          if (r.goTo !== 'end' && !later.includes(r.goTo)) fail('VALIDATION', `goTo '${r.goTo}' must be "end" or a later question: ${later.join(', ') || '(none — use "end")'}`);
          if (r.operator === 'in' ? !Array.isArray(r.value) : r.value === undefined) fail('VALIDATION', `rule ${r.operator} needs a value${r.operator === 'in' ? ' array' : ''}`);
          if (['gt', 'gte', 'lt', 'lte'].includes(r.operator) && !['nps', 'rating'].includes(q.type)) fail('VALIDATION', `${r.operator} only applies to nps/rating questions; use equals/in`);
        }
        // yes_no answers are stored as booleans, so "yes"/"no" rule values must be too or they never match.
        const nv = (v) => (Array.isArray(v) ? v.map((x) => norm(q, x)) : norm(q, v));
        q.branching = rules.map((r) => ({ ...r, value: nv(r.value) }));
        return ctx.patch(sv, {});
      },
      example: (ctx) => {
        const sv = byName(ctx, 'Onboarding Experience');
        return { id: sv.id, questionId: sv.questions[0].id, rules: [{ operator: 'gte', value: 4, goTo: 'end' }] };
      },
    },
    {
      id: 'publish_survey', name: 'Publish survey', description: 'Open a draft survey for responses (shareable link). Needs at least one question.',
      keywords: ['launch survey', 'send survey link'],
      risk: 'external',
      input: z.object({ id: id('survey') }),
      output: survey,
      handler: ({ id: sid }, ctx) => {
        const sv = ctx.get('surveys', sid, 'survey');
        if (sv.status !== 'draft') fail('INVALID_STATE', `survey ${sv.id} '${sv.name}' is ${sv.status}; only drafts can be published`);
        if (!sv.questions.length) fail('VALIDATION', `survey '${sv.name}' has no questions; add_survey_question first`);
        return ctx.patch(sv, { status: 'published', publishedAt: ctx.now, url: `https://surveys.acme.test/${sv.id}` });
      },
      example: (ctx) => ({ id: byName(ctx, 'Onboarding Experience').id }),
    },
    {
      id: 'close_survey', name: 'Close survey', description: 'Stop accepting responses on a published survey (results stay available).',
      keywords: ['end survey', 'stop survey'],
      ...ops.transition('surveys', { to: 'closed', from: ['published'], what: 'survey', extra: (r, i, ctx) => ({ closedAt: ctx.now }) }),
      example: (ctx) => ({ id: byName(ctx, 'Post-Appointment Feedback').id }),
    },
    {
      id: 'submit_survey_response', name: 'Submit simulated survey response',
      description: 'Simulate a respondent answering a published survey: answers keyed by question id are validated per type, branching is followed (answers to skipped questions are ignored), and the response is stored.',
      keywords: ['answer survey', 'test survey'],
      risk: 'write',
      input: z.object({ id: id('survey'), contactId: z.string().optional(), answers: z.record(z.string(), z.any()).describe('question id -> answer, e.g. {"srq_001": 9}') }),
      output: z.looseObject({ response, skippedQuestionIds: z.array(z.string()) }),
      handler: ({ id: sid, contactId, answers }, ctx) => {
        const sv = ctx.get('surveys', sid, 'survey');
        if (sv.status !== 'published') fail('INVALID_STATE', `survey ${sv.id} '${sv.name}' is ${sv.status}; only published surveys accept responses`);
        if (contactId) ctx.get('contacts', contactId, 'contact');
        const unknown = Object.keys(answers).filter((k) => !sv.questions.some((q) => q.id === k));
        if (unknown.length) fail('VALIDATION', `unknown question ids ${unknown.join(', ')}; questions: ${sv.questions.map((q) => `${q.id} (${q.type})`).join(', ')}`);
        const w = walk(sv, answers);
        if (w.errors.length) fail('VALIDATION', `response rejected: ${w.errors.join('; ')}`, { errors: w.errors });
        const r = ctx.insert('survey_responses', { surveyId: sv.id, contactId: contactId ?? null, answers: w.answers, path: w.path, submittedAt: ctx.now });
        ctx.patch(sv, { responseCount: sv.responseCount + 1 });
        return { response: r, skippedQuestionIds: Object.keys(answers).filter((k) => !w.path.includes(k)) };
      },
      example: (ctx) => {
        const q = byName(ctx, 'Customer Satisfaction (NPS)').questions.map((x) => x.id);
        return { id: byName(ctx, 'Customer Satisfaction (NPS)').id, contactId: 'con_001', answers: { [q[0]]: 10, [q[2]]: true, [q[3]]: 'Weekday mornings' } };
      },
    },
    {
      id: 'get_survey_response_summary', name: 'Get survey response summary',
      description: 'Aggregate results of a survey: response count and per-question stats (NPS score with promoters/passives/detractors, rating averages and distribution, choice counts, yes/no counts, recent text answers).',
      keywords: ['nps score', 'survey results', 'feedback results'],
      risk: 'read',
      input: z.object({ id: id('survey') }),
      output: z.looseObject({ surveyId: z.string(), responseCount: z.number(), questions: z.array(z.looseObject({ questionId: z.string() })) }),
      handler: ({ id: sid }, ctx) => {
        const sv = ctx.get('surveys', sid, 'survey');
        const rs = ctx.all('survey_responses').filter((r) => r.surveyId === sv.id).sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
        const questions = sv.questions.map((q) => summarizeQuestion(q, rs.flatMap((r) => r.answers.filter((a) => a.questionId === q.id).map((a) => a.answer))));
        return { surveyId: sv.id, name: sv.name, status: sv.status, responseCount: rs.length, npsScore: questions.find((q) => q.type === 'nps')?.npsScore ?? null, questions };
      },
      example: (ctx) => ({ id: byName(ctx, 'Customer Satisfaction (NPS)').id }),
    },
  ],

  seed(ctx, h) {
    const q = (text, type, extra = {}) => ({ id: ctx.newId('srq'), text, type, required: true, branching: [], ...extra });
    const nps = [q('How likely are you to recommend Acme to a friend or colleague?', 'nps'), q('What could we do better?', 'text', { required: false }), q('May we contact you about your feedback?', 'yes_no'), q('What is the best time to reach you?', 'text', { required: false })];
    nps[0].branching = [{ operator: 'gte', value: 9, goTo: nps[2].id }];
    nps[2].branching = [{ operator: 'equals', value: false, goTo: 'end' }];
    const appt = [q('How would you rate your appointment?', 'rating', { scaleMax: 5 }), q('Did your appointment start on time?', 'yes_no'), q('Anything else you would like to share?', 'text', { required: false })];
    const poll = [q('Which new service interests you most?', 'multiple_choice', { options: ['Social media management', 'Email marketing', 'Video production', 'None of these'] })];
    const onboard = [q('How smooth was your onboarding?', 'rating', { scaleMax: 5 }), q('What slowed you down?', 'text', { required: false })];
    const rows = [
      ['Customer Satisfaction (NPS)', 'published', 'Quarterly NPS survey for active customers', nps],
      ['Post-Appointment Feedback', 'published', 'Sent after each completed appointment', appt],
      ['Product Interest Poll', 'closed', 'Gauge interest in new services (Sept)', poll],
      ['Onboarding Experience', 'draft', 'For customers in their first 30 days', onboard],
      ['Untitled Survey', 'draft', null, []],
    ];
    for (const [name, status, description, questions] of rows)
      ctx.insert('surveys', {
        name, status, description, questions, responseCount: 0, publishedAt: status === 'draft' ? null : h.daysAgo(h.int(45, 90)),
        closedAt: status === 'closed' ? h.daysAgo(20) : null, createdAt: h.daysAgo(h.int(90, 150)),
      });
    const contacts = ctx.all('contacts').filter((c) => c.status === 'active').slice(40, 70);
    if (!contacts.length) return;
    const answerSets = [
      ...[10, 9, 9, 8, 10, 6, 7, 3, 9, 10, 5, 8, 10, 9].map((score, k) => [0, { [nps[0].id]: score, [nps[1].id]: score < 9 ? h.pick(['Faster replies to support tickets', 'Clearer pricing', 'More reporting options']) : undefined, [nps[2].id]: k % 3 !== 0, [nps[3].id]: k % 3 !== 0 ? 'Afternoons' : undefined }]),
      ...[5, 4, 5, 3, 4, 2, 5, 4].map((r, k) => [1, { [appt[0].id]: r, [appt[1].id]: r >= 4, [appt[2].id]: k === 5 ? 'Waited 20 minutes past my slot.' : undefined }]),
      ...['Email marketing', 'Video production', 'Email marketing', 'Social media management', 'None of these', 'Email marketing'].map((o) => [2, { [poll[0].id]: o }]),
    ];
    answerSets.forEach(([si, given], k) => {
      const sv = ctx.all('surveys')[si];
      const w = walk(sv, Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)));
      const at = si === 2 ? h.daysAgo(h.int(25, 40)) : h.daysAgo(h.int(1, 40));
      ctx.insert('survey_responses', { surveyId: sv.id, contactId: contacts[k % contacts.length].id, answers: w.answers, path: w.path, submittedAt: at, createdAt: at });
      sv.responseCount++;
    });
  },
});
