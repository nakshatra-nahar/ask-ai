import { defineModule, ops, z, id, entity, fail } from '../kit.js';

const STRATEGIES = ['round_robin', 'least_busy', 'manual'];
const team = entity({
  name: z.string(), memberIds: z.array(z.string()), managerId: z.string().nullable().optional(),
  assignmentStrategy: z.enum(STRATEGIES), status: z.enum(['active', 'archived']),
});
const activeTeam = (t) => {
  if (t.status !== 'active') fail('INVALID_STATE', `team ${t.id} is archived`);
};

export default defineModule({
  id: 'teams',
  code: 'M49',
  name: 'Teams',
  description: 'Organize users into teams and allocate shared work.',
  tables: { teams: { prefix: 'tm', schema: team } },
  actions: [
    {
      id: 'create_team', name: 'Create team', description: 'Create a team of active users.',
      ...ops.create('teams', {
        input: z.object({ name: z.string().min(1), description: z.string().optional(), memberIds: z.array(z.string()).optional(), assignmentStrategy: z.enum(STRATEGIES).optional() }),
        check: (i, ctx) => (i.memberIds || []).forEach((uid) => {
          const u = ctx.get('users', uid, 'user');
          if (u.status !== 'active') fail('INVALID_STATE', `${u.name} (${uid}) is ${u.status}; only active users can join a team`);
        }),
        build: (i) => ({ memberIds: [...new Set(i.memberIds || [])], managerId: null, assignmentStrategy: i.assignmentStrategy || 'manual', status: 'active' }),
      }),
      example: () => ({ name: 'Enterprise Sales', memberIds: ['usr_002'] }),
    },
    {
      id: 'get_team', name: 'Get team details', description: 'Team details with member names.',
      risk: 'read',
      input: z.object({ id: id('team') }),
      output: team,
      handler: ({ id: tid }, ctx) => {
        const t = ctx.get('teams', tid, 'team');
        return { ...t, members: t.memberIds.map((u) => ({ id: u, name: ctx.find('users', u)?.name })) };
      },
      example: () => ({ id: 'tm_001' }),
    },
    {
      id: 'list_teams', name: 'List teams', description: 'List teams. Archived teams are excluded unless status is given.',
      ...ops.search('teams', { text: ['name'], filters: { status: z.enum(['active', 'archived']).optional() }, where: (r, i) => i.status || r.status !== 'archived' }),
      example: () => ({}),
    },
    {
      id: 'rename_team', name: 'Rename team', description: 'Rename a team.',
      ...ops.set('teams', 'name', z.string().min(1), { what: 'team', guard: activeTeam }),
      example: () => ({ id: 'tm_002', name: 'Customer Support' }),
    },
    {
      id: 'add_team_member', name: 'Add team member', description: 'Add an active user to a team.',
      risk: 'write',
      input: z.object({ id: id('team'), userId: id('user') }),
      output: team,
      handler: ({ id: tid, userId }, ctx) => {
        const t = ctx.get('teams', tid, 'team');
        activeTeam(t);
        const u = ctx.get('users', userId, 'user');
        if (u.status !== 'active') fail('INVALID_STATE', `${u.name} is ${u.status}`);
        if (t.memberIds.includes(userId)) fail('DUPLICATE', `${u.name} is already in ${t.name}`);
        return ctx.patch(t, { memberIds: [...t.memberIds, userId] });
      },
      example: () => ({ id: 'tm_001', userId: 'usr_008' }),
    },
    {
      id: 'remove_team_member', name: 'Remove team member', description: 'Remove a user from a team.',
      risk: 'write',
      input: z.object({ id: id('team'), userId: id('user') }),
      output: team,
      handler: ({ id: tid, userId }, ctx) => {
        const t = ctx.get('teams', tid, 'team');
        if (!t.memberIds.includes(userId)) fail('NOT_FOUND', `${userId} is not a member of ${t.name}`);
        return ctx.patch(t, { memberIds: t.memberIds.filter((u) => u !== userId), managerId: t.managerId === userId ? null : t.managerId });
      },
      example: () => ({ id: 'tm_001', userId: 'usr_005' }),
    },
    {
      id: 'assign_team_manager', name: 'Assign team manager', description: 'Set the manager of a team (must be an active user).',
      ...ops.set('teams', 'managerId', id('user'), {
        param: 'userId', what: 'team',
        guard: (t, i, ctx) => {
          activeTeam(t);
          const u = ctx.get('users', i.userId, 'user');
          if (u.status !== 'active') fail('INVALID_STATE', `${u.name} is ${u.status}`);
        },
      }),
      example: () => ({ id: 'tm_002', userId: 'usr_007' }),
    },
    {
      id: 'set_team_assignment_strategy', name: 'Set team assignment strategy', description: 'How new work is distributed: round_robin, least_busy, or manual.',
      ...ops.set('teams', 'assignmentStrategy', z.enum(STRATEGIES), { param: 'strategy', what: 'team', guard: activeTeam }),
      example: () => ({ id: 'tm_001', strategy: 'least_busy' }),
    },
    {
      id: 'get_team_workload', name: 'Get team workload',
      description: 'Per-member workload (open tasks, open leads, upcoming appointments) and availability (active and not out of office). Use to pick available reps for assignment.',
      keywords: ['capacity', 'who is available', 'busy', 'available sales reps'],
      risk: 'read',
      input: z.object({ id: id('team') }),
      output: z.looseObject({ teamId: z.string(), members: z.array(z.looseObject({ userId: z.string(), available: z.boolean() })) }),
      handler: ({ id: tid }, ctx) => {
        const t = ctx.get('teams', tid, 'team');
        const members = t.memberIds.map((uid) => {
          const u = ctx.find('users', uid) || {};
          const openTasks = ctx.all('tasks').filter((x) => x.ownerId === uid && x.status === 'open').length;
          const openLeads = ctx.all('leads').filter((x) => x.ownerId === uid && ['new', 'contacted', 'qualified'].includes(x.status)).length;
          const upcomingAppointments = ctx.all('appointments').filter((x) => x.hostUserId === uid && ['booked', 'confirmed'].includes(x.status) && x.startAt >= ctx.now).length;
          return {
            userId: uid, name: u.name, status: u.status, outOfOffice: !!u.outOfOffice,
            available: u.status === 'active' && !u.outOfOffice, openTasks, openLeads, upcomingAppointments,
          };
        });
        return { teamId: t.id, name: t.name, assignmentStrategy: t.assignmentStrategy, members };
      },
      example: () => ({ id: 'tm_001' }),
    },
    {
      id: 'archive_team', name: 'Archive team', description: 'Archive a team.',
      ...ops.transition('teams', { to: 'archived', from: ['active'], risk: 'destructive', what: 'team' }),
      example: () => ({ id: 'tm_003' }),
    },
  ],

  seed(ctx) {
    ctx.insert('teams', { name: 'Sales', description: 'Inbound and outbound sales', memberIds: ['usr_002', 'usr_003', 'usr_004', 'usr_005', 'usr_009'], managerId: 'usr_001', assignmentStrategy: 'round_robin', status: 'active' });
    ctx.insert('teams', { name: 'Support', description: 'Customer support', memberIds: ['usr_006', 'usr_007'], managerId: 'usr_006', assignmentStrategy: 'least_busy', status: 'active' });
    ctx.insert('teams', { name: 'Marketing', description: 'Campaigns and content', memberIds: ['usr_008'], managerId: 'usr_008', assignmentStrategy: 'manual', status: 'active' });
  },
});
