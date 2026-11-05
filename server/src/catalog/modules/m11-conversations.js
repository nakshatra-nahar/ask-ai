import { defineModule, ops, z, id, entity, isoDate, limit, listOf, fail, page, matchFilters } from '../kit.js';

const CHANNELS = ['sms', 'email', 'webchat'];
const ns = z.string().nullable().optional();
const conversation = entity({
  contactId: ns, channel: z.enum(CHANNELS), status: z.enum(['open', 'closed']), unread: z.boolean(), ownerId: ns,
  lastMessageAt: ns, lastInboundAt: ns, lastOutboundAt: ns, lastDirection: z.enum(['inbound', 'outbound']).nullable().optional(),
  comments: z.array(z.looseObject({ id: z.string(), body: z.string() })),
});
const HOUR = 36e5;
const DAY = 864e5;
const BIZ = { sms: '+1-555-0100', email: 'hello@acme.test', webchat: 'acme-webchat' };

const msgTime = (m) => m.sentAt || m.scheduledAt || m.createdAt;
const thread = (ctx, cid) => ctx.all('messages').filter((m) => m.conversationId === cid).sort((a, b) => Date.parse(msgTime(a)) - Date.parse(msgTime(b)));
const contactName = (ctx, cid) => (cid && ctx.find('contacts', cid)?.name) || null;
const hoursAgo = (ctx, iso) => Math.round(((Date.parse(ctx.now) - Date.parse(iso)) / HOUR) * 10) / 10;
const excerpt = (s = '') => (s.length > 140 ? `${s.slice(0, 137)}...` : s);
const byLastDesc = (a, b) => Date.parse(b.lastMessageAt || b.createdAt) - Date.parse(a.lastMessageAt || a.createdAt);

/** Find-or-create the contact's conversation on a channel and record a new message on it. Used by sms/email send & receive. */
export function touchConversation(ctx, { contactId, channel, direction, at = ctx.now }) {
  let c = ctx.all('conversations').filter((x) => x.contactId === contactId && x.channel === channel).sort(byLastDesc)[0];
  c ||= ctx.insert('conversations', {
    contactId, channel, status: 'open', unread: false, ownerId: ctx.find('contacts', contactId)?.ownerId ?? null,
    lastMessageAt: null, lastInboundAt: null, lastOutboundAt: null, lastDirection: null, comments: [],
  });
  const inbound = direction === 'inbound';
  return ctx.patch(c, {
    lastMessageAt: at, lastDirection: direction, [inbound ? 'lastInboundAt' : 'lastOutboundAt']: at,
    unread: inbound, ...(inbound && c.status === 'closed' ? { status: 'open', closedAt: null } : {}),
  });
}

const setUnread = (to) => ({
  risk: 'write',
  input: z.object({ id: id('conversation') }),
  output: conversation,
  handler: ({ id: cid }, ctx) => {
    const c = ctx.get('conversations', cid, 'conversation');
    if (c.unread === to) fail('INVALID_STATE', `conversation ${c.id} is already ${to ? 'unread' : 'read'}; nothing to change`);
    return ctx.patch(c, { unread: to });
  },
});
const first = (ctx, pred) => ctx.all('conversations').find(pred).id;

export default defineModule({
  id: 'conversations',
  code: 'M11',
  name: 'Conversations',
  description: 'Manage conversation threads across channels.',
  tables: { conversations: { prefix: 'cnv', schema: conversation } },
  actions: [
    {
      id: 'get_conversation', name: 'Get conversation',
      description: 'Fetch one conversation thread (any channel) with its full message history in chronological order, plus internal comments.',
      keywords: ['thread', 'chat history', 'message history', 'inbox thread'],
      risk: 'read',
      input: z.object({ id: id('conversation') }),
      output: conversation.extend({ messages: z.array(z.looseObject({ id: z.string(), direction: z.string() })) }),
      handler: ({ id: cid }, ctx) => {
        const c = ctx.get('conversations', cid, 'conversation');
        return { ...c, contactName: contactName(ctx, c.contactId), messages: thread(ctx, c.id) };
      },
      example: (ctx) => ({ id: ctx.all('conversations')[0].id }),
    },
    {
      id: 'search_conversations', name: 'Search conversations',
      description: 'Find inbox conversation threads (one per contact+channel) by contact(s), channel, open/closed, unread, owner, who wrote last, last-message date range, or whether the contact ever replied. Use this for "who replied / who has not replied" questions; to find individual messages use sms.search_sms_messages or email.search_email_messages.',
      keywords: ['inbox', 'who replied', 'not replied', 'no response', 'threads'],
      risk: 'read',
      input: z.object({
        contactId: z.string().optional(), contactIds: z.array(z.string()).optional().describe('match any of these contact IDs'),
        channel: z.enum(CHANNELS).optional(), status: z.enum(['open', 'closed']).optional(), unread: z.boolean().optional(), ownerId: z.string().optional(),
        lastDirection: z.enum(['inbound', 'outbound']).optional().describe('inbound = contact wrote last (awaiting our reply); outbound = we wrote last'),
        lastMessageAtAfter: isoDate().optional(), lastMessageAtBefore: isoDate().optional(),
        hasInboundReply: z.boolean().optional().describe('true = the contact has sent at least one message in the thread; false = never replied'),
        limit,
      }),
      output: listOf(conversation),
      handler: ({ hasInboundReply, limit: lim, ...f }, ctx) => {
        const rows = ctx.all('conversations')
          .filter((r) => matchFilters(r, f) && (hasInboundReply === undefined || Boolean(r.lastInboundAt) === hasInboundReply))
          .sort(byLastDesc)
          .map((r) => ({ ...r, contactName: contactName(ctx, r.contactId) }));
        return page(rows, lim);
      },
      example: () => ({ status: 'open', lastDirection: 'inbound' }),
    },
    {
      id: 'assign_conversation_owner', name: 'Assign conversation owner',
      description: 'Assign a conversation thread to a staff user (must be active) who is responsible for replying. Does not change the contact owner.',
      keywords: ['route conversation', 'hand off chat'],
      ...ops.set('conversations', 'ownerId', id('user'), {
        param: 'ownerId', what: 'conversation',
        guard: (c, i, ctx) => {
          const u = ctx.get('users', i.ownerId, 'user');
          if (u.status !== 'active') fail('INVALID_STATE', `user ${u.id} (${u.name}) is ${u.status} and cannot own conversations; pick an active user`);
          if (u.outOfOffice) fail('INVALID_STATE', `user ${u.id} (${u.name}) is out of office; pick an available user`);
        },
      }),
      example: (ctx) => {
        const c = ctx.all('conversations')[0];
        return { id: c.id, ownerId: c.ownerId === 'usr_003' ? 'usr_002' : 'usr_003' };
      },
    },
    {
      id: 'mark_conversation_read', name: 'Mark conversation read', description: 'Clear the unread flag on a conversation (does not reply to the contact).',
      ...setUnread(false),
      example: (ctx) => ({ id: first(ctx, (c) => c.unread) }),
    },
    {
      id: 'mark_conversation_unread', name: 'Mark conversation unread', description: 'Flag a conversation as unread so it resurfaces in the inbox.',
      ...setUnread(true),
      example: (ctx) => ({ id: first(ctx, (c) => !c.unread) }),
    },
    {
      id: 'close_conversation', name: 'Close conversation',
      description: 'Close (resolve) an open conversation and clear its unread flag. A new inbound message reopens it automatically.',
      keywords: ['resolve conversation', 'archive thread', 'done'],
      ...ops.transition('conversations', { to: 'closed', from: ['open'], what: 'conversation', extra: (r, i, ctx) => ({ unread: false, closedAt: ctx.now }) }),
      example: (ctx) => ({ id: first(ctx, (c) => c.status === 'open') }),
    },
    {
      id: 'reopen_conversation', name: 'Reopen conversation', description: 'Reopen a closed conversation thread.',
      ...ops.transition('conversations', { to: 'open', from: ['closed'], what: 'conversation', extra: () => ({ closedAt: null }) }),
      example: (ctx) => ({ id: first(ctx, (c) => c.status === 'closed') }),
    },
    {
      id: 'add_internal_comment', name: 'Add internal comment',
      description: 'Add a staff-only internal comment to a conversation thread (never sent to the contact). For CRM notes on a record use the notes module instead.',
      keywords: ['internal note', 'whisper', 'mention teammate'],
      risk: 'write',
      input: z.object({ id: id('conversation'), body: z.string().min(1), mentionUserIds: z.array(z.string()).optional().describe('users to @mention') }),
      output: conversation.extend({ added: z.looseObject({ id: z.string() }) }),
      handler: ({ id: cid, body, mentionUserIds = [] }, ctx) => {
        const c = ctx.get('conversations', cid, 'conversation');
        mentionUserIds.forEach((u) => ctx.get('users', u, 'user'));
        const added = { id: ctx.newId('cmt'), body, authorId: ctx.actorId, at: ctx.now, mentionUserIds };
        (c.comments ||= []).push(added);
        ctx.patch(c, {});
        return { ...c, added };
      },
      example: (ctx) => ({ id: ctx.all('conversations')[0].id, body: 'Customer prefers a call after 3pm.' }),
    },
    {
      id: 'summarize_conversation', name: 'Summarize conversation history',
      description: 'Deterministic summary of one conversation: inbound/outbound counts, first/last message dates, last inbound and outbound excerpts, and whether it is awaiting our reply or the contact\'s.',
      keywords: ['recap', 'tl;dr', 'conversation summary'],
      risk: 'read',
      input: z.object({ id: id('conversation') }),
      output: z.looseObject({ conversationId: z.string(), totalMessages: z.number(), inboundCount: z.number(), outboundCount: z.number(), awaiting: z.enum(['us', 'contact', 'none']), summary: z.string() }),
      handler: ({ id: cid }, ctx) => {
        const c = ctx.get('conversations', cid, 'conversation');
        const msgs = thread(ctx, c.id).filter((m) => !['draft', 'scheduled', 'cancelled'].includes(m.status));
        const live = msgs.filter((m) => m.status !== 'failed');
        const inbound = msgs.filter((m) => m.direction === 'inbound');
        const outbound = msgs.filter((m) => m.direction === 'outbound');
        const last = live.at(-1);
        const ex = (m) => m && { messageId: m.id, at: msgTime(m), excerpt: excerpt(m.body) };
        const who = contactName(ctx, c.contactId) || 'the contact';
        const awaiting = !last ? 'none' : last.direction === 'inbound' ? 'us' : 'contact';
        const hrs = last ? hoursAgo(ctx, msgTime(last)) : null;
        const summary = !msgs.length
          ? `No messages yet in this ${c.channel} conversation with ${who}.`
          : `${msgs.length} ${c.channel} messages with ${who} (${inbound.length} inbound, ${outbound.length} outbound) from ${msgTime(msgs[0]).slice(0, 10)} to ${msgTime(msgs.at(-1)).slice(0, 10)}. ` +
            (awaiting === 'none' ? 'No message was delivered (all outbound attempts failed).' : awaiting === 'us' ? `${who} wrote last ${hrs}h ago — awaiting our reply.` : `We wrote last ${hrs}h ago — awaiting ${who}'s reply.`) +
            (c.status === 'closed' ? ' Conversation is closed.' : '');
        return {
          conversationId: c.id, contactId: c.contactId, contactName: contactName(ctx, c.contactId), channel: c.channel, status: c.status,
          totalMessages: msgs.length, inboundCount: inbound.length, outboundCount: outbound.length, failedCount: msgs.length - live.length,
          firstMessageAt: msgs[0] ? msgTime(msgs[0]) : null, lastMessageAt: last ? msgTime(last) : null,
          lastInbound: ex(inbound.at(-1)) ?? null, lastOutbound: ex(outbound.at(-1)) ?? null, awaiting, hoursSinceLastMessage: hrs, summary,
        };
      },
      example: (ctx) => ({ id: ctx.all('conversations')[0].id }),
    },
    {
      id: 'list_unanswered_conversations', name: 'List unanswered conversations',
      description: 'Open conversations where the contact wrote last and we have not replied yet, longest-waiting first, with hoursWaiting and the last inbound message excerpt.',
      keywords: ['needs reply', 'awaiting response', 'backlog', 'sla'],
      risk: 'read',
      input: z.object({
        channel: z.enum(CHANNELS).optional(), ownerId: z.string().optional(),
        minHoursWaiting: z.number().nonnegative().optional().describe('only conversations waiting at least this many hours'), limit,
      }),
      output: listOf(conversation.extend({ hoursWaiting: z.number() })),
      handler: (i, ctx) => {
        const rows = ctx.all('conversations')
          .filter((c) => c.status === 'open' && c.lastDirection === 'inbound' && (!i.channel || c.channel === i.channel) && (!i.ownerId || c.ownerId === i.ownerId))
          .map((c) => {
            const lastIn = thread(ctx, c.id).filter((m) => m.direction === 'inbound').at(-1);
            return { ...c, contactName: contactName(ctx, c.contactId), hoursWaiting: hoursAgo(ctx, c.lastInboundAt || c.lastMessageAt), lastInboundExcerpt: excerpt(lastIn?.body) };
          })
          .filter((c) => c.hoursWaiting >= (i.minHoursWaiting ?? 0))
          .sort((a, b) => b.hoursWaiting - a.hoursWaiting);
        return page(rows, i.limit);
      },
      example: () => ({}),
    },
  ],

  seed(ctx, h) {
    const NOWT = Date.parse(ctx.now);
    const iso = (t) => new Date(Math.round(t / 6e4) * 6e4).toISOString();
    const conv = (who, channel, extra) => ctx.insert('conversations', {
      contactId: who?.id ?? null, channel, status: 'open', unread: false, ownerId: who?.ownerId ?? null,
      lastMessageAt: null, lastInboundAt: null, lastOutboundAt: null, lastDirection: null, comments: [], ...extra,
    });
    const say = (cnv, who, direction, t, body, extra = {}) => {
      const at = iso(t);
      const inbound = direction === 'inbound';
      const addr = cnv.channel === 'email' ? who?.email : cnv.channel === 'sms' ? who?.phone : who?.name;
      ctx.insert('messages', {
        channel: cnv.channel, direction, contactId: cnv.contactId, conversationId: cnv.id,
        to: inbound ? BIZ[cnv.channel] : addr ?? null, from: inbound ? addr ?? null : BIZ[cnv.channel],
        subject: cnv.channel === 'email' ? (inbound ? 'Re: ' : '') + (extra.subject || 'Following up on your inquiry') : null, body,
        status: inbound ? 'received' : 'delivered', scheduledAt: null, sentAt: at, deliveredAt: at, failureReason: null, templateId: null,
        relatedType: extra.relatedType ?? null, relatedId: extra.relatedId ?? null, purpose: extra.purpose ?? null, createdAt: at,
      });
      Object.assign(cnv, { lastMessageAt: at, lastDirection: direction, [inbound ? 'lastInboundAt' : 'lastOutboundAt']: at, unread: inbound, updatedAt: at });
    };
    const leadReplies = ['Thanks! Tomorrow afternoon works for a call.', "Yes, I'm interested. Can you send more details?", 'Could we talk next week instead?', 'Sounds good, what does pricing look like?'];
    const questions = [
      'Hi, can you send me pricing for the premium package?', 'Is there any availability this Friday afternoon?',
      'I was charged twice this month, can someone look into it?', 'Can I reschedule my appointment to next week?',
      'Do you offer a discount for annual plans?', 'Hello? Still waiting to hear back about my quote.',
    ];
    const answers = ['Thanks for reaching out! Happy to help with that.', 'Got it, I have updated that for you.', 'Great question, I will send the details shortly.', 'You are all set. Let us know if you need anything else!'];

    // Eval fixture: every lead created in the last 14 days got an outbound follow-up ~1 day later;
    // leads at odd positions (in ctx.all('leads') order) replied, even positions never replied.
    const recent = ctx.all('leads').filter((l) => NOWT - Date.parse(l.createdAt) <= 14 * DAY && Date.parse(l.createdAt) <= NOWT);
    recent.forEach((lead, i) => {
      const c = lead.contactId ? ctx.find('contacts', lead.contactId) : null;
      const who = c ?? { name: lead.name, email: lead.email, phone: lead.phone };
      const channel = i % 2 === 0 && who.phone && c?.preferences?.sms !== false ? 'sms' : 'email';
      const t0 = Date.parse(lead.createdAt);
      const out = t0 + Math.min(DAY, (NOWT - t0) / 2);
      const cnv = conv(c, channel, { leadId: lead.id, ownerId: lead.ownerId ?? c?.ownerId ?? null, createdAt: iso(out) });
      const firstName = (who.firstName || who.name || '').split(' ')[0] || 'there';
      say(cnv, who, 'outbound', out, `Hi ${firstName}, thanks for your interest in Acme! Do you have 15 minutes this week for a quick call?`, { purpose: 'follow_up', relatedType: 'leads', relatedId: lead.id });
      if (i % 2 === 1) say(cnv, who, 'inbound', out + Math.min(h.int(2, 20) * HOUR, (NOWT - out) / 2), h.pick(leadReplies));
    });

    // ~25 general conversations: 6 unanswered (contact wrote last, unread), 4 closed, the rest awaiting the contact.
    const leadContacts = new Set(recent.map((l) => l.contactId));
    const others = ctx.all('contacts').filter((c) => c.status === 'active' && !leadContacts.has(c.id)).slice(0, 25);
    const waits = [3, 9, 20, 30, 52, 100];
    others.forEach((c, k) => {
      const channel = k % 6 === 5 ? 'webchat' : k % 2 === 0 && c.phone && c.preferences?.sms !== false ? 'sms' : 'email';
      if (k < 6) {
        const last = NOWT - waits[k] * HOUR;
        const cnv = conv(c, channel, { createdAt: iso(last - 3 * DAY) });
        say(cnv, c, 'outbound', last - 3 * DAY, `Hi ${c.firstName}, just checking in. Anything we can help with?`);
        say(cnv, c, 'inbound', last, questions[k]);
      } else {
        const start = NOWT - (k < 10 ? h.int(20, 60) : h.int(2, 30)) * DAY;
        const cnv = conv(c, channel, { createdAt: iso(start) });
        const turns = k % 3 === 0 ? 2 : 1;
        for (let j = 0; j < turns; j++) {
          say(cnv, c, 'inbound', start + j * DAY, h.pick(questions));
          say(cnv, c, 'outbound', start + j * DAY + h.int(1, 6) * HOUR, h.pick(answers));
        }
        if (k < 10) Object.assign(cnv, { status: 'closed', closedAt: cnv.lastMessageAt });
        if (k === 12) cnv.comments.push({ id: ctx.newId('cmt'), body: 'VIP — loop in Alex before quoting.', authorId: 'usr_002', at: cnv.lastMessageAt, mentionUserIds: ['usr_001'] });
      }
    });
  },
});
