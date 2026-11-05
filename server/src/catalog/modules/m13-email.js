import { defineModule, ops, z, id, isoDate, fail } from '../kit.js';
import { touchConversation } from './m11-conversations.js';
import { activeTemplate, renderData, renderParts } from './m14-templates.js';
import { message, newestFirst, futureIso, vars, relShape } from './m12-sms.js';

const FROM = 'hello@acme.test';
const OPEN_INVOICE = ['sent', 'partially_paid'];
const emailMsg = (ctx, mid) => {
  const m = ctx.get('messages', mid, 'email message');
  if (m.channel !== 'email') fail('VALIDATION', `message ${mid} is an ${m.channel} message; use the sms actions for it`);
  return m;
};
const findByEmail = (ctx, addr) => ctx.all('contacts').find((c) => c.status === 'active' && c.email?.toLowerCase() === addr.toLowerCase());

/** Build (render) an outbound email from compose fields. strict=false reports missing variables instead of failing (preview). */
function composeEmail(ctx, i, strict = true) {
  if (!i.contactId && !i.to) fail('VALIDATION', 'provide contactId or to (email address)');
  const c = i.contactId ? ctx.get('contacts', i.contactId, 'contact') : findByEmail(ctx, i.to);
  const to = i.to ?? c?.email;
  if (!to) fail('VALIDATION', `contact ${c.id} (${c.name}) has no email address; update the contact or pass 'to'`);
  if (i.relatedType && i.relatedId) ctx.ref(i.relatedType, i.relatedId);
  const t = i.templateId ? activeTemplate(ctx, i.templateId, 'email') : null;
  if (!t && (!i.subject || !i.body)) fail('VALIDATION', 'provide subject and body, or a templateId');
  const r = renderParts({ subject: i.subject ?? t.subject, body: i.body ?? t.body }, renderData(ctx, { contactId: c?.id, relatedType: i.relatedType, relatedId: i.relatedId, variables: i.variables }));
  if (strict && r.missing.length)
    fail('VALIDATION', `missing values for {{${r.missing.join('}}, {{')}}}; pass them in variables, or set contactId / relatedType+relatedId (e.g. relatedType "invoices") so they resolve`);
  return {
    channel: 'email', direction: 'outbound', contactId: c?.id ?? null, conversationId: null, to, from: FROM, subject: r.subject, body: r.body,
    templateId: t?.id ?? null, relatedType: i.relatedType ?? null, relatedId: i.relatedId ?? null,
    purpose: i.purpose ?? (i.relatedType === 'invoices' ? 'invoice_reminder' : null),
    scheduledAt: null, sentAt: null, deliveredAt: null, openedAt: null, failureReason: null, missingVariables: r.missing,
  };
}
const resolveOutbound = (ctx, i) => {
  if (!i.messageId) {
    const { missingVariables, ...m } = composeEmail(ctx, i);
    return m;
  }
  const m = emailMsg(ctx, i.messageId);
  if (m.status !== 'draft') fail('INVALID_STATE', `email ${m.id} is '${m.status}'; only drafts can be sent or scheduled by messageId`);
  return m;
};
const assertEmailAllowed = (ctx, m) => {
  const c = m.contactId && ctx.find('contacts', m.contactId);
  if (c?.preferences?.email === false) fail('PERMISSION', `${c.name} (${c.id}) has unsubscribed from email (preferences.email=false); do not email them. Use sms.send_sms if SMS is allowed.`);
  if (m.relatedType === 'invoices' && m.purpose === 'invoice_reminder') {
    const inv = ctx.get('invoices', m.relatedId, 'invoice');
    if (!OPEN_INVOICE.includes(inv.status) || !(inv.balance > 0))
      fail('INVALID_STATE', `invoice ${inv.number} is ${inv.status} with balance ${inv.balance}; payment reminders only go out for sent/partially_paid invoices with a balance`);
  }
};
const save = (ctx, i, m, fields) => (i.messageId ? ctx.patch(m, fields) : ctx.insert('messages', { ...m, ...fields }));
const composeShape = {
  contactId: z.string().optional().describe('recipient contact ID (email taken from the contact; also fills {{contact.*}})'),
  to: z.string().optional().describe('raw email address when there is no contactId'),
  subject: z.string().min(1).optional(), body: z.string().min(1).optional(),
  templateId: z.string().optional().describe('email template; subject/body override template parts'), variables: vars, ...relShape,
};
const okContact = (ctx) => ctx.all('contacts').find((c) => c.status === 'active' && c.email && c.preferences?.email !== false).id;
const firstEmail = (ctx, pred) => ctx.all('messages').find((m) => m.channel === 'email' && pred(m)).id;
const tplId = (ctx, n) => ctx.all('templates').find((t) => t.name === n)?.id;

export default defineModule({
  id: 'email',
  code: 'M13',
  name: 'Email',
  description: 'Draft, send, schedule and track one-to-one emails.',
  actions: [
    {
      id: 'draft_email', name: 'Draft email',
      description: 'Save an unsent email draft to a contact or address, from subject/body or an email template rendered with contact data, a related record (e.g. relatedType "invoices" for invoice reminders) and variables. Nothing is sent.',
      keywords: ['compose email', 'prepare email', 'write email'],
      risk: 'write',
      input: z.object(composeShape),
      output: message,
      handler: (i, ctx) => {
        const { missingVariables, ...m } = composeEmail(ctx, i);
        const c = m.contactId && ctx.find('contacts', m.contactId);
        return { ...ctx.insert('messages', { ...m, status: 'draft' }), warnings: c?.preferences?.email === false ? [`${c.name} has unsubscribed from email; this draft cannot be sent`] : [] };
      },
      example: (ctx) => ({ contactId: 'con_001', templateId: tplId(ctx, 'Welcome Email') }),
    },
    {
      id: 'preview_email', name: 'Preview email',
      description: 'Render the final subject/body of an email (an existing draft by messageId, or a template/compose fields for a contact) without saving or sending. Reports unresolved {{variables}} in missingVariables.',
      keywords: ['render email', 'test email', 'see email'],
      risk: 'read',
      input: z.object({ messageId: z.string().optional().describe('existing email draft to preview'), ...composeShape }),
      output: z.looseObject({ to: z.string().nullable(), subject: z.string().nullable(), body: z.string(), missingVariables: z.array(z.string()) }),
      handler: (i, ctx) => {
        if (i.messageId) {
          const m = emailMsg(ctx, i.messageId);
          return { messageId: m.id, status: m.status, to: m.to, subject: m.subject, body: m.body, missingVariables: [] };
        }
        const m = composeEmail(ctx, i, false);
        return { to: m.to, subject: m.subject, body: m.body, templateId: m.templateId, missingVariables: m.missingVariables };
      },
      example: (ctx) => ({ contactId: 'con_002', templateId: tplId(ctx, 'Lead Follow-up Email') }),
    },
    {
      id: 'send_email', name: 'Send email',
      description: 'Immediately send one email to a single contact or address (compose new, render a template, or send an existing draft via messageId). Logs it on the contact\'s email conversation; invoice reminders (relatedType "invoices") are recorded on the invoice. Fails if the contact unsubscribed. For SMS use sms.send_sms; for bulk sends use campaigns.',
      keywords: ['email customer', 'send reminder email', 'reply by email'],
      risk: 'external',
      input: z.object({ messageId: z.string().optional().describe('existing email draft to send'), ...composeShape }),
      output: message,
      handler: (i, ctx) => {
        const m = resolveOutbound(ctx, i);
        assertEmailAllowed(ctx, m);
        const cnv = m.contactId ? touchConversation(ctx, { contactId: m.contactId, channel: 'email', direction: 'outbound' }) : null;
        const sent = save(ctx, i, m, { status: 'delivered', sentAt: ctx.now, deliveredAt: ctx.now, conversationId: cnv?.id ?? null });
        if (sent.relatedType === 'invoices' && sent.purpose === 'invoice_reminder') {
          const inv = ctx.get('invoices', sent.relatedId, 'invoice');
          (inv.remindersSent ||= []).push({ at: ctx.now, channel: 'email', messageId: sent.id });
          ctx.patch(inv, { lastReminderAt: ctx.now });
        }
        return sent;
      },
      example: (ctx) => ({ contactId: okContact(ctx), subject: 'Quick question', body: 'Hi! Do you have a few minutes this week to chat?' }),
    },
    {
      id: 'schedule_email', name: 'Schedule email',
      description: 'Queue one email to be sent at a future time (compose new or schedule an existing draft via messageId). Fails if scheduledAt is not in the future or the contact unsubscribed.',
      keywords: ['send email later'],
      risk: 'external',
      input: z.object({ messageId: z.string().optional().describe('existing email draft to schedule'), ...composeShape, scheduledAt: isoDate('future send time (ISO)') }),
      output: message,
      handler: (i, ctx) => {
        const scheduledAt = futureIso(ctx, i.scheduledAt);
        const m = resolveOutbound(ctx, i);
        assertEmailAllowed(ctx, m);
        return save(ctx, i, m, { status: 'scheduled', scheduledAt });
      },
      example: (ctx) => ({ messageId: firstEmail(ctx, (m) => m.status === 'draft'), scheduledAt: '2026-11-05T14:00:00Z' }),
    },
    {
      id: 'cancel_scheduled_email', name: 'Cancel scheduled email', description: 'Cancel a scheduled (not yet sent) email so it is never sent.',
      keywords: ['unschedule email'],
      ...ops.transition('messages', { to: 'cancelled', from: ['scheduled'], risk: 'destructive', what: 'email message', guard: (m, i, ctx) => emailMsg(ctx, m.id) }),
      example: (ctx) => ({ id: firstEmail(ctx, (m) => m.status === 'scheduled') }),
    },
    {
      id: 'get_email_details', name: 'Get email details', description: 'Fetch one email message (subject, body, recipient, status, opened/bounced timestamps, template, related record) by message ID.',
      risk: 'read',
      input: z.object({ id: id('email message') }),
      output: message,
      handler: ({ id: mid }, ctx) => {
        const m = emailMsg(ctx, mid);
        return { ...m, contactName: (m.contactId && ctx.find('contacts', m.contactId)?.name) || null };
      },
      example: (ctx) => ({ id: firstEmail(ctx, (m) => m.openedAt) }),
    },
    {
      id: 'search_email_messages', name: 'Search email messages',
      description: 'Find individual email messages (not threads) by contact(s), status, direction, purpose (e.g. invoice_reminder), related record ID, sent date range or subject/body text, newest first. For reply/thread questions prefer conversations.search_conversations.',
      keywords: ['sent emails', 'email history', 'bounced emails', 'reminder emails'],
      ...ops.search('messages', {
        text: ['subject', 'body', 'to'],
        filters: {
          contactId: z.string().optional(), contactIds: z.array(z.string()).optional().describe('any of these contacts'),
          status: z.enum(['draft', 'scheduled', 'sent', 'delivered', 'failed', 'cancelled', 'received']).optional(), direction: z.enum(['inbound', 'outbound']).optional(),
          purpose: z.string().optional(), relatedId: z.string().optional(), sentAtAfter: isoDate().optional(), sentAtBefore: isoDate().optional(),
        },
        where: (r) => r.channel === 'email',
        sort: newestFirst,
      }),
      example: () => ({ purpose: 'invoice_reminder' }),
    },
    {
      id: 'get_email_delivery_status', name: 'Get email delivery status',
      description: 'Delivery/engagement state of one email: scheduled, delivered, opened, bounced (with reason) or failed, with timestamps.',
      keywords: ['did they open', 'email bounced', 'was email delivered'],
      risk: 'read',
      input: z.object({ id: id('email message') }),
      output: z.looseObject({ messageId: z.string(), status: z.string(), deliveryState: z.string(), summary: z.string() }),
      handler: ({ id: mid }, ctx) => {
        const m = emailMsg(ctx, mid);
        const bounced = m.status === 'failed' && /bounce/i.test(m.failureReason || '');
        const deliveryState = bounced ? 'bounced' : m.openedAt ? 'opened' : m.status;
        const summary = {
          bounced: `Bounced: ${m.failureReason}.`, opened: `Delivered ${m.deliveredAt}, opened ${m.openedAt}.`, delivered: `Delivered ${m.deliveredAt}, not opened yet.`,
          sent: `Sent ${m.sentAt}, awaiting delivery.`, failed: `Failed: ${m.failureReason || 'unknown error'}.`, scheduled: `Scheduled for ${m.scheduledAt}.`,
          draft: 'Draft, not sent.', cancelled: 'Cancelled before sending.', received: `Inbound email received ${m.sentAt}.`,
        }[deliveryState];
        return { messageId: m.id, status: m.status, deliveryState, to: m.to, sentAt: m.sentAt ?? null, deliveredAt: m.deliveredAt ?? null, openedAt: m.openedAt ?? null, failureReason: m.failureReason ?? null, summary };
      },
      example: (ctx) => ({ id: firstEmail(ctx, (m) => m.status === 'failed') }),
    },
    {
      id: 'receive_inbound_email', name: 'Receive simulated inbound email',
      description: 'Simulate a contact emailing in: matches the sender by email address (or contactId), logs the message and marks the email conversation unread/awaiting reply (reopening if closed).',
      keywords: ['incoming email', 'customer replied by email', 'simulate reply'],
      risk: 'write',
      input: z.object({ from: z.string().optional().describe('sender email address'), contactId: z.string().optional(), subject: z.string().optional(), body: z.string().min(1) }),
      output: z.looseObject({ message, conversation: z.looseObject({ id: z.string() }) }),
      handler: (i, ctx) => {
        if (!i.contactId && !i.from) fail('VALIDATION', 'provide from (email address) or contactId');
        const c = i.contactId ? ctx.get('contacts', i.contactId, 'contact') : findByEmail(ctx, i.from);
        if (!c) fail('NOT_FOUND', `no active contact has email ${i.from}; create the contact first or pass contactId`);
        const conversation = touchConversation(ctx, { contactId: c.id, channel: 'email', direction: 'inbound' });
        const msg = ctx.insert('messages', {
          channel: 'email', direction: 'inbound', status: 'received', contactId: c.id, conversationId: conversation.id, to: FROM, from: i.from ?? c.email,
          subject: i.subject ?? '(no subject)', body: i.body, scheduledAt: null, sentAt: ctx.now, deliveredAt: ctx.now, openedAt: null, failureReason: null,
          templateId: null, relatedType: null, relatedId: null, purpose: null,
        });
        return { message: msg, conversation };
      },
      example: () => ({ from: 'sarah.johnson@example.com', subject: 'Re: your quote', body: 'Looks good, please send the invoice.' }),
    },
    {
      id: 'record_email_unsubscribe', name: 'Record email unsubscribe',
      description: 'Record that a contact unsubscribed from email (sets preferences.email=false with reason) and cancels their scheduled emails. SMS/call preferences are unchanged.',
      keywords: ['unsubscribe', 'stop emailing', 'email opt out'],
      risk: 'write',
      input: z.object({ contactId: id('contact'), reason: z.string().optional() }),
      output: z.looseObject({ contactId: z.string(), cancelledScheduled: z.array(z.string()) }),
      handler: ({ contactId, reason }, ctx) => {
        const c = ctx.get('contacts', contactId, 'contact');
        if (c.preferences?.email === false) fail('INVALID_STATE', `${c.name} (${c.id}) is already unsubscribed from email`);
        ctx.patch(c, { preferences: { ...c.preferences, email: false }, emailUnsubscribe: { at: ctx.now, reason: reason ?? 'manual unsubscribe' } });
        const cancelled = ctx.all('messages').filter((m) => m.channel === 'email' && m.status === 'scheduled' && m.contactId === c.id);
        cancelled.forEach((m) => ctx.patch(m, { status: 'cancelled', failureReason: 'recipient unsubscribed' }));
        return { contactId: c.id, name: c.name, preferences: c.preferences, cancelledScheduled: cancelled.map((m) => m.id) };
      },
      example: () => ({ contactId: 'con_002', reason: 'Clicked unsubscribe link' }),
    },
  ],

  seed(ctx, h) {
    const ok = ctx.all('contacts').filter((c) => c.status === 'active' && c.email && c.preferences?.email !== false);
    if (ok.length < 30) return;
    const promo = ctx.all('campaigns').find((c) => c.name === 'Webinar Promo - Oct');
    const welcome = ctx.all('templates').find((t) => t.name === 'Welcome Email');
    const base = { channel: 'email', direction: 'outbound', from: FROM, conversationId: null, scheduledAt: null, sentAt: null, deliveredAt: null, openedAt: null, failureReason: null, templateId: null, relatedType: null, relatedId: null, purpose: null };
    const add = (c, f) => ctx.insert('messages', { ...base, contactId: c.id, to: c.email, ...f, createdAt: f.sentAt ?? h.daysAgo(1) });
    // Webinar promo blast (Oct): delivered, some opened, two hard bounces.
    for (let k = 0; k < 12; k++) {
      const c = ok[14 + k];
      const sent = h.daysAgo(h.int(20, 30));
      const bounce = k === 3 || k === 8;
      add(c, {
        subject: 'Join our free webinar: Grow your local business', body: `Hi ${c.firstName}, save your seat for our October webinar on growing your local business.`,
        purpose: 'campaign', relatedType: promo ? 'campaigns' : null, relatedId: promo?.id ?? null, sentAt: sent,
        ...(bounce
          ? { status: 'failed', failureReason: k === 3 ? 'Hard bounce: mailbox does not exist (550 5.1.1)' : 'Soft bounce: mailbox full (452 4.2.2)' }
          : { status: 'delivered', deliveredAt: sent, openedAt: k % 2 === 0 ? new Date(Date.parse(sent) + h.int(1, 30) * 36e5).toISOString() : null }),
      });
    }
    // 1:1 welcome emails, a scheduled check-in and a draft.
    for (const k of [26, 27]) {
      const sent = h.daysAgo(h.int(3, 10));
      add(ok[k], { subject: `Welcome to Acme, ${ok[k].firstName}!`, body: `Hi ${ok[k].firstName},\n\nWelcome aboard! Reply any time with questions.`, templateId: welcome?.id ?? null, purpose: 'onboarding', status: 'delivered', sentAt: sent, deliveredAt: sent, openedAt: k === 26 ? sent : null });
    }
    add(ok[28], { status: 'scheduled', scheduledAt: h.daysFromNow(2), subject: 'Checking in on your project', body: `Hi ${ok[28].firstName}, just checking in on how things are going.`, purpose: 'follow_up' });
    add(ok[29], { status: 'draft', subject: 'Your custom proposal', body: `Hi ${ok[29].firstName}, attached is the proposal we discussed.`, purpose: 'follow_up' });
  },
});
