import { defineModule, ops, z, id, entity, isoDate, fail, limit, listOf, page, textMatch, matchFilters } from '../kit.js';
import { touchConversation } from './m11-conversations.js';

const PRIORITIES = ['urgent', 'high', 'normal', 'low'];
const SLA_HOURS = { urgent: 4, high: 8, normal: 24, low: 72 };
const STATUSES = ['new', 'open', 'pending', 'resolved', 'closed'];
const NEXT = { new: ['open', 'pending', 'resolved'], open: ['pending', 'resolved'], pending: ['open', 'resolved'], resolved: ['open', 'closed'], closed: [] };
const CHANNELS = ['email', 'chat', 'phone', 'web'];

const ticket = entity({
  subject: z.string(), description: z.string().nullable().optional(), contactId: z.string().nullable(), ownerId: z.string().nullable(),
  priority: z.enum(PRIORITIES), status: z.enum(STATUSES), channel: z.enum(CHANNELS), slaDueAt: z.string(),
  firstResponseAt: z.string().nullable().optional(), resolvedAt: z.string().nullable().optional(), closedAt: z.string().nullable().optional(),
  notes: z.array(z.looseObject({ id: z.string(), body: z.string() })), replies: z.array(z.looseObject({ id: z.string(), body: z.string() })),
});
const plusHours = (iso, h) => new Date(Date.parse(iso) + h * 36e5).toISOString();
// Resolution SLA: breached if resolved after slaDueAt, or still unresolved past it.
const isBreached = (t, now) => Date.parse(t.resolvedAt || now) > Date.parse(t.slaDueAt);
const notClosed = (t) => {
  if (t.status === 'closed') fail('INVALID_STATE', `ticket ${t.id} is closed; closed tickets cannot be changed (create a new ticket instead)`);
};
function activeUser(ctx, uid) {
  const u = ctx.get('users', uid, 'user');
  if (u.status !== 'active') fail('INVALID_STATE', `user ${uid} (${u.name}) is ${u.status} and cannot own tickets`);
  return u;
}
function activeContact(ctx, cid) {
  const c = ctx.get('contacts', cid, 'contact');
  if (c.status === 'merged') fail('INVALID_STATE', `contact ${cid} was merged into ${c.mergedInto}; use that contact instead`);
  if (c.status !== 'active') fail('INVALID_STATE', `contact ${cid} is ${c.status}`);
  return c;
}

export default defineModule({
  id: 'tickets',
  code: 'M47',
  name: 'Support Tickets',
  description: 'Track customer issues and resolution work.',
  tables: { tickets: { prefix: 'tkt', schema: ticket } },
  actions: [
    {
      id: 'create_ticket', name: 'Create support ticket',
      description: 'Open a support ticket for a customer issue. Priority sets the resolution SLA deadline: urgent 4h, high 8h, normal 24h, low 72h. Not a task or a sales opportunity.',
      keywords: ['support case', 'helpdesk', 'complaint', 'issue', 'bug report'],
      ...ops.create('tickets', {
        input: z.object({
          subject: z.string().min(3).max(200), description: z.string().optional(), contactId: z.string().optional(), ownerId: z.string().optional(),
          priority: z.enum(PRIORITIES).default('normal'), channel: z.enum(CHANNELS).default('email'),
        }),
        check: (i, ctx) => {
          if (i.contactId) activeContact(ctx, i.contactId);
          if (i.ownerId) activeUser(ctx, i.ownerId);
        },
        build: (i, ctx) => ({
          description: i.description ?? null, contactId: i.contactId ?? null, ownerId: i.ownerId ?? null, status: i.ownerId ? 'open' : 'new',
          slaDueAt: plusHours(ctx.now, SLA_HOURS[i.priority]), firstResponseAt: null, resolvedAt: null, closedAt: null, notes: [], replies: [],
        }),
      }),
      example: (ctx) => ({ subject: 'Cannot log in to client portal', contactId: ctx.all('contacts')[0].id, priority: 'high' }),
    },
    {
      id: 'get_ticket', name: 'Get ticket details', description: 'Fetch one support ticket with its internal notes and replies.',
      ...ops.get('tickets', { what: 'ticket' }),
      example: (ctx) => ({ id: ctx.all('tickets')[0].id }),
    },
    {
      id: 'search_tickets', name: 'Search tickets',
      description: 'Find support tickets by status, priority, owner, contact, unassigned, SLA breached, created date, or subject text. Most urgent SLA first.',
      keywords: ['open tickets', 'my tickets', 'overdue tickets', 'support queue'],
      risk: 'read',
      input: z.object({
        query: z.string().optional().describe('free text over subject, description'), status: z.enum(STATUSES).optional(), priority: z.enum(PRIORITIES).optional(),
        ownerId: z.string().optional(), contactId: z.string().optional(), channel: z.enum(CHANNELS).optional(),
        unassigned: z.boolean().optional().describe('true = no owner'), breached: z.boolean().optional().describe('true = past SLA deadline'),
        createdAtAfter: isoDate().optional(), createdAtBefore: isoDate().optional(), limit,
      }),
      output: listOf(ticket),
      handler: ({ query, unassigned, breached, limit: lim, ...f }, ctx) => {
        const rows = ctx.all('tickets').filter((t) => textMatch(t, ['subject', 'description'], query) && matchFilters(t, f)
          && (unassigned === undefined || !t.ownerId === unassigned) && (breached === undefined || isBreached(t, ctx.now) === breached));
        return page(rows.sort((a, b) => Date.parse(a.slaDueAt) - Date.parse(b.slaDueAt)), lim);
      },
      example: () => ({ breached: true }),
    },
    {
      id: 'assign_ticket', name: 'Assign ticket owner',
      description: 'Set the support agent who owns a ticket (moves new tickets to open). Owner must be an active user; warns if they lack the support role or are out of office.',
      risk: 'write',
      input: z.object({ id: id('ticket'), ownerId: id('user') }),
      output: z.looseObject({ ticket, warnings: z.array(z.string()) }),
      handler: ({ id: tid, ownerId }, ctx) => {
        const t = ctx.get('tickets', tid, 'ticket');
        notClosed(t);
        const u = activeUser(ctx, ownerId);
        if (t.ownerId === ownerId) fail('DUPLICATE', `ticket ${t.id} is already assigned to ${u.name}`);
        const warnings = [];
        if (!u.roles.includes('support')) warnings.push(`${u.name} does not have the support role`);
        if (u.outOfOffice) warnings.push(`${u.name} is out of office`);
        ctx.patch(t, { ownerId, ...(t.status === 'new' ? { status: 'open' } : {}) });
        return { ticket: t, warnings };
      },
      example: (ctx) => ({ id: ctx.all('tickets').find((t) => !t.ownerId).id, ownerId: 'usr_007' }),
    },
    {
      id: 'set_ticket_priority', name: 'Set ticket priority',
      description: 'Change ticket priority and recompute the SLA deadline from the ticket creation time (raising priority on an old ticket can breach it immediately).',
      risk: 'write',
      input: z.object({ id: id('ticket'), priority: z.enum(PRIORITIES) }),
      output: ticket,
      handler: ({ id: tid, priority }, ctx) => {
        const t = ctx.get('tickets', tid, 'ticket');
        if (['resolved', 'closed'].includes(t.status)) fail('INVALID_STATE', `ticket ${t.id} is ${t.status}; reopen it (status open) before changing priority`);
        if (t.priority === priority) fail('DUPLICATE', `ticket ${t.id} is already ${priority} priority`);
        return ctx.patch(t, { priority, slaDueAt: plusHours(t.createdAt, SLA_HOURS[priority]) });
      },
      example: (ctx) => ({ id: ctx.all('tickets').find((t) => t.priority === 'normal' && !['resolved', 'closed'].includes(t.status)).id, priority: 'high' }),
    },
    {
      id: 'update_ticket_status', name: 'Update ticket status',
      description: 'Move a ticket through new → open/pending → resolved → closed. Resolved can be reopened; closed is final and only reachable from resolved.',
      keywords: ['resolve ticket', 'close ticket', 'reopen ticket'],
      risk: 'write',
      input: z.object({ id: id('ticket'), status: z.enum(STATUSES) }),
      output: ticket,
      handler: ({ id: tid, status }, ctx) => {
        const t = ctx.get('tickets', tid, 'ticket');
        const allowed = NEXT[t.status];
        if (!allowed.includes(status))
          fail('INVALID_STATE', `ticket ${t.id} is '${t.status}'; allowed next statuses: ${allowed.join(', ') || 'none (closed is final)'}${status === 'closed' ? '. Resolve it first.' : ''}`);
        const changes = { status };
        if (status === 'resolved') changes.resolvedAt = ctx.now;
        if (status === 'closed') changes.closedAt = ctx.now;
        if (t.status === 'resolved' && status === 'open') changes.resolvedAt = null;
        return ctx.patch(t, changes);
      },
      example: (ctx) => ({ id: ctx.all('tickets').find((t) => t.status === 'open').id, status: 'resolved' }),
    },
    {
      id: 'add_ticket_note', name: 'Add internal ticket note',
      description: 'Add a private note on a ticket visible only to staff (not sent to the customer; use reply_to_ticket for that).',
      risk: 'write',
      input: z.object({ id: id('ticket'), body: z.string().min(1).max(5000) }),
      output: ticket,
      handler: ({ id: tid, body }, ctx) => {
        const t = ctx.get('tickets', tid, 'ticket');
        notClosed(t);
        t.notes.push({ id: ctx.newId('tkn'), body, authorId: ctx.actorId, at: ctx.now });
        return ctx.patch(t, {});
      },
      example: (ctx) => ({ id: ctx.all('tickets')[0].id, body: 'Checked logs: password reset email bounced.' }),
    },
    {
      id: 'reply_to_ticket', name: 'Reply to ticket requester',
      description: "Email a reply to the ticket's linked contact (logged as an outbound message; records first response time). Requires a linked contact with an email.",
      keywords: ['respond to customer', 'answer ticket'],
      risk: 'external',
      input: z.object({ id: id('ticket'), body: z.string().min(1).max(10000) }),
      output: z.looseObject({ ticket, message: z.looseObject({ id: z.string(), channel: z.string(), status: z.string() }) }),
      handler: ({ id: tid, body }, ctx) => {
        const t = ctx.get('tickets', tid, 'ticket');
        notClosed(t);
        if (!t.contactId) fail('VALIDATION', `ticket ${t.id} has no requester; call link_ticket_contact first`);
        const c = ctx.get('contacts', t.contactId, 'contact');
        if (!c.email) fail('VALIDATION', `${c.name} has no email address; update the contact before replying`);
        if (c.preferences?.email === false) fail('PERMISSION', `${c.name} has unsubscribed from email; reply by phone or another channel`);
        const cnv = touchConversation(ctx, { contactId: c.id, channel: 'email', direction: 'outbound' });
        const msg = ctx.insert('messages', {
          channel: 'email', direction: 'outbound', contactId: c.id, conversationId: cnv.id, to: c.email, from: 'support@acme.test',
          subject: `Re: [${t.id}] ${t.subject}`, body, status: 'sent', scheduledAt: null, sentAt: ctx.now, deliveredAt: null, failureReason: null,
          templateId: null, relatedType: 'tickets', relatedId: t.id, purpose: 'ticket_reply',
        });
        t.replies.push({ id: ctx.newId('tkr'), body, authorId: ctx.actorId, at: ctx.now, messageId: msg.id });
        ctx.patch(t, { firstResponseAt: t.firstResponseAt || ctx.now, ...(t.status === 'new' ? { status: 'open' } : {}) });
        return { ticket: t, message: msg };
      },
      example: (ctx) => ({ id: ctx.all('tickets').find((t) => t.contactId && !['closed'].includes(t.status)).id, body: 'Thanks for reaching out, we are looking into this now.' }),
    },
    {
      id: 'link_ticket_contact', name: 'Link ticket to contact', description: 'Set or change the requester contact on a ticket.',
      risk: 'write',
      input: z.object({ id: id('ticket'), contactId: id('contact') }),
      output: ticket,
      handler: ({ id: tid, contactId }, ctx) => {
        const t = ctx.get('tickets', tid, 'ticket');
        notClosed(t);
        activeContact(ctx, contactId);
        if (t.contactId === contactId) fail('DUPLICATE', `ticket ${t.id} is already linked to ${contactId}`);
        return ctx.patch(t, { contactId });
      },
      example: (ctx) => ({ id: ctx.all('tickets').find((t) => !t.contactId).id, contactId: ctx.all('contacts')[2].id }),
    },
    {
      id: 'get_ticket_sla', name: 'Get ticket SLA status',
      description: 'SLA check for one ticket: deadline, hours remaining or overdue, breached flag, and whether the first response came before the deadline.',
      risk: 'read',
      input: z.object({ id: id('ticket') }),
      output: z.looseObject({ ticketId: z.string(), slaDueAt: z.string(), breached: z.boolean(), minutesRemaining: z.number().nullable(), firstResponseMet: z.boolean().nullable() }),
      handler: ({ id: tid }, ctx) => {
        const t = ctx.get('tickets', tid, 'ticket');
        const done = ['resolved', 'closed'].includes(t.status);
        const mins = Math.round((Date.parse(t.slaDueAt) - Date.parse(ctx.now)) / 6e4);
        const breached = isBreached(t, ctx.now);
        return {
          ticketId: t.id, priority: t.priority, status: t.status, slaHours: SLA_HOURS[t.priority], slaDueAt: t.slaDueAt, breached,
          minutesRemaining: done ? null : mins, overdueMinutes: !done && mins < 0 ? -mins : 0,
          firstResponseAt: t.firstResponseAt ?? null,
          firstResponseMet: t.firstResponseAt ? Date.parse(t.firstResponseAt) <= Date.parse(t.slaDueAt) : breached ? false : null,
          resolvedAt: t.resolvedAt ?? null,
        };
      },
      example: (ctx) => ({ id: ctx.all('tickets')[0].id }),
    },
  ],

  seed(ctx, h) {
    const contacts = ctx.all('contacts').filter((c) => c.status === 'active');
    const agents = ['usr_006', 'usr_007'];
    const hoursAgo = (n) => new Date(Date.parse(ctx.now) - n * 36e5).toISOString();
    // [subject, priority, status, ownerId|null, ageHours, hasContact, firstResponseAfterHours|null]
    const specs = [
      ['Payment page returns 500 error', 'urgent', 'new', null, 6, true, null], // breached, unassigned
      ['Booking widget down on website', 'urgent', 'open', 'usr_006', 9, true, 2], // breached, assigned
      ['Double charged for October invoice', 'high', 'new', null, 3, true, null],
      ['Cannot reset password', 'normal', 'new', null, 2, false, null], // no requester linked
      ['Appointment reminder SMS not received', 'normal', 'open', 'usr_007', 20, true, 1],
      ['Request to update billing address', 'low', 'pending', 'usr_007', 30, true, 4],
      ['Calendar sync with Google failing', 'high', 'open', 'usr_006', 12, true, 3], // breached
      ['Feature request: dark mode', 'low', 'new', null, 50, false, null],
      ['Invoice PDF shows wrong tax', 'normal', 'open', 'usr_006', 10, true, 2],
      ['Refund not received yet', 'high', 'pending', 'usr_007', 6, true, 1],
      ['Login loop on mobile app', 'urgent', 'resolved', 'usr_006', 30, true, 1],
      ['How do I export contacts?', 'low', 'closed', 'usr_007', 120, true, 5],
      ['Email campaign stuck in sending', 'urgent', 'open', 'usr_007', 2, true, 0.5],
      ['Wrong appointment time zone', 'normal', 'resolved', 'usr_007', 40, true, 30], // resolved late -> breached
      ['Coupon code not applying', 'normal', 'new', null, 26, true, null], // breached unassigned
      ['Need W-9 form', 'low', 'closed', 'usr_006', 200, true, 10],
      ['Membership access revoked by mistake', 'high', 'open', 'usr_006', 5, true, 1],
      ['Review link goes to wrong page', 'normal', 'pending', 'usr_007', 15, true, 2],
      ['Website form not submitting', 'high', 'new', null, 1, true, null],
      ['Duplicate contacts after import', 'normal', 'open', 'usr_007', 8, true, 3],
    ];
    specs.forEach(([subject, priority, status, ownerId, age, hasContact, fr], i) => {
      const createdAt = hoursAgo(age);
      const slaDueAt = plusHours(createdAt, SLA_HOURS[priority]);
      const firstResponseAt = fr != null ? plusHours(createdAt, fr) : null;
      const resolvedAt = status === 'resolved' || status === 'closed' ? plusHours(createdAt, i === 13 ? SLA_HOURS[priority] + 6 : Math.min(age - 1, SLA_HOURS[priority] - 1)) : null;
      ctx.insert('tickets', {
        subject, description: `${subject}. Reported via ${['email', 'chat', 'phone', 'web'][i % 4]}.`,
        contactId: hasContact && contacts.length ? contacts[(i * 3) % contacts.length].id : null, ownerId, priority, status,
        channel: CHANNELS[i % 4], slaDueAt, firstResponseAt, resolvedAt, closedAt: status === 'closed' ? plusHours(resolvedAt, 24) : null,
        notes: i % 5 === 1 ? [{ id: ctx.newId('tkn'), body: 'Escalated to engineering.', authorId: ownerId, at: plusHours(createdAt, 1) }] : [],
        replies: firstResponseAt ? [{ id: ctx.newId('tkr'), body: 'Thanks, we are on it.', authorId: ownerId || agents[0], at: firstResponseAt, messageId: null }] : [],
        createdAt, updatedAt: resolvedAt || firstResponseAt || createdAt,
      });
    });
  },
});
