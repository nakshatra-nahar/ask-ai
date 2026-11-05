import { defineModule, ops, z, id, entity, fail } from '../kit.js';
import { membershipAccess } from './m44-memberships.js';

const community = entity({
  name: z.string(), description: z.string().nullable().optional(), visibility: z.enum(['public', 'private']),
  guidelines: z.string().nullable().optional(), status: z.enum(['active', 'archived']),
  channels: z.array(z.looseObject({ id: z.string(), name: z.string() })),
  members: z.array(z.looseObject({ contactId: z.string(), role: z.string(), joinedAt: z.string() })),
});
const post = entity({
  communityId: z.string(), channelId: z.string(), authorId: z.string(), title: z.string().nullable().optional(), body: z.string(),
  status: z.enum(['published', 'removed']), pinned: z.boolean(), reports: z.number(), reportReasons: z.array(z.string()),
  replies: z.array(z.looseObject({ id: z.string(), authorId: z.string(), body: z.string() })),
});
const MAX_PINNED = 3;

const assertActive = (c) => {
  if (c.status !== 'active') fail('INVALID_STATE', `community ${c.id} (${c.name}) is ${c.status}`);
};
const getCommunity = (ctx, cid) => ctx.get('communities', cid, 'community');
const isMember = (c, contactId) => c.members.some((m) => m.contactId === contactId);
const getPost = (ctx, pid) => ctx.get('community_posts', pid, 'community post');
const requireMember = (ctx, c, contactId) => {
  ctx.get('contacts', contactId, 'contact');
  if (!isMember(c, contactId)) fail('PERMISSION', `contact ${contactId} is not a member of ${c.name}; add them with join_community first`);
};

export default defineModule({
  id: 'communities',
  code: 'M43',
  name: 'Communities',
  description: 'Operate discussion spaces and moderate content.',
  tables: {
    communities: { prefix: 'cmty', schema: community },
    community_posts: { prefix: 'post', schema: post },
  },
  actions: [
    {
      id: 'create_community', name: 'Create community',
      description: 'Create an online discussion community (group/forum) with a default "general" channel. Private communities are joined via a membership plan.',
      keywords: ['new group', 'forum', 'discussion space'],
      ...ops.create('communities', {
        input: z.object({
          name: z.string().min(1), description: z.string().optional(),
          visibility: z.enum(['public', 'private']).default('public').describe('private = only contacts with a membership plan that includes it can join'),
          guidelines: z.string().optional(),
        }),
        check: (i, ctx) => {
          const dup = ctx.all('communities').find((c) => c.name.toLowerCase() === i.name.toLowerCase());
          if (dup) fail('DUPLICATE', `a community named '${i.name}' already exists (${dup.id}, ${dup.status})`, { existingId: dup.id });
        },
        build: (i, ctx) => ({
          description: i.description ?? null, guidelines: i.guidelines ?? null, status: 'active', members: [],
          channels: [{ id: ctx.newId('chan'), name: 'general', description: 'General discussion' }],
        }),
      }),
      example: () => ({ name: 'Funnel Builders Circle', description: 'Share and critique funnels.', visibility: 'public' }),
    },
    {
      id: 'get_community', name: 'Get community details', description: 'Fetch a community with its channels (post counts), members (names, roles) and guidelines.',
      risk: 'read',
      input: z.object({ id: id('community') }),
      output: community,
      handler: ({ id: cid }, ctx) => {
        const c = getCommunity(ctx, cid);
        const posts = ctx.all('community_posts').filter((p) => p.communityId === cid && p.status === 'published');
        return {
          ...c, memberCount: c.members.length,
          members: c.members.map((m) => ({ ...m, name: ctx.find('contacts', m.contactId)?.name })),
          channels: c.channels.map((ch) => ({ ...ch, postCount: posts.filter((p) => p.channelId === ch.id).length })),
          pinnedPostIds: posts.filter((p) => p.pinned).map((p) => p.id),
          reportedPostIds: posts.filter((p) => p.reports > 0).map((p) => p.id),
        };
      },
      example: (ctx) => ({ id: ctx.all('communities')[0].id }),
    },
    {
      id: 'update_community_guidelines', name: 'Update community guidelines', description: 'Replace the code-of-conduct / posting rules text of a community.',
      keywords: ['community rules', 'code of conduct'],
      ...ops.set('communities', 'guidelines', z.string().min(1), { what: 'community', guard: assertActive }),
      example: (ctx) => ({ id: ctx.all('communities')[0].id, guidelines: 'Be kind. No self-promotion outside #wins. No DMs selling services.' }),
    },
    {
      id: 'create_channel', name: 'Create discussion channel', description: 'Add a topic channel (e.g. "wins", "questions") to a community.',
      keywords: ['new channel', 'topic', 'sub-forum'],
      ...ops.addItem('communities', 'channels', { name: z.string().min(1).describe('channel name, e.g. "introductions"'), description: z.string().optional() }, {
        prefix: 'chan', what: 'community',
        guard: (c, item) => {
          assertActive(c);
          const dup = c.channels.find((ch) => ch.name.toLowerCase() === item.name.toLowerCase());
          if (dup) fail('DUPLICATE', `${c.name} already has a channel '${dup.name}' (${dup.id})`, { existingId: dup.id });
        },
      }),
      example: (ctx) => ({ id: ctx.all('communities')[0].id, name: 'introductions', description: 'Say hello' }),
    },
    {
      id: 'join_community', name: 'Join community',
      description: 'Add a contact as a member of a discussion community. Private communities require a live membership whose plan includes the community. Not a course enrollment.',
      keywords: ['add member to community', 'add to group'],
      risk: 'write',
      input: z.object({ id: id('community'), contactId: id('contact') }),
      output: community,
      handler: ({ id: cid, contactId }, ctx) => {
        const c = getCommunity(ctx, cid);
        assertActive(c);
        const ct = ctx.get('contacts', contactId, 'contact');
        if (isMember(c, contactId)) fail('DUPLICATE', `${ct.name} is already a member of ${c.name}`);
        let via = null;
        if (c.visibility === 'private') {
          via = membershipAccess(ctx, contactId, 'community', cid);
          if (!via) {
            const plans = ctx.all('membership_plans').filter((p) => p.entitlements?.some((e) => e.type === 'community' && e.refId === cid)).map((p) => `${p.id} ${p.name}`);
            fail('PERMISSION', `${c.name} is private: ${ct.name} needs an active, unexpired membership on a plan that includes it (${plans.join(', ') || 'no plan includes it yet'}). Grant one with memberships.grant_membership first`);
          }
        }
        c.members.push({ contactId, role: 'member', joinedAt: ctx.now, viaMembershipId: via?.membershipId ?? null });
        ctx.patch(c, {});
        return { ...c, joined: { contactId, name: ct.name, via } };
      },
      example: (ctx) => {
        const c = ctx.all('communities').find((x) => x.status === 'active' && x.visibility === 'public');
        return { id: c.id, contactId: ctx.all('contacts').find((p) => !isMember(c, p.id)).id };
      },
    },
    {
      id: 'leave_community', name: 'Leave community', description: 'Remove a contact from a community\'s member list (their posts stay).',
      keywords: ['remove member from community', 'kick'],
      risk: 'write',
      input: z.object({ id: id('community'), contactId: id('contact') }),
      output: community,
      handler: ({ id: cid, contactId }, ctx) => {
        const c = getCommunity(ctx, cid);
        if (!isMember(c, contactId)) fail('NOT_FOUND', `contact ${contactId} is not a member of ${c.name}`);
        return ctx.patch(c, { members: c.members.filter((m) => m.contactId !== contactId) });
      },
      example: (ctx) => {
        const c = ctx.all('communities')[0];
        return { id: c.id, contactId: c.members.at(-1).contactId };
      },
    },
    {
      id: 'create_post', name: 'Create community post', description: 'Publish a new discussion post in a community channel. The author contact must be a member.',
      keywords: ['post in community', 'start discussion', 'new thread'],
      risk: 'write',
      input: z.object({
        communityId: id('community'), channelId: id('channel (chan_###)'), authorId: id('author contact (must be a member)'),
        title: z.string().optional(), body: z.string().min(1),
      }),
      output: post,
      handler: (i, ctx) => {
        const c = getCommunity(ctx, i.communityId);
        assertActive(c);
        if (!c.channels.some((ch) => ch.id === i.channelId))
          fail('NOT_FOUND', `channel ${i.channelId} not found in ${c.name}; channels: ${c.channels.map((ch) => `${ch.id} #${ch.name}`).join(', ')}`);
        requireMember(ctx, c, i.authorId);
        return ctx.insert('community_posts', { ...i, title: i.title ?? null, status: 'published', pinned: false, reports: 0, reportReasons: [], replies: [] });
      },
      example: (ctx) => {
        const c = ctx.all('communities')[0];
        return { communityId: c.id, channelId: c.channels[0].id, authorId: c.members[0].contactId, title: 'Weekly check-in', body: 'What are you working on this week?' };
      },
    },
    {
      id: 'reply_to_post', name: 'Reply to community post', description: 'Add a reply/comment to a published community post. The replying contact must be a member.',
      keywords: ['comment on post', 'respond to thread'],
      risk: 'write',
      input: z.object({ id: id('community post'), authorId: id('replying contact'), body: z.string().min(1) }),
      output: post,
      handler: ({ id: pid, authorId, body }, ctx) => {
        const p = getPost(ctx, pid);
        if (p.status !== 'published') fail('INVALID_STATE', `post ${pid} was removed by moderation; replies are closed`);
        const c = getCommunity(ctx, p.communityId);
        assertActive(c);
        requireMember(ctx, c, authorId);
        const added = { id: ctx.newId('rply'), authorId, body, createdAt: ctx.now };
        ctx.patch(p, { replies: [...p.replies, added] });
        return { ...p, added };
      },
      example: (ctx) => {
        const p = ctx.all('community_posts').find((x) => x.status === 'published');
        const c = ctx.find('communities', p.communityId);
        return { id: p.id, authorId: c.members.find((m) => m.contactId !== p.authorId).contactId, body: 'Great question, following!' };
      },
    },
    {
      id: 'pin_post', name: 'Pin community post', description: `Pin (or unpin with pinned:false) a post at the top of its channel. Max ${MAX_PINNED} pinned posts per channel.`,
      keywords: ['feature post', 'sticky', 'unpin'],
      risk: 'write',
      input: z.object({ id: id('community post'), pinned: z.boolean().default(true).describe('false to unpin') }),
      output: post,
      handler: ({ id: pid, pinned }, ctx) => {
        const p = getPost(ctx, pid);
        if (p.status !== 'published') fail('INVALID_STATE', `post ${pid} was removed and cannot be pinned`);
        if (p.pinned === pinned) fail('INVALID_STATE', `post ${pid} is already ${pinned ? 'pinned' : 'unpinned'}`);
        if (pinned) {
          const others = ctx.all('community_posts').filter((x) => x.channelId === p.channelId && x.pinned && x.status === 'published');
          if (others.length >= MAX_PINNED)
            fail('LIMIT_EXCEEDED', `channel already has ${others.length} pinned posts (${others.map((x) => x.id).join(', ')}); unpin one first`);
        }
        return ctx.patch(p, { pinned, pinnedAt: pinned ? ctx.now : null });
      },
      example: (ctx) => ({ id: ctx.all('community_posts').find((x) => x.status === 'published' && !x.pinned).id }),
    },
    {
      id: 'remove_reported_post', name: 'Remove reported post',
      description: 'Moderation: take down a community post that members reported, recording the reason. Posts without reports need force:true.',
      keywords: ['delete post', 'moderate', 'take down', 'spam'],
      risk: 'destructive',
      input: z.object({
        id: id('community post'), reason: z.string().min(1).describe('moderation reason, e.g. spam, harassment'),
        force: z.boolean().default(false).describe('remove even if the post has no reports'),
      }),
      output: post,
      handler: ({ id: pid, reason, force }, ctx) => {
        const p = getPost(ctx, pid);
        if (p.status === 'removed') fail('INVALID_STATE', `post ${pid} was already removed on ${p.removedAt} (${p.removedReason})`);
        if (!p.reports && !force) fail('INVALID_STATE', `post ${pid} has no reports; pass force:true to remove it anyway`);
        return ctx.patch(p, { status: 'removed', pinned: false, removedReason: reason, removedAt: ctx.now, removedBy: ctx.actorId });
      },
      example: (ctx) => ({ id: ctx.all('community_posts').find((x) => x.status === 'published' && x.reports > 0).id, reason: 'Spam: selling followers' }),
    },
  ],

  seed(ctx, h) {
    const chans = (...rows) => rows.map(([name, description]) => ({ id: ctx.newId('chan'), name, description }));
    const mems = (ids, from) => ids.map((contactId, i) => ({ contactId, role: i === 0 ? 'moderator' : 'member', joinedAt: h.daysAgo(from - i * 4), viaMembershipId: null }));
    const ghc = ctx.insert('communities', {
      name: 'Growth Hackers Club', description: 'Open community for marketers swapping growth tactics.', visibility: 'public',
      guidelines: 'Be respectful. No spam or follower-selling. Keep promos in #wins.', status: 'active',
      channels: chans(['general', 'General discussion'], ['wins', 'Share results'], ['questions', 'Ask the community']),
      members: mems(['con_001', 'con_002', 'con_003', 'con_005', 'con_007', 'con_008', 'con_011', 'con_012', 'con_015', 'con_020'], 110),
      createdAt: h.daysAgo(130),
    });
    const vip = ctx.insert('communities', {
      name: 'VIP Mastermind', description: 'Private mastermind for VIP Membership holders.', visibility: 'private',
      guidelines: 'Confidential: what is shared here stays here.', status: 'active',
      channels: chans(['general', 'General discussion'], ['hot-seat', 'Get feedback on your business']),
      members: mems(['con_001', 'con_020'], 100), createdAt: h.daysAgo(120),
    });
    ctx.insert('communities', {
      name: 'Beta Testers Lounge', description: 'Closed beta feedback group (ended).', visibility: 'private', guidelines: null, status: 'archived',
      channels: chans(['general', 'General discussion']), members: mems(['con_004'], 300), createdAt: h.daysAgo(320),
    });
    const P = (c, ch, authorId, title, body, extra = {}) =>
      ctx.insert('community_posts', {
        communityId: c.id, channelId: c.channels.find((x) => x.name === ch).id, authorId, title, body, status: 'published',
        pinned: false, reports: 0, reportReasons: [], replies: [], createdAt: h.daysAgo(h.int(2, 60)), ...extra,
      });
    P(ghc, 'general', 'con_001', 'Welcome! Introduce yourself', 'Tell us what you are building and your #1 growth channel.', { pinned: true, pinnedAt: h.daysAgo(90) });
    P(ghc, 'wins', 'con_002', 'Hit 10k followers', 'The content calendar lesson from Social Media Marketing 101 got me to 10k.', {
      replies: [{ id: ctx.newId('rply'), authorId: 'con_003', body: 'Congrats!', createdAt: h.daysAgo(5) }, { id: ctx.newId('rply'), authorId: 'con_011', body: 'What posting cadence?', createdAt: h.daysAgo(4) }],
    });
    P(ghc, 'questions', 'con_003', 'Best time to post on LinkedIn?', 'Seeing low reach on weekday evenings. Any data?');
    P(ghc, 'general', 'con_007', 'Cheap followers!!!', 'DM me for 5k followers for $20, guaranteed.', { reports: 3, reportReasons: ['spam', 'spam', 'scam'] });
    P(ghc, 'questions', 'con_008', 'Funnel tool recommendations?', 'Which tools are you using for landing pages?');
    P(ghc, 'general', 'con_012', 'Off-topic rant', 'Removed content.', { status: 'removed', reports: 2, reportReasons: ['harassment', 'harassment'], removedReason: 'Harassment', removedAt: h.daysAgo(6), removedBy: 'usr_006' });
    P(vip, 'general', 'con_001', 'Q4 mastermind agenda', 'Agenda for this quarter: offers, pricing, hiring.', { pinned: true, pinnedAt: h.daysAgo(30) });
    P(vip, 'hot-seat', 'con_020', 'Hot seat: scaling my agency to $50k/mo', 'Looking for feedback on my pricing tiers.');
  },
});
