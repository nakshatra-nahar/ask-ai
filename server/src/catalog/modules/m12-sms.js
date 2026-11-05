import { defineModule, ops, z, id, entity, isoDate, fail, toTime } from '../kit.js';
import { touchConversation } from './m11-conversations.js';
import { activeTemplate, renderData, renderParts } from './m14-templates.js';

// Shared messages table (sms + email; webchat only via conversations). Owned here, also written by email, conversations, invoices.
const ns = z.string().nullable().optional();
export const message = entity({
  channel: z.enum(['sms', 'email', 'webchat']), direction: z.enum(['inbound', 'outbound']),
  status: z.enum(['draft', 'scheduled', 'sent', 'delivered', 'failed', 'cancelled', 'received']),
  contactId: ns, conversationId: ns, to: ns, from: ns, subject: ns, body: z.string(),
  scheduledAt: ns, sentAt: ns, deliveredAt: ns, openedAt: ns, failureReason: ns, templateId: ns, relatedType: ns, relatedId: ns, purpose: ns,
});
export const SMS_FROM = '+1-555-0100';
export const msgTime = (m) => m.sentAt || m.scheduledAt || m.createdAt;
export const newestFirst = (a, b) => Date.parse(msgTime(b)) - Date.parse(msgTime(a));
export const futureIso = (ctx, v) => {
  if (toTime(v) <= Date.parse(ctx.now)) fail('VALIDATION', `scheduledAt must be in the future (now is ${ctx.now})`);
  return new Date(toTime(v)).toISOString();
};
/** Shared compose params for sms/email draft, send, schedule. */
export const vars = z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('template values, e.g. {"review.link":"https://..."}');
export const relShape = {
  relatedType: z.string().optional().describe('table of a related record, e.g. invoices, appointments, leads'), relatedId: z.string().optional(),
  purpose: z.string().optional().describe('e.g. follow_up, appointment_reminder, invoice_reminder, promotion'),
};

// ---------- GSM-7 / UCS-2 segmentation ----------
const GSM = new Set('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà');
const GSM_EXT = new Set('^{}\\[~]|€'); // count as 2 septets (escape + char)
export function segmentation(body) {
  const chars = [...body];
  const nonGsm = [...new Set(chars.filter((c) => !GSM.has(c) && !GSM_EXT.has(c)))];
  const gsm = !nonGsm.length;
  const units = gsm ? chars.length + chars.filter((c) => GSM_EXT.has(c)).length : body.length; // UCS-2 counts UTF-16 units (emoji = 2)
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  const segments = units <= single ? 1 : Math.ceil(units / multi);
  const per = segments === 1 ? single : multi;
  return { encoding: gsm ? 'GSM-7' : 'UCS-2', characters: units, segments, perSegmentLimit: per, remainingInLastSegment: segments * per - units, nonGsmCharacters: nonGsm };
}
const seg = (body) => {
  const s = segmentation(body);
  return { segments: s.segments, encoding: s.encoding };
};

const digits = (p) => (p || '').replace(/\D/g, '');
const samePhone = (a, b) => {
  const x = digits(a), y = digits(b);
  return x.length >= 7 && y.length >= 7 && (x.endsWith(y) || y.endsWith(x));
};
const smsMsg = (ctx, mid) => {
  const m = ctx.get('messages', mid, 'SMS message');
  if (m.channel !== 'sms') fail('VALIDATION', `message ${mid} is an ${m.channel} message; use the email actions for it`);
  return m;
};
const withName = (ctx, m) => ({ ...m, contactName: (m.contactId && ctx.find('contacts', m.contactId)?.name) || null });

function composeSms(ctx, i) {
  const c = i.contactId ? ctx.get('contacts', i.contactId, 'contact') : i.to ? ctx.all('contacts').find((x) => x.status === 'active' && samePhone(x.phone, i.to)) : null;
  if (!i.contactId && !i.to) fail('VALIDATION', 'provide contactId or to (phone number)');
  const to = i.to ?? c?.phone;
  if (!to) fail('VALIDATION', `contact ${c.id} (${c.name}) has no phone number; update the contact or pass 'to'`);
  if (i.relatedType && i.relatedId) ctx.ref(i.relatedType, i.relatedId);
  let body = i.body;
  if (i.templateId) {
    const t = activeTemplate(ctx, i.templateId, 'sms');
    const r = renderParts(t, renderData(ctx, { contactId: c?.id, relatedType: i.relatedType, relatedId: i.relatedId, variables: i.variables }));
    if (r.missing.length) fail('VALIDATION', `template ${t.id} needs values for: ${r.missing.join(', ')}; pass them in variables or set contactId/relatedType/relatedId`);
    body = r.body;
  }
  if (!body) fail('VALIDATION', 'provide body or templateId');
  return {
    channel: 'sms', direction: 'outbound', contactId: c?.id ?? null, conversationId: null, to, from: SMS_FROM, subject: null, body,
    templateId: i.templateId ?? null, relatedType: i.relatedType ?? null, relatedId: i.relatedId ?? null, purpose: i.purpose ?? null,
    scheduledAt: null, sentAt: null, deliveredAt: null, failureReason: null, ...seg(body),
  };
}
const optedOut = (ctx, m) => {
  const c = m.contactId && ctx.find('contacts', m.contactId);
  return c?.preferences?.sms === false ? c : null;
};
const assertSmsAllowed = (ctx, m) => {
  const c = optedOut(ctx, m);
  if (c) fail('PERMISSION', `${c.name} (${c.id}) has opted out of SMS (preferences.sms=false); do not text them. Use email.send_email if email is allowed.`);
};
/** Outbound message from a draft id or compose fields. */
const resolveOutbound = (ctx, i) => {
  if (!i.messageId) return composeSms(ctx, i);
  const m = smsMsg(ctx, i.messageId);
  if (m.status !== 'draft') fail('INVALID_STATE', `SMS ${m.id} is '${m.status}'; only drafts can be sent or scheduled by messageId`);
  return m;
};
const save = (ctx, i, m, fields) => (i.messageId ? ctx.patch(m, fields) : ctx.insert('messages', { ...m, ...fields }));

export function optOutSms(ctx, c, reason) {
  ctx.patch(c, { preferences: { ...c.preferences, sms: false }, smsOptOut: { at: ctx.now, reason } });
  const cancelled = ctx.all('messages').filter((m) => m.channel === 'sms' && m.status === 'scheduled' && m.contactId === c.id);
  cancelled.forEach((m) => ctx.patch(m, { status: 'cancelled', failureReason: 'recipient opted out of SMS' }));
  return cancelled.map((m) => m.id);
}
const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
const composeShape = {
  contactId: z.string().optional().describe('recipient contact ID (phone taken from the contact)'), to: z.string().optional().describe('raw phone number when there is no contactId'),
  body: z.string().min(1).max(1600).optional(), templateId: z.string().optional().describe('SMS template to render instead of body'), variables: vars, ...relShape,
};
const okContact = (ctx) => ctx.all('contacts').find((c) => c.status === 'active' && c.phone && c.preferences?.sms !== false).id;
const firstSms = (ctx, status) => ctx.all('messages').find((m) => m.channel === 'sms' && m.status === status).id;

export default defineModule({
  id: 'sms',
  code: 'M12',
  name: 'SMS',
  description: 'Draft, send, schedule and track one-to-one SMS text messages.',
  tables: { messages: { prefix: 'msg', schema: message } },
  actions: [
    {
      id: 'draft_sms', name: 'Draft SMS',
      description: 'Save an unsent SMS draft to a contact (phone resolved from contactId) or raw number, from body text or an SMS template. Nothing is sent; warns if the contact opted out.',
      keywords: ['compose text', 'prepare text message'],
      risk: 'write',
      input: z.object(composeShape),
      output: message,
      handler: (i, ctx) => {
        const m = ctx.insert('messages', { ...composeSms(ctx, i), status: 'draft' });
        const c = optedOut(ctx, m);
        return { ...m, warnings: c ? [`${c.name} has opted out of SMS; this draft cannot be sent`] : [] };
      },
      example: (ctx) => ({ contactId: okContact(ctx), body: 'Hi! Just confirming we received your request. Talk soon.' }),
    },
    {
      id: 'preview_sms_segmentation', name: 'Preview SMS segmentation',
      description: 'Calculate SMS encoding (GSM-7 vs UCS-2), character count and number of billable segments for a text (160/70 chars single, 153/67 per part when multipart). Lists characters that force UCS-2.',
      keywords: ['character count', 'sms length', 'segments', 'emoji'],
      risk: 'read',
      input: z.object({ body: z.string().min(1).describe('SMS text to measure') }),
      output: z.looseObject({ encoding: z.enum(['GSM-7', 'UCS-2']), characters: z.number(), segments: z.number() }),
      handler: ({ body }) => segmentation(body),
      example: () => ({ body: 'Your appointment is tomorrow at 3pm. Reply C to confirm 👍' }),
    },
    {
      id: 'send_sms', name: 'Send SMS',
      description: 'Immediately send one SMS text to a single contact or number (compose new, or send an existing draft via messageId). Logs it on the contact\'s SMS conversation. Fails if the contact opted out of SMS or has no phone. For email use email.send_email; for bulk sends use campaigns.',
      keywords: ['text message', 'text the customer', 'send text'],
      risk: 'external',
      input: z.object({ messageId: z.string().optional().describe('existing SMS draft to send'), ...composeShape }),
      output: message,
      handler: (i, ctx) => {
        const m = resolveOutbound(ctx, i);
        assertSmsAllowed(ctx, m);
        const cnv = m.contactId ? touchConversation(ctx, { contactId: m.contactId, channel: 'sms', direction: 'outbound' }) : null;
        return save(ctx, i, m, { status: 'delivered', sentAt: ctx.now, deliveredAt: ctx.now, conversationId: cnv?.id ?? null });
      },
      example: (ctx) => ({ contactId: okContact(ctx), body: 'Hi! Following up on your quote. Any questions?' }),
    },
    {
      id: 'schedule_sms', name: 'Schedule SMS',
      description: 'Queue one SMS to be sent at a future time (compose new or schedule an existing draft via messageId). Fails if scheduledAt is not in the future or the contact opted out of SMS.',
      keywords: ['send later', 'text later'],
      risk: 'external',
      input: z.object({ messageId: z.string().optional().describe('existing SMS draft to schedule'), ...composeShape, scheduledAt: isoDate('future send time (ISO)') }),
      output: message,
      handler: (i, ctx) => {
        const scheduledAt = futureIso(ctx, i.scheduledAt);
        const m = resolveOutbound(ctx, i);
        assertSmsAllowed(ctx, m);
        return save(ctx, i, m, { status: 'scheduled', scheduledAt });
      },
      example: (ctx) => ({ contactId: okContact(ctx), body: 'Reminder: our call is tomorrow at 10am.', scheduledAt: '2026-11-06T15:00:00Z' }),
    },
    {
      id: 'cancel_scheduled_sms', name: 'Cancel scheduled SMS', description: 'Cancel a scheduled (not yet sent) SMS so it is never sent.',
      keywords: ['unschedule text'],
      ...ops.transition('messages', { to: 'cancelled', from: ['scheduled'], risk: 'destructive', what: 'SMS message', guard: (m, i, ctx) => smsMsg(ctx, m.id) }),
      example: (ctx) => ({ id: firstSms(ctx, 'scheduled') }),
    },
    {
      id: 'get_sms_details', name: 'Get SMS details', description: 'Fetch one SMS message (body, recipient, status, timestamps, template, related record) by message ID.',
      risk: 'read',
      input: z.object({ id: id('SMS message') }),
      output: message,
      handler: ({ id: mid }, ctx) => withName(ctx, smsMsg(ctx, mid)),
      example: (ctx) => ({ id: firstSms(ctx, 'failed') }),
    },
    {
      id: 'search_sms_messages', name: 'Search SMS messages',
      description: 'Find individual SMS messages (not threads) by contact(s), conversation, direction, status, purpose, sent date range or text, newest first. For reply/thread questions prefer conversations.search_conversations.',
      keywords: ['text history', 'sent texts', 'failed sms'],
      ...ops.search('messages', {
        text: ['body', 'to', 'from'],
        filters: {
          contactId: z.string().optional(), contactIds: z.array(z.string()).optional().describe('any of these contacts'), conversationId: z.string().optional(),
          direction: z.enum(['inbound', 'outbound']).optional(), status: z.enum(['draft', 'scheduled', 'sent', 'delivered', 'failed', 'cancelled', 'received']).optional(),
          purpose: z.string().optional(), sentAtAfter: isoDate().optional(), sentAtBefore: isoDate().optional(),
        },
        where: (r) => r.channel === 'sms',
        sort: newestFirst,
      }),
      example: () => ({ status: 'scheduled' }),
    },
    {
      id: 'get_sms_delivery_status', name: 'Get SMS delivery status',
      description: 'Delivery state of one SMS: queued/sent/delivered/failed with timestamps, carrier failure reason and segment count.',
      keywords: ['was the text delivered', 'sms failed why'],
      risk: 'read',
      input: z.object({ id: id('SMS message') }),
      output: z.looseObject({ messageId: z.string(), status: z.string(), summary: z.string() }),
      handler: ({ id: mid }, ctx) => {
        const m = smsMsg(ctx, mid);
        const summary = {
          draft: 'Draft, not sent.', scheduled: `Scheduled for ${m.scheduledAt}.`, sent: `Sent ${m.sentAt}, awaiting carrier receipt.`,
          delivered: `Delivered ${m.deliveredAt}.`, failed: `Failed: ${m.failureReason || 'unknown carrier error'}.`, cancelled: 'Cancelled before sending.',
          received: `Inbound message received ${m.sentAt}.`,
        }[m.status];
        return { messageId: m.id, status: m.status, to: m.to, scheduledAt: m.scheduledAt ?? null, sentAt: m.sentAt ?? null, deliveredAt: m.deliveredAt ?? null, failureReason: m.failureReason ?? null, segments: m.segments ?? seg(m.body).segments, summary };
      },
      example: (ctx) => ({ id: firstSms(ctx, 'failed') }),
    },
    {
      id: 'receive_inbound_sms', name: 'Receive simulated inbound SMS',
      description: 'Simulate a contact texting in: matches the sender by phone (or contactId), logs the message, marks the SMS conversation unread/awaiting reply (reopening if closed). STOP/UNSUBSCRIBE keywords opt the contact out of SMS.',
      keywords: ['incoming text', 'customer replied', 'simulate reply'],
      risk: 'write',
      input: z.object({ from: z.string().optional().describe('sender phone number'), contactId: z.string().optional(), body: z.string().min(1) }),
      output: z.looseObject({ message, conversation: z.looseObject({ id: z.string() }), optedOut: z.boolean() }),
      handler: (i, ctx) => {
        let c;
        if (i.contactId) c = ctx.get('contacts', i.contactId, 'contact');
        else {
          if (!i.from) fail('VALIDATION', 'provide from (phone) or contactId');
          const hits = ctx.all('contacts').filter((x) => x.status === 'active' && samePhone(x.phone, i.from));
          if (!hits.length) fail('NOT_FOUND', `no active contact has phone ${i.from}; create the contact first or pass contactId`);
          if (hits.length > 1) fail('CONFLICT', `phone ${i.from} matches ${hits.map((x) => `${x.id} ${x.name}`).join(', ')}; pass contactId (consider merging the duplicates)`);
          c = hits[0];
        }
        const conversation = touchConversation(ctx, { contactId: c.id, channel: 'sms', direction: 'inbound' });
        const msg = ctx.insert('messages', {
          channel: 'sms', direction: 'inbound', status: 'received', contactId: c.id, conversationId: conversation.id, to: SMS_FROM, from: i.from ?? c.phone,
          subject: null, body: i.body, scheduledAt: null, sentAt: ctx.now, deliveredAt: ctx.now, failureReason: null, templateId: null, relatedType: null, relatedId: null, purpose: null, ...seg(i.body),
        });
        const stop = STOP_WORDS.includes(i.body.trim().toUpperCase());
        const cancelledScheduled = stop ? optOutSms(ctx, c, `replied ${i.body.trim()}`) : [];
        return { message: msg, conversation, optedOut: stop, cancelledScheduled };
      },
      example: (ctx) => ({ contactId: 'con_001', body: 'Yes, Thursday at 2pm works for me.' }),
    },
    {
      id: 'record_sms_opt_out', name: 'Record SMS opt-out',
      description: 'Record that a contact opted out of SMS (sets preferences.sms=false with reason) and cancels their scheduled texts. Email/call preferences are unchanged.',
      keywords: ['stop texting', 'sms dnd', 'unsubscribe sms'],
      risk: 'write',
      input: z.object({ contactId: id('contact'), reason: z.string().optional().describe('e.g. "asked by phone"') }),
      output: z.looseObject({ contactId: z.string(), cancelledScheduled: z.array(z.string()) }),
      handler: ({ contactId, reason }, ctx) => {
        const c = ctx.get('contacts', contactId, 'contact');
        if (c.preferences?.sms === false) fail('INVALID_STATE', `${c.name} (${c.id}) is already opted out of SMS`);
        const cancelledScheduled = optOutSms(ctx, c, reason ?? 'manual opt-out');
        return { contactId: c.id, name: c.name, preferences: c.preferences, cancelledScheduled };
      },
      example: () => ({ contactId: 'con_001', reason: 'Asked us to stop texting during a call' }),
    },
  ],

  seed(ctx, h) {
    const ok = ctx.all('contacts').filter((c) => c.status === 'active' && c.phone && c.preferences?.sms !== false);
    if (ok.length < 14) return;
    const base = { channel: 'sms', direction: 'outbound', from: SMS_FROM, subject: null, conversationId: null, scheduledAt: null, sentAt: null, deliveredAt: null, failureReason: null, templateId: null, relatedType: null, relatedId: null, purpose: null };
    const add = (c, f) => ctx.insert('messages', { ...base, contactId: c.id, to: c.phone, ...f, ...seg(f.body) });
    const reminder = ctx.all('templates').find((t) => t.name === 'Appointment Reminder');
    const appts = ctx.all('appointments').filter((a) => a.startAt > ctx.now && ['booked', 'confirmed'].includes(a.status));
    for (let k = 0; k < 3; k++) {
      const a = appts[k];
      const c = (a && ctx.find('contacts', a.contactId)) || ok[6 + k];
      if (!c.phone || c.preferences?.sms === false) continue;
      const when = a?.startAt ?? h.daysFromNow(k + 2);
      const at = new Date(Math.max(Date.parse(when) - 864e5, Date.parse(ctx.now) + 36e5)).toISOString();
      add(c, {
        status: 'scheduled', scheduledAt: at, templateId: reminder?.id ?? null, purpose: 'appointment_reminder', relatedType: a ? 'appointments' : null, relatedId: a?.id ?? null,
        body: `Reminder: ${c.firstName}, your appointment with Acme is on ${when.slice(0, 10)} at ${when.slice(11, 16)} UTC. Reply C to confirm or R to reschedule.`, createdAt: h.daysAgo(1),
      });
    }
    add(ok[9], { status: 'failed', sentAt: h.daysAgo(3), purpose: 'follow_up', failureReason: 'Carrier rejected: number is a landline and cannot receive SMS (error 30006)', body: `Hi ${ok[9].firstName}, following up on your inquiry. When is a good time to talk?` });
    add(ok[10], { status: 'failed', sentAt: h.daysAgo(6), purpose: 'appointment_reminder', failureReason: 'Undeliverable: invalid or disconnected number (error 30005)', body: `Hi ${ok[10].firstName}, reminder about your appointment tomorrow.` });
    add(ok[11], { status: 'draft', purpose: 'follow_up', body: `Hi ${ok[11].firstName}, just checking in. Are you still interested in a quote?` });
    add(ok[12], { status: 'draft', purpose: 'promotion', body: 'Acme BLACK FRIDAY: 30% off everything this Friday only! Reply STOP to opt out.' });
    add(ok[13], { status: 'cancelled', scheduledAt: h.daysAgo(2), purpose: 'promotion', body: 'Flash sale today only: 15% off all services!' });
  },
});
