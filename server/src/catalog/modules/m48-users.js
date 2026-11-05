import { defineModule, ops, z, id, entity, limit, fail, page } from '../kit.js';

export const ROLES = ['admin', 'manager', 'sales_rep', 'support', 'marketing', 'billing'];
const PERMS = {
  admin: ['*'],
  manager: ['contacts:*', 'leads:*', 'opportunities:*', 'tasks:*', 'reports:read', 'teams:manage'],
  sales_rep: ['contacts:read', 'contacts:write', 'leads:*', 'opportunities:*', 'tasks:*', 'appointments:*', 'conversations:*'],
  support: ['contacts:read', 'tickets:*', 'conversations:*', 'tasks:*'],
  marketing: ['campaigns:*', 'templates:*', 'workflows:*', 'websites:*', 'funnels:*', 'contacts:read'],
  billing: ['invoices:*', 'payments:*', 'subscriptions:*', 'refunds:*', 'contacts:read'],
};
const user = entity({
  name: z.string(), email: z.string(), roles: z.array(z.enum(ROLES)), status: z.enum(['invited', 'active', 'deactivated']),
  title: z.string().optional(), timezone: z.string().optional(), outOfOffice: z.boolean().optional(),
});

const otherActiveAdmin = (ctx, uid) => ctx.all('users').some((x) => x.id !== uid && x.status === 'active' && x.roles.includes('admin'));
const keepAdmin = (ctx, u) => {
  if (u.status === 'active' && u.roles.includes('admin') && !otherActiveAdmin(ctx, u.id))
    fail('INVALID_STATE', `${u.name} is the only active admin; give another active user the admin role first`);
};

export default defineModule({
  id: 'users',
  code: 'M48',
  name: 'Users',
  description: 'Manage platform user accounts (staff, sales reps) and access.',
  tables: { users: { prefix: 'usr', schema: user } },
  actions: [
    {
      id: 'invite_user', name: 'Invite user', description: 'Invite a new staff user by email with an initial role. Sends an invitation email.',
      keywords: ['add teammate', 'new staff', 'add sales rep'],
      ...ops.create('users', {
        risk: 'external',
        input: z.object({ name: z.string().min(1), email: z.email(), role: z.enum(ROLES), title: z.string().optional() }),
        check: (i, ctx) => {
          if (ctx.all('users').some((u) => u.email.toLowerCase() === i.email.toLowerCase())) fail('DUPLICATE', `user with email ${i.email} already exists`);
        },
        build: (i) => ({ roles: [i.role], role: undefined, status: 'invited', timezone: 'America/New_York', outOfOffice: false }),
      }),
      example: () => ({ name: 'New Hire', email: 'new.hire@acme.test', role: 'sales_rep' }),
    },
    {
      id: 'get_user', name: 'Get user profile', description: 'Fetch a staff user profile by ID.',
      ...ops.get('users', { what: 'user' }),
      example: () => ({ id: 'usr_002' }),
    },
    {
      id: 'list_users', name: 'List users',
      description: 'List staff users, filterable by role, status, out-of-office flag, or name/email text. Use to find available sales reps.',
      keywords: ['staff', 'sales reps', 'team members', 'employees', 'available reps'],
      ...ops.search('users', {
        text: ['name', 'email', 'title'],
        filters: { roles: z.enum(ROLES).optional().describe('role the user must have'), status: z.enum(['invited', 'active', 'deactivated']).optional(), outOfOffice: z.boolean().optional() },
      }),
      example: () => ({ roles: 'sales_rep', status: 'active' }),
    },
    {
      id: 'update_user_profile', name: 'Update user profile', description: 'Change a user name, title, timezone, phone, or out-of-office flag.',
      ...ops.update('users', { what: 'user', fields: { name: z.string().min(1), title: z.string(), timezone: z.string(), phone: z.string(), outOfOffice: z.boolean() } }),
      example: () => ({ id: 'usr_003', title: 'Senior Account Executive' }),
    },
    {
      id: 'assign_user_role', name: 'Assign user role', description: 'Grant an additional role to a user.',
      risk: 'write',
      input: z.object({ id: id('user'), role: z.enum(ROLES) }),
      output: user,
      handler: ({ id: uid, role }, ctx) => {
        const u = ctx.get('users', uid, 'user');
        if (u.roles.includes(role)) fail('DUPLICATE', `${u.name} already has role ${role}`);
        return ctx.patch(u, { roles: [...u.roles, role] });
      },
      example: () => ({ id: 'usr_002', role: 'manager' }),
    },
    {
      id: 'revoke_user_role', name: 'Revoke user role', description: 'Remove a role from a user (a user must keep at least one role).',
      risk: 'destructive',
      input: z.object({ id: id('user'), role: z.enum(ROLES) }),
      output: user,
      handler: ({ id: uid, role }, ctx) => {
        const u = ctx.get('users', uid, 'user');
        if (!u.roles.includes(role)) fail('NOT_FOUND', `${u.name} does not have role ${role}`);
        if (u.roles.length === 1) fail('INVALID_STATE', 'cannot remove the only role; assign another role first');
        if (role === 'admin') keepAdmin(ctx, u);
        return ctx.patch(u, { roles: u.roles.filter((r) => r !== role) });
      },
      example: () => ({ id: 'usr_001', role: 'manager' }),
    },
    {
      id: 'deactivate_user', name: 'Deactivate user',
      description: 'Deactivate an active (or invited) user so they can no longer log in or own new records. They are removed as manager of any team; team memberships and owned records are kept so they can be reassigned. The last active admin cannot be deactivated.',
      ...(() => {
        const base = ops.transition('users', { to: 'deactivated', from: ['active', 'invited'], risk: 'destructive', what: 'user', guard: (u, i, ctx) => keepAdmin(ctx, u) });
        return {
          ...base,
          handler: (inp, ctx) => {
            const u = base.handler(inp, ctx);
            // Team managers must be active users (see teams.assign_team_manager).
            const managed = ctx.all('teams').filter((t) => t.managerId === u.id);
            managed.forEach((t) => ctx.patch(t, { managerId: null }));
            return { ...u, removedAsManagerOf: managed.map((t) => t.id) };
          },
        };
      })(),
      example: () => ({ id: 'usr_007' }),
    },
    {
      id: 'reactivate_user', name: 'Reactivate user', description: 'Reactivate a deactivated user.',
      ...ops.transition('users', { to: 'active', from: ['deactivated'], what: 'user' }),
      example: () => ({ id: 'usr_009' }),
    },
    {
      id: 'list_user_permissions', name: 'List user permissions', description: 'Effective permissions for a user, derived from their roles (none while deactivated).',
      risk: 'read',
      input: z.object({ id: id('user') }),
      output: z.looseObject({ userId: z.string(), roles: z.array(z.string()), permissions: z.array(z.string()) }),
      handler: ({ id: uid }, ctx) => {
        const u = ctx.get('users', uid, 'user');
        const perms = [...new Set(u.roles.flatMap((r) => PERMS[r] || []))];
        // '*' covers everything; 'x:*' covers 'x:read' / 'x:write'
        const effective = perms.includes('*') ? ['*'] : perms.filter((p) => p.endsWith(':*') || !perms.includes(p.split(':')[0] + ':*'));
        return { userId: u.id, status: u.status, roles: u.roles, permissions: u.status === 'deactivated' ? [] : effective.sort() };
      },
      example: () => ({ id: 'usr_002' }),
    },
    {
      id: 'get_user_audit_activity', name: 'View user audit activity', description: 'Actions performed by a user (audit log), newest first.',
      keywords: ['audit log', 'what did user do'],
      risk: 'read',
      input: z.object({ id: id('user'), limit }),
      output: z.looseObject({ total: z.number(), items: z.array(z.looseObject({ at: z.string(), action: z.string() })) }),
      handler: ({ id: uid, limit: lim }, ctx) => {
        ctx.get('users', uid, 'user');
        const rows = ctx.all('activity').filter((a) => a.actorId === uid).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
        return page(rows, lim);
      },
      example: () => ({ id: 'usr_001' }),
    },
  ],

  seed(ctx, h) {
    const rows = [
      ['Alex Morgan', ['admin', 'manager'], 'active', 'Head of Sales'],
      ['Jordan Lee', ['sales_rep'], 'active', 'Account Executive'],
      ['Priya Shah', ['sales_rep'], 'active', 'Account Executive'],
      ['Marcus Reed', ['sales_rep'], 'active', 'Account Executive', true],
      ['Dana Cruz', ['sales_rep'], 'active', 'SDR'],
      ['Sam Taylor', ['support'], 'active', 'Support Lead'],
      ['Riley Kim', ['support'], 'active', 'Support Agent'],
      ['Morgan Blake', ['marketing'], 'active', 'Marketing Manager'],
      ['Chris Park', ['sales_rep'], 'deactivated', 'Former AE'],
      ['Taylor Brooks', ['sales_rep'], 'invited', 'SDR'],
      ['Jamie Fox', ['billing'], 'active', 'Billing Specialist'],
    ];
    for (const [name, roles, status, title, ooo] of rows) {
      ctx.insert('users', {
        name, email: name.toLowerCase().replace(' ', '.') + '@acme.test', roles, status, title,
        timezone: 'America/New_York', outOfOffice: !!ooo, createdAt: h.daysAgo(h.int(200, 600)),
      });
    }
    for (let i = 0; i < 12; i++)
      (ctx.db.tables.activity ||= []).push({ id: ctx.newId('act'), at: h.daysAgo(h.int(1, 20)), actorId: h.pick(['usr_001', 'usr_002', 'usr_003']), action: 'auth.login', summary: 'Logged in', refs: [] });
  },
});
