import { defineModule, ops, z, id, entity, isoDate, fail } from '../kit.js';

const PRIORITIES = ['low', 'medium', 'high'];
const task = entity({
  title: z.string(), description: z.string().nullable().optional(), contactId: z.string().nullable().optional(),
  recordType: z.string().nullable().optional(), recordId: z.string().nullable().optional(), ownerId: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(), priority: z.enum(PRIORITIES), status: z.enum(['open', 'completed', 'cancelled']),
});
const day = (v) => v?.slice(0, 10) ?? null;
function checkOwner(ctx, uid) {
  if (!uid) return;
  const u = ctx.get('users', uid, 'user');
  if (u.status !== 'active') fail('INVALID_STATE', `user ${uid} (${u.name}) is ${u.status}; pick an active user`);
}
const openOnly = (t) => t.status !== 'open' && fail('INVALID_STATE', `task ${t.id} is ${t.status}`);

export default defineModule({
  id: 'tasks',
  code: 'M06',
  name: 'Tasks',
  description: 'Organize work, deadlines, and assignments (to-dos, follow-ups, callbacks).',
  tables: { tasks: { prefix: 'tsk', schema: task } },
  actions: [
    {
      id: 'create_task', name: 'Create task',
      description: 'Create a to-do / follow-up task, optionally linked to a contact or any record (recordType = table name like leads, opportunities, invoices), with owner, due date and priority.',
      keywords: ['follow up', 'follow-up', 'reminder', 'todo', 'to-do', 'callback', 'call back'],
      ...ops.create('tasks', {
        input: z.object({
          title: z.string().min(1), description: z.string().optional(), contactId: z.string().optional(),
          recordType: z.string().optional(), recordId: z.string().optional(), ownerId: z.string().optional(),
          dueDate: isoDate().optional(), priority: z.enum(PRIORITIES).default('medium'),
        }),
        check: (i, ctx) => {
          if (i.contactId) ctx.get('contacts', i.contactId, 'contact');
          if (i.recordType || i.recordId) {
            if (!(i.recordType && i.recordId)) fail('VALIDATION', 'recordType and recordId go together');
            ctx.ref(i.recordType, i.recordId);
          }
          checkOwner(ctx, i.ownerId);
        },
        build: (i, ctx) => ({
          dueDate: day(i.dueDate), status: 'open', completedAt: null, description: i.description ?? null, ownerId: i.ownerId ?? null,
          contactId: i.contactId ?? (i.recordType === 'contacts' ? i.recordId : i.recordType ? ctx.find(i.recordType, i.recordId)?.contactId ?? null : null),
          recordType: i.recordType ?? null, recordId: i.recordId ?? null,
        }),
      }),
      example: (ctx) => ({ title: 'Call back about pricing', contactId: ctx.all('contacts')[1].id, ownerId: 'usr_002', dueDate: '2026-11-05' }),
    },
    {
      id: 'get_task', name: 'Get task details', description: 'Fetch a task by ID.',
      ...ops.get('tasks', { what: 'task' }),
      example: (ctx) => ({ id: ctx.all('tasks')[0].id }),
    },
    {
      id: 'search_tasks', name: 'Search tasks',
      description: 'Find tasks by text, status, owner, contact, linked record, priority, or due date range. overdue=true returns open tasks past due.',
      ...ops.search('tasks', {
        text: ['title', 'description'],
        filters: {
          status: z.enum(['open', 'completed', 'cancelled']).optional(), ownerId: z.string().optional(), contactId: z.string().optional(),
          contactIds: z.array(z.string()).optional(), recordId: z.string().optional(), priority: z.enum(PRIORITIES).optional(),
          dueDateAfter: isoDate().optional(), dueDateBefore: isoDate().optional(), overdue: z.boolean().optional(),
          createdAtAfter: isoDate().optional(),
        },
        virtual: ['overdue'],
        where: (t, i, ctx) => i.overdue === undefined || (i.overdue === (t.status === 'open' && !!t.dueDate && t.dueDate < ctx.today)),
      }),
      example: () => ({ status: 'open' }),
    },
    {
      id: 'update_task', name: 'Update task description', description: 'Change the title and/or description of a task.',
      ...ops.update('tasks', { what: 'task', fields: { title: z.string().min(1), description: z.string() } }),
      example: (ctx) => ({ id: ctx.all('tasks')[0].id, description: 'Discuss renewal options' }),
    },
    {
      id: 'assign_task_owner', name: 'Assign task owner', description: 'Assign a task to an active user.',
      ...ops.set('tasks', 'ownerId', id('user'), { what: 'task', guard: (t, i, ctx) => { openOnly(t); checkOwner(ctx, i.ownerId); } }),
      example: (ctx) => ({ id: ctx.all('tasks').find((t) => t.status === 'open').id, ownerId: 'usr_005' }),
    },
    {
      id: 'set_task_due_date', name: 'Set task due date', description: 'Set or change the due date of an open task.',
      ...ops.set('tasks', 'dueDate', isoDate(), { what: 'task', guard: openOnly, map: day }),
      example: (ctx) => ({ id: ctx.all('tasks').find((t) => t.status === 'open').id, dueDate: '2026-11-05' }),
    },
    {
      id: 'set_task_priority', name: 'Set task priority', description: 'Set task priority (low, medium, high).',
      ...ops.set('tasks', 'priority', z.enum(PRIORITIES), { what: 'task', guard: openOnly }),
      example: (ctx) => ({ id: ctx.all('tasks').find((t) => t.status === 'open' && t.priority !== 'high').id, priority: 'high' }),
    },
    {
      id: 'complete_task', name: 'Mark task complete', description: 'Mark an open task as completed.',
      ...ops.transition('tasks', { to: 'completed', from: ['open'], what: 'task', extra: (t, i, ctx) => ({ completedAt: ctx.now }) }),
      example: (ctx) => ({ id: ctx.all('tasks').find((t) => t.status === 'open').id }),
    },
    {
      id: 'reopen_task', name: 'Reopen task', description: 'Reopen a completed or cancelled task.',
      ...ops.transition('tasks', { to: 'open', from: ['completed', 'cancelled'], what: 'task', extra: () => ({ completedAt: null }) }),
      example: (ctx) => ({ id: ctx.all('tasks').find((t) => t.status === 'completed').id }),
    },
    {
      id: 'cancel_task', name: 'Cancel task', description: 'Cancel an open task (can be reopened later).',
      ...ops.transition('tasks', { to: 'cancelled', from: ['open'], what: 'task' }),
      example: (ctx) => ({ id: ctx.all('tasks').find((t) => t.status === 'open').id }),
    },
  ],

  seed(ctx, h) {
    const contacts = ctx.all('contacts');
    const owners = ['usr_002', 'usr_003', 'usr_004', 'usr_005', 'usr_006'];
    const titles = ['Follow up on proposal', 'Call back re: pricing', 'Send onboarding docs', 'Check in after demo', 'Collect missing payment details', 'Schedule quarterly review', 'Confirm appointment', 'Prepare quote'];
    for (let i = 0; i < 30; i++) {
      const status = i < 20 ? 'open' : i < 26 ? 'completed' : 'cancelled';
      const due = h.dateOnly(i % 4 === 0 ? h.daysAgo(h.int(1, 10)) : h.daysFromNow(h.int(0, 14)));
      ctx.insert('tasks', {
        title: titles[i % titles.length], description: null, contactId: contacts[(i * 3) % contacts.length]?.id ?? null, recordType: null, recordId: null,
        ownerId: owners[i % owners.length], dueDate: due, priority: h.pick(['low', 'medium', 'medium', 'high']), status,
        completedAt: status === 'completed' ? h.daysAgo(h.int(1, 5)) : null, createdAt: h.daysAgo(h.int(5, 30)),
      });
    }
  },
});
