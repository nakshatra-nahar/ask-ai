import { defineModule, ops, z, id, entity, isoDate, money, fail, toTime } from '../kit.js';

const ENT_TYPES = ['course', 'community'];
const STATUSES = ['active', 'expired', 'revoked'];
const entitlement = z.looseObject({ id: z.string(), type: z.enum(ENT_TYPES), refId: z.string(), title: z.string().nullable().optional() });
const plan = entity({
  name: z.string(), description: z.string().nullable().optional(), status: z.enum(['active', 'archived']),
  price: z.number().nullable().optional(), currency: z.string().optional(), interval: z.enum(['month', 'year', 'one_time']).nullable().optional(),
  entitlements: z.array(entitlement),
});
const membership = entity({
  contactId: z.string(), planId: z.string(), status: z.enum(STATUSES), startedAt: z.string(), expiresAt: z.string().nullable().optional(),
});

const isPast = (ctx, iso) => !!iso && toTime(iso, true) < toTime(ctx.now);
const live = (ctx, m) => m.status === 'active' && !isPast(ctx, m.expiresAt);
const TABLE = { course: 'courses', community: 'communities' };

/** Which live membership (if any) grants contactId access to a course/community. Shared with M43 Communities. */
export function membershipAccess(ctx, contactId, type, refId) {
  for (const m of ctx.all('memberships')) {
    if (m.contactId !== contactId || !live(ctx, m)) continue;
    const p = ctx.find('membership_plans', m.planId);
    if (p?.entitlements.some((e) => e.type === type && e.refId === refId)) return { membershipId: m.id, planId: p.id, planName: p.name };
  }
  return null;
}
/** After access is withdrawn: drop contacts from these private communities unless another live membership still grants them. */
function pruneCommunityMembers(ctx, communityIds, contactIds) {
  const removed = [];
  for (const cid of communityIds) {
    const c = ctx.find('communities', cid);
    if (c?.visibility !== 'private') continue;
    const drop = c.members.filter((m) => contactIds.includes(m.contactId) && !membershipAccess(ctx, m.contactId, 'community', cid));
    if (!drop.length) continue;
    ctx.patch(c, { members: c.members.filter((m) => !drop.includes(m)) });
    removed.push(...drop.map((m) => ({ communityId: cid, contactId: m.contactId })));
  }
  return removed;
}
const plansGranting = (ctx, type, refId) =>
  ctx.all('membership_plans').filter((p) => p.entitlements.some((e) => e.type === type && e.refId === refId)).map((p) => `${p.id} ${p.name}`);
function resolveRef(ctx, type, refId) {
  const r = ctx.get(TABLE[type], refId, type);
  if (r.status === 'archived') fail('INVALID_STATE', `${type} ${refId} (${r.title || r.name}) is archived and cannot be added to a plan`);
  return r.title || r.name;
}
const activePlan = (p) => {
  if (p.status !== 'active') fail('INVALID_STATE', `membership plan ${p.id} (${p.name}) is ${p.status}`);
};

export default defineModule({
  id: 'memberships',
  code: 'M44',
  name: 'Memberships',
  description: 'Manage access packages spanning courses and communities.',
  tables: {
    membership_plans: { prefix: 'mpl', schema: plan },
    memberships: { prefix: 'mem', schema: membership },
  },
  actions: [
    {
      id: 'create_membership_plan', name: 'Create membership plan',
      description: 'Create a membership plan (access package/tier) that can bundle courses and private communities. Not a payment subscription.',
      keywords: ['new tier', 'access package', 'membership level'],
      ...ops.create('membership_plans', {
        input: z.object({
          name: z.string().min(1), description: z.string().optional(),
          price: money.optional().describe('USD price per interval (informational)'), interval: z.enum(['month', 'year', 'one_time']).optional(),
          entitlements: z.array(z.object({ type: z.enum(ENT_TYPES), refId: id('course or community') })).optional(),
        }),
        check: (i, ctx) => {
          const dup = ctx.all('membership_plans').find((p) => p.name.toLowerCase() === i.name.toLowerCase());
          if (dup) fail('DUPLICATE', `a membership plan named '${i.name}' already exists (${dup.id})`, { existingId: dup.id });
          const refs = (i.entitlements || []).map((e) => e.refId);
          if (new Set(refs).size !== refs.length) fail('VALIDATION', 'entitlements contain the same course/community twice');
        },
        build: (i, ctx) => ({
          description: i.description ?? null, price: i.price ?? null, currency: 'USD', interval: i.interval ?? null, status: 'active',
          entitlements: (i.entitlements || []).map((e) => ({ id: ctx.newId('ent'), ...e, title: resolveRef(ctx, e.type, e.refId) })),
        }),
      }),
      example: (ctx) => ({ name: 'Course Bundle', price: 49, interval: 'month', entitlements: [{ type: 'course', refId: ctx.all('courses')[0].id }] }),
    },
    {
      id: 'get_membership_plan', name: 'Get membership plan', description: 'Fetch one membership plan with its course/community entitlements and member counts.',
      risk: 'read',
      input: z.object({ id: id('membership plan') }),
      output: plan,
      handler: ({ id: pid }, ctx) => {
        const p = ctx.get('membership_plans', pid, 'membership plan');
        const ms = ctx.all('memberships').filter((m) => m.planId === pid);
        return { ...p, activeMembers: ms.filter((m) => live(ctx, m)).length, totalMemberships: ms.length };
      },
      example: (ctx) => ({ id: ctx.all('membership_plans')[0].id }),
    },
    {
      id: 'list_membership_plans', name: 'List membership plans', description: 'List/search membership plans by name. Archived plans excluded unless status is given.',
      keywords: ['membership tiers', 'access packages'],
      ...ops.search('membership_plans', {
        text: ['name', 'description'],
        filters: { status: z.enum(['active', 'archived']).optional() },
        where: (r, i) => i.status || r.status !== 'archived',
      }),
      example: () => ({}),
    },
    {
      id: 'update_plan_description', name: 'Update plan description', description: 'Replace the description text of a membership plan.',
      ...ops.set('membership_plans', 'description', z.string().min(1), { what: 'membership plan', guard: activePlan }),
      example: (ctx) => ({ id: ctx.all('membership_plans')[0].id, description: 'Starter access: Social Media Marketing 101 plus the Growth Hackers Club community.' }),
    },
    {
      id: 'add_plan_entitlement', name: 'Add plan entitlement',
      description: 'Include a course or community in a membership plan, so every active member of the plan gets access to it.',
      keywords: ['add course to plan', 'bundle community'],
      risk: 'write',
      input: z.object({ id: id('membership plan'), type: z.enum(ENT_TYPES), refId: id('course or community') }),
      output: plan,
      handler: ({ id: pid, type, refId }, ctx) => {
        const p = ctx.get('membership_plans', pid, 'membership plan');
        activePlan(p);
        const title = resolveRef(ctx, type, refId);
        if (p.entitlements.some((e) => e.refId === refId)) fail('DUPLICATE', `${p.name} already includes ${type} ${refId} (${title})`);
        const added = { id: ctx.newId('ent'), type, refId, title };
        ctx.patch(p, { entitlements: [...p.entitlements, added] });
        return { ...p, added };
      },
      example: (ctx) => {
        const p = ctx.all('membership_plans')[0];
        const c = ctx.all('courses').find((x) => x.status !== 'archived' && !p.entitlements.some((e) => e.refId === x.id));
        return { id: p.id, type: 'course', refId: c.id };
      },
    },
    {
      id: 'remove_plan_entitlement', name: 'Remove plan entitlement',
      description: 'Remove a course or community from a membership plan; its members lose that access (unless another plan grants it) and are removed from that community if it is private.',
      risk: 'destructive',
      input: z.object({ id: id('membership plan'), refId: id('course/community ID (or entitlement ID) to remove') }),
      output: plan,
      handler: ({ id: pid, refId }, ctx) => {
        const p = ctx.get('membership_plans', pid, 'membership plan');
        const removed = p.entitlements.find((e) => e.refId === refId || e.id === refId);
        if (!removed)
          fail('NOT_FOUND', `${p.name} does not include ${refId}; it includes: ${p.entitlements.map((e) => `${e.refId} ${e.title}`).join(', ') || 'nothing'}`);
        ctx.patch(p, { entitlements: p.entitlements.filter((e) => e !== removed) });
        const members = ctx.all('memberships').filter((m) => m.planId === pid && live(ctx, m)).map((m) => m.contactId);
        const removedCommunityMembers = removed.type === 'community' ? pruneCommunityMembers(ctx, [removed.refId], members) : [];
        return { ...p, removed, affectedMembers: members.length, removedCommunityMembers };
      },
      example: (ctx) => {
        const p = ctx.all('membership_plans')[0];
        return { id: p.id, refId: p.entitlements[0].refId };
      },
    },
    {
      id: 'grant_membership', name: 'Grant membership to contact',
      description: 'Give a contact a membership on a plan, granting access to all of the plan\'s courses and communities. For a single course use Enrollments.',
      keywords: ['add member', 'give membership', 'upgrade to vip'],
      risk: 'write',
      input: z.object({
        contactId: id('contact'), planId: id('membership plan'),
        expiresAt: isoDate().optional().describe('access end date; omit for no expiry'),
      }),
      output: membership,
      handler: ({ contactId, planId, expiresAt }, ctx) => {
        const ct = ctx.get('contacts', contactId, 'contact');
        if (ct.status !== 'active') fail('INVALID_STATE', `contact ${contactId} (${ct.name}) is ${ct.status}`);
        const p = ctx.get('membership_plans', planId, 'membership plan');
        activePlan(p);
        const dup = ctx.all('memberships').find((m) => m.contactId === contactId && m.planId === planId && live(ctx, m));
        if (dup) fail('DUPLICATE', `${ct.name} already has an active ${p.name} membership (${dup.id}); extend it with set_membership_expiry instead`, { existingId: dup.id });
        if (isPast(ctx, expiresAt)) fail('VALIDATION', `expiresAt ${expiresAt} is in the past (now ${ctx.now})`);
        return ctx.insert('memberships', { contactId, planId, status: 'active', startedAt: ctx.now, expiresAt: expiresAt ?? null, grantedBy: ctx.actorId });
      },
      example: (ctx) => {
        const p = ctx.all('membership_plans').find((x) => x.status === 'active');
        const ct = ctx.all('contacts').find((c) => c.status === 'active' && !ctx.all('memberships').some((m) => m.contactId === c.id));
        return { contactId: ct.id, planId: p.id };
      },
    },
    {
      id: 'set_membership_expiry', name: 'Set membership expiry',
      description: 'Set or clear (null) when a membership ends. Extending an expired membership reactivates it.',
      keywords: ['extend membership', 'renew membership'],
      risk: 'write',
      input: z.object({ id: id('membership'), expiresAt: isoDate().nullable().describe('when membership access ends; null = never expires') }),
      output: membership,
      handler: ({ id: mid, expiresAt }, ctx) => {
        const m = ctx.get('memberships', mid, 'membership');
        if (m.status === 'revoked') fail('INVALID_STATE', `membership ${mid} is revoked; grant a new membership instead`);
        if (expiresAt && toTime(expiresAt, true) <= toTime(ctx.now))
          fail('VALIDATION', `expiresAt ${expiresAt} is not in the future (now ${ctx.now}); to end access now use revoke_membership`);
        return ctx.patch(m, { expiresAt, ...(m.status === 'expired' ? { status: 'active' } : {}) });
      },
      example: (ctx) => ({ id: ctx.all('memberships').find((m) => m.status === 'expired').id, expiresAt: '2027-11-04' }),
    },
    {
      id: 'revoke_membership', name: 'Revoke membership',
      description: 'End a contact\'s membership now; they lose every course/community access it granted and are removed from its private communities (unless another live membership covers them).',
      keywords: ['cancel membership', 'remove member access'],
      ...(() => {
        const base = ops.transition('memberships', {
          to: 'revoked', from: ['active', 'expired'], risk: 'destructive', what: 'membership',
          extra: (m, i, ctx) => ({ revokedAt: ctx.now, revokedReason: i.reason ?? null }),
        });
        return {
          ...base,
          handler: (inp, ctx) => {
            const m = base.handler(inp, ctx);
            const cmtys = (ctx.find('membership_plans', m.planId)?.entitlements || []).filter((e) => e.type === 'community').map((e) => e.refId);
            return { ...m, removedFromCommunities: pruneCommunityMembers(ctx, cmtys, [m.contactId]).map((r) => r.communityId) };
          },
        };
      })(),
      input: z.object({ id: id('membership'), reason: z.string().optional() }),
      example: (ctx) => ({ id: ctx.all('memberships').find((m) => m.status === 'active').id, reason: 'Cancelled by customer' }),
    },
    {
      id: 'check_member_access', name: 'Check member access',
      description: 'Check whether a contact can access a course or community through a membership plan (respects status and expiry). Public communities are always allowed. Direct course enrollments are in Enrollments.',
      keywords: ['does she have access', 'can access', 'entitled'],
      risk: 'read',
      input: z.object({ contactId: id('contact'), courseId: z.string().optional(), communityId: z.string().optional() }),
      output: z.looseObject({ contactId: z.string(), resourceType: z.string(), resourceId: z.string(), allowed: z.boolean(), via: z.looseObject({}).nullable(), reason: z.string() }),
      handler: ({ contactId, courseId, communityId }, ctx) => {
        if (!courseId === !communityId) fail('VALIDATION', 'provide exactly one of courseId or communityId');
        const ct = ctx.get('contacts', contactId, 'contact');
        const type = courseId ? 'course' : 'community';
        const refId = courseId || communityId;
        const r = ctx.get(TABLE[type], refId, type);
        const base = { contactId, contactName: ct.name, resourceType: type, resourceId: refId, resourceName: r.title || r.name };
        const via = membershipAccess(ctx, contactId, type, refId);
        if (via) return { ...base, allowed: true, via, reason: `granted by active membership ${via.membershipId} on plan ${via.planName}` };
        if (type === 'community' && r.visibility === 'public') return { ...base, allowed: true, via: null, reason: 'public community; no membership required' };
        const mine = ctx.all('memberships').filter((m) => m.contactId === contactId)
          .map((m) => `${m.id} ${ctx.find('membership_plans', m.planId)?.name} (${live(ctx, m) ? 'active' : m.status === 'active' ? `expired ${m.expiresAt}` : m.status})`);
        return {
          ...base, allowed: false, via: null,
          reason: `no live membership grants this ${type}. Contact memberships: ${mine.join(', ') || 'none'}. Plans that include it: ${plansGranting(ctx, type, refId).join(', ') || 'none'}`,
        };
      },
      example: (ctx) => {
        const m = ctx.all('memberships').find((x) => live(ctx, x) && ctx.find('membership_plans', x.planId)?.entitlements.some((e) => e.type === 'community'));
        const e = ctx.find('membership_plans', m.planId).entitlements.find((x) => x.type === 'community');
        return { contactId: m.contactId, communityId: e.refId };
      },
    },
  ],

  seed(ctx, h) {
    const course = (t) => ctx.all('courses').find((c) => c.title === t);
    const cmty = (n) => ctx.all('communities').find((c) => c.name === n);
    const ents = (...refs) => refs.filter(([, r]) => r).map(([type, r]) => ({ id: ctx.newId('ent'), type, refId: r.id, title: r.title || r.name }));
    const smm = course('Social Media Marketing 101');
    const fun = course('Advanced Funnel Building');
    const ghc = cmty('Growth Hackers Club');
    const vip = cmty('VIP Mastermind');
    const basic = ctx.insert('membership_plans', {
      name: 'Basic Membership', description: 'Social Media Marketing 101 and the Growth Hackers Club community.', status: 'active',
      price: 29, currency: 'USD', interval: 'month', entitlements: ents(['course', smm], ['community', ghc]), createdAt: h.daysAgo(220),
    });
    const vipPlan = ctx.insert('membership_plans', {
      name: 'VIP Membership', description: 'All courses plus the private VIP Mastermind community.', status: 'active',
      price: 199, currency: 'USD', interval: 'month', entitlements: ents(['course', smm], ['course', fun], ['community', ghc], ['community', vip]), createdAt: h.daysAgo(210),
    });
    const legacy = ctx.insert('membership_plans', {
      name: 'Founders Lifetime', description: 'Legacy lifetime deal, no longer sold.', status: 'archived',
      price: 997, currency: 'USD', interval: 'one_time', entitlements: ents(['course', smm]), createdAt: h.daysAgo(400),
    });
    // [contact, plan, started days ago, status, extra]
    const rows = [
      ['con_001', vipPlan, 200, 'active'],
      ['con_002', basic, 100, 'active'],
      ['con_003', vipPlan, 400, 'expired', { expiresAt: h.daysAgo(10) }],
      ['con_006', vipPlan, 150, 'revoked', { revokedAt: h.daysAgo(30), revokedReason: 'Chargeback' }],
      ['con_010', vipPlan, 20, 'active', { expiresAt: h.daysFromNow(30) }], // VIP but has not joined VIP Mastermind yet
      ['con_020', vipPlan, 90, 'active'],
      ['con_011', basic, 60, 'active'],
      ['con_012', basic, 45, 'active', { expiresAt: h.daysFromNow(60) }],
      ['con_015', basic, 380, 'expired', { expiresAt: h.daysAgo(15) }],
      ['con_025', legacy, 500, 'active'],
    ];
    for (const [contactId, p, ago, status, extra = {}] of rows) {
      const startedAt = h.daysAgo(ago);
      ctx.insert('memberships', { contactId, planId: p.id, status, startedAt, expiresAt: null, grantedBy: 'usr_001', createdAt: startedAt, ...extra });
    }
  },
});
