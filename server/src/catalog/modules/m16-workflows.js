import { defineModule, ops, z, id, entity, limit, fail, page } from '../kit.js';

const STEP_TYPES = ['send_email', 'send_sms', 'wait', 'create_task', 'add_tag', 'assign_owner', 'if_else'];
const ns = z.string().nullable().optional();
const step = z.looseObject({ id: z.string(), type: z.enum(STEP_TYPES), config: z.looseObject({}) });
const workflow = entity({
  name: z.string(), description: ns, status: z.enum(['draft', 'published', 'paused']), steps: z.array(step), version: z.number(),
  publishedAt: ns, runs: z.array(z.looseObject({ id: z.string(), status: z.string() })).optional(),
});
const CONFIG_HELP = 'send_email {templateId | subject+body}, send_sms {templateId | body}, wait {days | hours}, create_task {title, dueInDays?, assigneeId?}, add_tag {tag}, assign_owner {userId | teamId}, if_else {field, operator, value}';

/** Required-config check for one step; also catches stale references (archived template, deactivated user). */
function stepErrors(ctx, s) {
  const c = s.config || {};
  const e = [];
  const tpl = (ch) => {
    const t = ctx.find('templates', c.templateId);
    if (!t) e.push(`template ${c.templateId} not found`);
    else if (t.status !== 'active') e.push(`template ${t.id} '${t.name}' is archived`);
    else if (t.channel !== ch) e.push(`template ${t.id} is an ${t.channel} template; ${s.type} needs ${ch}`);
  };
  if (s.type === 'send_email') c.templateId ? tpl('email') : (!c.subject || !c.body) && e.push('send_email needs config.templateId, or config.subject and config.body');
  if (s.type === 'send_sms') c.templateId ? tpl('sms') : !c.body && e.push('send_sms needs config.templateId or config.body');
  if (s.type === 'wait' && !(c.days > 0 || c.hours > 0)) e.push('wait needs config.days or config.hours > 0');
  if (s.type === 'create_task' && !c.title) e.push('create_task needs config.title');
  if (s.type === 'create_task' && c.assigneeId) {
    const u = ctx.find('users', c.assigneeId);
    if (!u) e.push(`user ${c.assigneeId} not found`);
    else if (u.status !== 'active') e.push(`user ${u.id} (${u.name}) is ${u.status} and cannot be assigned tasks`);
  }
  if (s.type === 'add_tag' && !c.tag) e.push('add_tag needs config.tag');
  if (s.type === 'if_else' && (!c.field || !c.operator)) e.push('if_else needs config.field, config.operator and config.value');
  if (s.type === 'assign_owner') {
    const u = c.userId && ctx.find('users', c.userId);
    if (c.userId && !u) e.push(`user ${c.userId} not found`);
    else if (u && u.status !== 'active') e.push(`user ${u.id} (${u.name}) is ${u.status} and cannot be assigned`);
    else if (!c.userId && !c.teamId) e.push('assign_owner needs config.userId or config.teamId');
    else if (c.teamId && !ctx.find('teams', c.teamId)) e.push(`team ${c.teamId} not found`);
  }
  return e;
}
function validate(ctx, wf) {
  const errors = wf.steps.flatMap((s, i) => stepErrors(ctx, s).map((message) => ({ stepId: s.id, position: i + 1, type: s.type, message })));
  if (!wf.steps.length) errors.push({ stepId: null, position: null, message: 'workflow has no steps' });
  const warnings = [];
  const last = wf.steps.at(-1);
  if (last && ['wait', 'if_else'].includes(last.type)) warnings.push(`last step is ${last.type}; it has nothing to lead into`);
  return { workflowId: wf.id, valid: !errors.length, errors, warnings, stepCount: wf.steps.length };
}
const editable = (wf) => {
  if (wf.status === 'published') fail('INVALID_STATE', `workflow ${wf.id} '${wf.name}' is published; pause it before editing steps`);
};
const assertStep = (ctx, s) => {
  const e = stepErrors(ctx, s);
  if (e.length) fail('VALIDATION', `${e.join('; ')}. Required config: ${CONFIG_HELP}`);
};
const byName = (ctx, n) => ctx.all('workflows').find((w) => w.name === n);
const stepInput = { type: z.enum(STEP_TYPES), config: z.record(z.string(), z.any()).describe(CONFIG_HELP) };

export default defineModule({
  id: 'workflows',
  code: 'M16',
  name: 'Workflows',
  description: 'Build and operate multi-step automations.',
  tables: { workflows: { prefix: 'wf', schema: workflow } },
  actions: [
    {
      id: 'create_workflow', name: 'Create workflow',
      description: 'Create an empty draft automation workflow (multi-step sequence run per contact). Add steps, validate, then publish. Event triggers that start it are managed in the triggers module.',
      keywords: ['new automation', 'build automation', 'drip sequence'],
      ...ops.create('workflows', {
        input: z.object({ name: z.string().min(1), description: z.string().optional() }),
        check: (i, ctx) => {
          const d = ctx.all('workflows').find((w) => w.name.toLowerCase() === i.name.toLowerCase());
          if (d) fail('DUPLICATE', `workflow '${i.name}' already exists (${d.id}, ${d.status})`);
        },
        build: (i) => ({ description: i.description ?? null, status: 'draft', steps: [], version: 0, publishedAt: null, runs: [] }),
      }),
      example: () => ({ name: 'Post-Purchase Thank You', description: 'Thank customers after a paid invoice' }),
    },
    {
      id: 'get_workflow', name: 'Get workflow definition', description: 'Fetch a workflow definition: status, version and ordered steps with config (run history excluded; see execution history).',
      risk: 'read',
      input: z.object({ id: id('workflow') }),
      output: workflow,
      handler: ({ id: wid }, ctx) => {
        const { runs = [], ...def } = ctx.get('workflows', wid, 'workflow');
        return { ...def, runCount: runs.length };
      },
      example: (ctx) => ({ id: byName(ctx, 'New Lead Nurture').id }),
    },
    {
      id: 'list_workflows', name: 'List workflows', description: 'List automation workflows, filterable by status (draft/published/paused) or name text.',
      keywords: ['automations', 'active automations'],
      ...ops.search('workflows', { text: ['name', 'description'], filters: { status: z.enum(['draft', 'published', 'paused']).optional() } }),
      example: () => ({ status: 'published' }),
    },
    {
      id: 'add_workflow_step', name: 'Add workflow step',
      description: `Insert a step into a draft or paused workflow (published ones must be paused first). Config is validated per type: ${CONFIG_HELP}.`,
      risk: 'write',
      input: z.object({ id: id('workflow'), ...stepInput, position: z.number().int().min(1).optional().describe('1-based position; default = append') }),
      output: workflow,
      handler: ({ id: wid, type, config, position }, ctx) => {
        const wf = ctx.get('workflows', wid, 'workflow');
        editable(wf);
        const added = { id: ctx.newId('wst'), type, config };
        assertStep(ctx, added);
        wf.steps.splice(position ? position - 1 : wf.steps.length, 0, added);
        ctx.patch(wf, {});
        return { ...wf, added };
      },
      example: (ctx) => ({ id: byName(ctx, 'Re-engagement Sequence').id, type: 'create_task', config: { title: 'Call lapsed customer', dueInDays: 2 } }),
    },
    {
      id: 'update_workflow_step', name: 'Update workflow step', description: 'Change the type and/or merge new config into an existing step of a draft or paused workflow; the result is re-validated.',
      risk: 'write',
      input: z.object({ id: id('workflow'), stepId: id('step'), type: z.enum(STEP_TYPES).optional(), config: stepInput.config.optional().describe('keys to merge into the step config') }),
      output: workflow,
      handler: ({ id: wid, stepId, type, config }, ctx) => {
        const wf = ctx.get('workflows', wid, 'workflow');
        editable(wf);
        const s = wf.steps.find((x) => x.id === stepId);
        if (!s) fail('NOT_FOUND', `step ${stepId} not found in ${wf.id}; steps: ${wf.steps.map((x) => `${x.id} ${x.type}`).join(', ')}`);
        if (!type && !config) fail('VALIDATION', 'provide type and/or config');
        const next = { ...s, type: type ?? s.type, config: type && type !== s.type ? config ?? {} : { ...s.config, ...config } };
        assertStep(ctx, next);
        Object.assign(s, next);
        return ctx.patch(wf, {});
      },
      example: (ctx) => {
        const wf = byName(ctx, 'Webinar Follow-up');
        return { id: wf.id, stepId: wf.steps.find((s) => s.type === 'assign_owner').id, config: { userId: 'usr_002' } };
      },
    },
    {
      id: 'remove_workflow_step', name: 'Remove workflow step', description: 'Delete one step from a draft or paused workflow.',
      ...ops.removeItem('workflows', 'steps', { itemParam: 'stepId', what: 'workflow', risk: 'destructive', guard: editable }),
      example: (ctx) => {
        const wf = byName(ctx, 'Webinar Follow-up');
        return { id: wf.id, stepId: wf.steps.find((s) => s.type === 'send_email').id };
      },
    },
    {
      id: 'validate_workflow', name: 'Validate workflow',
      description: 'Check every step of a workflow for missing required config and stale references (archived templates, deactivated users); returns errors (block publishing) and warnings.',
      keywords: ['check automation', 'lint workflow'],
      risk: 'read',
      input: z.object({ id: id('workflow') }),
      output: z.looseObject({ workflowId: z.string(), valid: z.boolean(), errors: z.array(z.looseObject({ message: z.string() })), warnings: z.array(z.string()) }),
      handler: ({ id: wid }, ctx) => validate(ctx, ctx.get('workflows', wid, 'workflow')),
      example: (ctx) => ({ id: byName(ctx, 'Webinar Follow-up').id }),
    },
    {
      id: 'publish_workflow', name: 'Publish workflow',
      description: 'Make a draft or paused workflow live so it runs for enrolled contacts (sends real messages). Fails with the validation errors unless the workflow validates clean.',
      keywords: ['activate automation', 'turn on workflow', 'go live'],
      risk: 'external',
      input: z.object({ id: id('workflow') }),
      output: workflow,
      handler: ({ id: wid }, ctx) => {
        const wf = ctx.get('workflows', wid, 'workflow');
        if (wf.status === 'published') fail('INVALID_STATE', `workflow ${wf.id} '${wf.name}' is already published`);
        const v = validate(ctx, wf);
        if (!v.valid) fail('VALIDATION', `workflow '${wf.name}' has ${v.errors.length} error(s): ${v.errors.map((e) => (e.position ? `step ${e.position} (${e.stepId}): ` : '') + e.message).join('; ')}`, { errors: v.errors });
        return ctx.patch(wf, { status: 'published', version: wf.version + 1, publishedAt: ctx.now });
      },
      example: (ctx) => ({ id: byName(ctx, 'Re-engagement Sequence').id }),
    },
    {
      id: 'pause_workflow', name: 'Pause workflow', description: 'Pause a published workflow: no new enrollments or step executions until republished.',
      keywords: ['stop automation', 'turn off workflow'],
      ...ops.transition('workflows', { to: 'paused', from: ['published'], what: 'workflow', extra: (r, i, ctx) => ({ pausedAt: ctx.now }) }),
      example: (ctx) => ({ id: byName(ctx, 'New Lead Nurture').id }),
    },
    {
      id: 'get_workflow_execution_history', name: 'Get workflow execution history',
      description: 'Past and in-progress runs of a workflow (per contact): status completed/running/failed, steps executed, error, timestamps, newest first, with counts by status.',
      keywords: ['workflow runs', 'automation logs', 'why did workflow fail'],
      risk: 'read',
      input: z.object({ id: id('workflow'), status: z.enum(['completed', 'running', 'failed']).optional(), contactId: z.string().optional(), limit }),
      output: z.looseObject({ workflowId: z.string(), total: z.number(), items: z.array(z.looseObject({ id: z.string(), status: z.string() })), counts: z.looseObject({}) }),
      handler: ({ id: wid, status, contactId, limit: lim }, ctx) => {
        const wf = ctx.get('workflows', wid, 'workflow');
        const runs = wf.runs || [];
        const counts = Object.fromEntries(['completed', 'running', 'failed'].map((s) => [s, runs.filter((r) => r.status === s).length]));
        const rows = runs.filter((r) => (!status || r.status === status) && (!contactId || r.contactId === contactId)).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
        return { workflowId: wf.id, name: wf.name, counts, ...page(rows, lim) };
      },
      example: (ctx) => ({ id: byName(ctx, 'New Lead Nurture').id }),
    },
  ],

  seed(ctx, h) {
    const tpl = (n) => ctx.all('templates').find((t) => t.name === n)?.id ?? null;
    const st = (type, config) => ({ id: ctx.newId('wst'), type, config });
    const contacts = ctx.all('contacts').filter((c) => c.status === 'active');
    const rows = [
      {
        name: 'New Lead Nurture', description: 'Text, then email new leads; create a call task if they have not replied.', status: 'published', version: 3,
        steps: [
          st('send_sms', { templateId: tpl('Lead Follow-up SMS') }), st('wait', { days: 1 }),
          st('if_else', { field: 'conversation.hasInboundReply', operator: 'equals', value: false }),
          st('send_email', { templateId: tpl('Lead Follow-up Email') }), st('create_task', { title: 'Call new lead', dueInDays: 1 }),
        ],
        failure: 'Contact opted out of SMS (preferences.sms=false)',
      },
      {
        name: 'Appointment Reminders', description: 'SMS reminder 24 hours before each booked appointment.', status: 'published', version: 1,
        steps: [st('wait', { hours: 24, relativeTo: 'appointment.startAt', direction: 'before' }), st('send_sms', { templateId: tpl('Appointment Reminder') })],
        failure: 'Contact has no phone number',
      },
      {
        name: 'Invoice Overdue Follow-up', description: 'Email a payment reminder, wait 3 days, then create a call task.', status: 'published', version: 2,
        steps: [st('send_email', { templateId: tpl('Invoice Payment Reminder') }), st('wait', { days: 3 }), st('create_task', { title: 'Call about overdue invoice', dueInDays: 1 })],
        failure: 'Contact unsubscribed from email',
      },
      {
        // Deliberately invalid: deactivated owner + email step missing its body.
        name: 'Webinar Follow-up', description: 'Draft: follow up with webinar attendees.', status: 'draft', version: 0,
        steps: [st('assign_owner', { userId: 'usr_009' }), st('send_email', { subject: 'Thanks for attending!' }), st('add_tag', { tag: 'webinar-attendee' })],
      },
      {
        name: 'Re-engagement Sequence', description: 'Win back contacts with no activity in 90 days.', status: 'draft', version: 0,
        steps: [st('send_email', { templateId: tpl('Welcome Email') }), st('wait', { days: 7 }), st('add_tag', { tag: 're-engaged' })],
      },
      {
        name: 'Birthday Greetings', description: 'Send a birthday text with a coupon.', status: 'paused', version: 1, pausedAt: h.daysAgo(12),
        steps: [st('send_sms', { body: 'Happy birthday from Acme! Enjoy 10% off your next visit with code BDAY10.' })],
      },
    ];
    for (const r of rows) {
      const { failure, ...wf } = r;
      const live = wf.status !== 'draft';
      const runs = [];
      for (let k = 0; live && contacts.length && k < 6; k++) {
        const startedAt = h.daysAgo(h.int(1, 25));
        const status = k === 0 && wf.status === 'published' ? 'running' : k === 3 && failure ? 'failed' : 'completed';
        runs.push({
          id: ctx.newId('wfr'), contactId: h.pick(contacts).id, status, startedAt,
          finishedAt: status === 'running' ? null : new Date(Date.parse(startedAt) + h.int(1, 72) * 36e5).toISOString(),
          stepsExecuted: status === 'completed' ? wf.steps.length : h.int(1, Math.max(1, wf.steps.length - 1)), error: status === 'failed' ? failure : null,
        });
      }
      ctx.insert('workflows', { ...wf, publishedAt: live ? h.daysAgo(h.int(30, 90)) : null, runs, createdAt: h.daysAgo(h.int(90, 200)) });
    }
  },
});
