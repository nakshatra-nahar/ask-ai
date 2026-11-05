import { defineModule, ops, z, id, entity, isoDate, limit, fail, page, daysBetween, matchFilters, round2 as r2 } from '../kit.js';

const lineItem = z.looseObject({ id: z.string(), description: z.string(), productId: z.string().nullable().optional(), quantity: z.number(), unitPrice: z.number(), amount: z.number() });
const invoice = entity({
  number: z.string(), contactId: z.string(), status: z.enum(['draft', 'sent', 'partially_paid', 'paid', 'void']),
  issueDate: z.string().nullable(), dueDate: z.string().nullable(), currency: z.string(), lineItems: z.array(lineItem),
  subtotal: z.number(), total: z.number(), amountPaid: z.number(), balance: z.number(), lastReminderAt: z.string().nullable().optional(),
});
const OPEN = ['sent', 'partially_paid'];

export function recalc(inv) {
  inv.subtotal = r2(inv.lineItems.reduce((s, l) => s + l.amount, 0));
  inv.total = r2(inv.subtotal - (inv.discount || 0) + (inv.tax || 0));
  inv.balance = r2(inv.total - inv.amountPaid);
  return inv;
}
const daysOverdue = (inv, now) => (OPEN.includes(inv.status) && inv.dueDate && inv.dueDate < now.slice(0, 10) ? daysBetween(inv.dueDate, now.slice(0, 10)) : 0);
const withOverdue = (inv, ctx) => ({ ...inv, daysOverdue: daysOverdue(inv, ctx.now) });
const draftOnly = (inv) => inv.status !== 'draft' && fail('INVALID_STATE', `invoice ${inv.number} is ${inv.status}; only draft invoices can be edited`);
const nextNumber = (ctx) => 'INV-' + (Math.max(1000, ...ctx.all('invoices').map((i) => Number(i.number.split('-')[1]) || 0)) + 1);
const lineInput = { description: z.string().min(1), quantity: z.number().positive().default(1), unitPrice: z.number().nonnegative(), productId: z.string().optional() };

export default defineModule({
  id: 'invoices',
  code: 'M28',
  name: 'Invoices',
  description: 'Issue invoices and track outstanding balances.',
  tables: { invoices: { prefix: 'inv', schema: invoice } },
  actions: [
    {
      id: 'create_invoice', name: 'Create invoice', description: 'Create a draft invoice for a contact, optionally with line items. Not sent until issued.',
      keywords: ['bill customer', 'new invoice', 'charge'],
      risk: 'write',
      input: z.object({
        contactId: id('contact'), dueDate: isoDate().optional(), currency: z.string().length(3).default('USD'),
        lineItems: z.array(z.object(lineInput)).optional(), notes: z.string().optional(),
      }),
      output: invoice,
      handler: (i, ctx) => {
        ctx.get('contacts', i.contactId, 'contact');
        for (const l of i.lineItems || []) if (l.productId) ctx.get('products', l.productId, 'product');
        const inv = ctx.insert('invoices', {
          number: nextNumber(ctx), contactId: i.contactId, status: 'draft', issueDate: null, dueDate: i.dueDate?.slice(0, 10) ?? null,
          currency: i.currency.toUpperCase(), notes: i.notes ?? null, discount: 0, tax: 0, amountPaid: 0, remindersSent: [], lastReminderAt: null,
          lineItems: (i.lineItems || []).map((l) => ({ id: ctx.newId('li'), productId: l.productId ?? null, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, amount: r2(l.quantity * l.unitPrice) })),
        });
        return recalc(inv);
      },
      example: (ctx) => ({ contactId: ctx.all('contacts')[0].id, lineItems: [{ description: 'Consulting hour', quantity: 2, unitPrice: 150 }] }),
    },
    {
      id: 'get_invoice', name: 'Get invoice details', description: 'Fetch an invoice by ID (includes daysOverdue).',
      risk: 'read', input: z.object({ id: id('invoice') }), output: invoice,
      handler: ({ id: iid }, ctx) => withOverdue(ctx.get('invoices', iid, 'invoice'), ctx),
      example: (ctx) => ({ id: ctx.all('invoices')[0].id }),
    },
    {
      id: 'search_invoices', name: 'Search invoices',
      description: 'Find invoices by status, contact, due/issue date range, amount range, or number. Use list_overdue_invoices for overdue-specific queries.',
      risk: 'read',
      input: z.object({
        query: z.string().optional().describe('invoice number'), status: z.enum(['draft', 'sent', 'partially_paid', 'paid', 'void']).optional(),
        contactId: z.string().optional(), dueDateAfter: isoDate().optional(), dueDateBefore: isoDate().optional(),
        issueDateAfter: isoDate().optional(), issueDateBefore: isoDate().optional(), totalMin: z.number().optional(), totalMax: z.number().optional(), limit,
      }),
      output: z.looseObject({ total: z.number(), items: z.array(invoice) }),
      handler: ({ query, limit: lim, ...f }, ctx) =>
        page(ctx.all('invoices').filter((i) => (!query || i.number.toLowerCase().includes(query.toLowerCase())) && matchFilters(i, f)).map((i) => withOverdue(i, ctx)), lim),
      example: () => ({ status: 'sent' }),
    },
    {
      id: 'add_invoice_line_item', name: 'Add invoice line item', description: 'Add a line item to a draft invoice; totals are recalculated.',
      risk: 'write',
      input: z.object({ id: id('invoice'), ...lineInput }),
      output: invoice,
      handler: ({ id: iid, ...l }, ctx) => {
        const inv = ctx.get('invoices', iid, 'invoice');
        draftOnly(inv);
        if (l.productId) ctx.get('products', l.productId, 'product');
        inv.lineItems.push({ id: ctx.newId('li'), productId: l.productId ?? null, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, amount: r2(l.quantity * l.unitPrice) });
        return ctx.patch(recalc(inv), {});
      },
      example: (ctx) => ({ id: ctx.all('invoices').find((i) => i.status === 'draft').id, description: 'Setup fee', unitPrice: 99 }),
    },
    {
      id: 'update_draft_invoice', name: 'Update draft invoice', description: 'Change notes, currency, discount, or contact on a draft invoice.',
      ...ops.update('invoices', {
        what: 'invoice', fields: { notes: z.string(), currency: z.string().length(3).transform((s) => s.toUpperCase()), discount: z.number().nonnegative(), contactId: z.string() },
        guard: (inv, i, ctx) => {
          draftOnly(inv);
          if (i.discount > inv.subtotal) fail('VALIDATION', `discount ${i.discount} exceeds invoice ${inv.number} subtotal ${inv.subtotal}; add line items first or lower the discount`);
          if (i.contactId) ctx.get('contacts', i.contactId, 'contact');
        },
        after: (inv) => recalc(inv),
      }),
      example: (ctx) => ({ id: ctx.all('invoices').find((i) => i.status === 'draft').id, notes: 'Net 30' }),
    },
    {
      id: 'set_invoice_due_date', name: 'Set invoice due date', description: 'Change the due date of a draft or unpaid invoice.',
      ...ops.set('invoices', 'dueDate', isoDate(), {
        what: 'invoice', map: (v) => v.slice(0, 10),
        guard: (inv) => ['paid', 'void'].includes(inv.status) && fail('INVALID_STATE', `invoice ${inv.number} is ${inv.status}`),
      }),
      example: (ctx) => ({ id: ctx.all('invoices').find((i) => i.status === 'sent').id, dueDate: '2026-11-30' }),
    },
    {
      id: 'issue_invoice', name: 'Issue invoice', description: 'Finalize a draft invoice (status sent) and email it to the customer. Requires at least one line item and a due date. Result.delivery says whether the email went out (no email / unsubscribed => issued but not emailed).',
      keywords: ['send invoice', 'finalize invoice'],
      risk: 'external',
      input: z.object({ id: id('invoice') }),
      output: invoice,
      handler: ({ id: iid }, ctx) => {
        const inv = ctx.get('invoices', iid, 'invoice');
        draftOnly(inv);
        if (!inv.lineItems.length) fail('VALIDATION', 'invoice has no line items; add one with add_invoice_line_item');
        if (!inv.dueDate) fail('VALIDATION', 'invoice has no due date; set one with set_invoice_due_date');
        const c = ctx.get('contacts', inv.contactId, 'contact');
        // The invoice is issued either way; the result says honestly whether it was emailed.
        const canEmail = !!c.email && c.preferences?.email !== false;
        const msg = canEmail
          ? ctx.insert('messages', { channel: 'email', direction: 'outbound', contactId: c.id, to: c.email, subject: `Invoice ${inv.number}`, body: `Hi ${c.firstName}, your invoice ${inv.number} for ${inv.currency} ${inv.balance} is due ${inv.dueDate}.`, status: 'sent', sentAt: ctx.now, relatedType: 'invoices', relatedId: inv.id, purpose: 'invoice' })
          : null;
        ctx.patch(inv, { status: 'sent', issueDate: ctx.today });
        return { ...inv, delivery: msg ? { emailed: true, messageId: msg.id, to: c.email } : { emailed: false, reason: c.email ? `${c.name} has unsubscribed from email` : `${c.name} has no email address` } };
      },
      example: (ctx) => ({ id: ctx.all('invoices').find((i) => i.status === 'draft' && i.lineItems.length && i.dueDate).id }),
    },
    {
      id: 'send_invoice_reminder', name: 'Send invoice reminder',
      description: 'Immediately send a payment reminder for an unpaid invoice to the customer by email or SMS and record it on the invoice. (To prepare a reminder without sending, draft an email instead.)',
      keywords: ['payment reminder', 'dunning', 'chase payment', 'nudge unpaid'],
      risk: 'external',
      input: z.object({ id: id('invoice'), channel: z.enum(['email', 'sms']).default('email'), message: z.string().optional() }),
      output: invoice,
      handler: ({ id: iid, channel, message }, ctx) => {
        const inv = ctx.get('invoices', iid, 'invoice');
        if (!OPEN.includes(inv.status) || inv.balance <= 0) fail('INVALID_STATE', `invoice ${inv.number} is ${inv.status} with balance ${inv.balance}; reminders need an unpaid issued invoice`);
        const c = ctx.get('contacts', inv.contactId, 'contact');
        if (c.preferences?.[channel] === false) fail('PERMISSION', `${c.name} has opted out of ${channel}`);
        const to = channel === 'email' ? c.email : c.phone;
        if (!to) fail('VALIDATION', `${c.name} has no ${channel === 'email' ? 'email address' : 'phone number'}; use the other channel`);
        const msg = ctx.insert('messages', {
          channel, direction: 'outbound', contactId: c.id, to, subject: channel === 'email' ? `Reminder: invoice ${inv.number} is due` : null,
          body: message || `Hi ${c.firstName}, a friendly reminder that invoice ${inv.number} (${inv.currency} ${inv.balance}) was due on ${inv.dueDate}.`,
          status: 'sent', sentAt: ctx.now, relatedType: 'invoices', relatedId: inv.id, purpose: 'invoice_reminder',
        });
        inv.remindersSent.push({ at: ctx.now, channel, messageId: msg.id });
        return ctx.patch(inv, { lastReminderAt: ctx.now });
      },
      example: (ctx) => ({ id: ctx.all('invoices').find((i) => i.status === 'sent' && i.balance > 0).id }),
    },
    {
      id: 'void_invoice', name: 'Void unpaid invoice', description: 'Void a draft or sent invoice that has no payments applied.',
      ...ops.transition('invoices', {
        to: 'void', from: ['draft', 'sent'], risk: 'destructive', what: 'invoice',
        guard: (inv) => inv.amountPaid > 0 && fail('INVALID_STATE', `invoice ${inv.number} has payments (${inv.amountPaid}); refund instead`),
        extra: (inv, _, ctx) => { // a voided invoice must not keep a live pay link
          for (const r of ctx.all('payment_requests')) if (r.invoiceId === inv.id && r.status === 'open') ctx.patch(r, { status: 'cancelled', cancelledAt: ctx.now, cancelReason: `invoice ${inv.number} voided` });
          return {};
        },
      }),
      example: (ctx) => ({ id: ctx.all('invoices').find((i) => i.status === 'sent' && i.amountPaid === 0).id }),
    },
    {
      id: 'list_overdue_invoices', name: 'List overdue invoices',
      description: 'Unpaid issued invoices past their due date, with daysOverdue, balance, contact and lastReminderAt. Filter by minimum days overdue, contact, or exclude invoices reminded since a date.',
      keywords: ['late payments', 'unpaid invoices', 'past due', 'outstanding balance', 'accounts receivable'],
      risk: 'read',
      input: z.object({
        minDaysOverdue: z.number().int().min(0).default(1).describe('only invoices overdue by at least this many days'),
        contactId: z.string().optional(),
        notRemindedSince: isoDate().optional().describe('exclude invoices whose last reminder is on/after this date'),
        limit,
      }),
      output: z.looseObject({ total: z.number(), items: z.array(z.looseObject({ id: z.string(), daysOverdue: z.number() })) }),
      handler: ({ minDaysOverdue, contactId, notRemindedSince, limit: lim }, ctx) => {
        const rows = ctx.all('invoices')
          .map((i) => withOverdue(i, ctx))
          .filter((i) => i.daysOverdue >= Math.max(1, minDaysOverdue) && (!contactId || i.contactId === contactId))
          .filter((i) => !notRemindedSince || !i.lastReminderAt || Date.parse(i.lastReminderAt) < Date.parse(notRemindedSince))
          .sort((a, b) => b.daysOverdue - a.daysOverdue)
          .map((i) => ({ id: i.id, number: i.number, contactId: i.contactId, contactName: ctx.find('contacts', i.contactId)?.name, status: i.status, dueDate: i.dueDate, daysOverdue: i.daysOverdue, balance: i.balance, currency: i.currency, lastReminderAt: i.lastReminderAt }));
        return page(rows, lim);
      },
      example: () => ({ minDaysOverdue: 15 }),
    },
  ],

  seed(ctx, h) {
    const contacts = ctx.all('contacts').filter((c) => c.status === 'active');
    const products = ctx.all('products').filter((p) => p.status === 'active');
    const desc = ['Website maintenance', 'SEO retainer', 'Ad management', 'Consulting', 'Photography session', 'Dental cleaning', 'Membership fee'];
    // Overdue fixtures (days overdue, reminded?) — 'this_week' = Mon 2026-11-02, 'last_week' = 2026-10-28.
    const overdue = [[5, null], [10, null], [16, null], [18, 'this_week'], [20, null], [25, 'last_week'], [31, 'this_week'], [35, null], [45, 'last_week'], [60, null]];
    let n = 1000;
    const mk = (c, status, dueDays, paidFrac = 0) => {
      const items = Array.from({ length: h.int(1, 3) }, () => {
        const p = products.length && h.chance(0.4) ? h.pick(products) : null;
        const qty = h.int(1, 3), unit = h.pick([75, 120, 150, 250, 400, 600]);
        return { id: ctx.newId('li'), productId: p?.id ?? null, description: p?.name ?? h.pick(desc), quantity: qty, unitPrice: unit, amount: qty * unit };
      });
      const due = h.dateOnly(h.daysAgo(dueDays));
      const inv = {
        number: `INV-${++n}`, contactId: c.id, status, issueDate: status === 'draft' ? null : h.dateOnly(h.daysAgo(dueDays + 30)), dueDate: due,
        currency: 'USD', notes: null, discount: 0, tax: 0, lineItems: items, amountPaid: 0, remindersSent: [], lastReminderAt: null,
        createdAt: h.daysAgo(dueDays + 31),
      };
      recalc(inv);
      inv.amountPaid = r2(inv.total * paidFrac);
      return recalc(inv);
    };
    const rows = [];
    overdue.forEach(([d, rem], i) => {
      const inv = mk(contacts[(i * 7 + 3) % contacts.length], i === 4 ? 'partially_paid' : 'sent', d, i === 4 ? 0.5 : 0);
      if (rem) inv._rem = rem === 'this_week' ? '2026-11-02T14:00:00.000Z' : '2026-10-28T14:00:00.000Z';
      rows.push(inv);
    });
    for (let i = 0; i < 6; i++) rows.push(mk(contacts[(i * 11 + 1) % contacts.length], 'sent', -h.int(3, 25))); // not yet due
    for (let i = 0; i < 8; i++) rows.push(mk(contacts[(i * 5 + 2) % contacts.length], 'paid', h.int(5, 90), 1));
    for (let i = 0; i < 4; i++) rows.push(mk(contacts[(i * 13 + 4) % contacts.length], 'draft', -h.int(10, 30)));
    rows.push(mk(contacts[9], 'void', 40));
    rows.push(mk(contacts[0], 'sent', 2)); // Sarah Johnson: slightly overdue
    for (const r of rows) {
      const rem = r._rem;
      delete r._rem;
      const inv = ctx.insert('invoices', r);
      if (rem) {
        const c = ctx.find('contacts', inv.contactId);
        const msg = ctx.insert('messages', {
          channel: 'email', direction: 'outbound', contactId: c.id, to: c.email, subject: `Reminder: invoice ${inv.number} is due`,
          body: `Hi ${c.firstName}, invoice ${inv.number} is overdue.`, status: 'delivered', sentAt: rem, relatedType: 'invoices', relatedId: inv.id,
          purpose: 'invoice_reminder', createdAt: rem,
        });
        inv.remindersSent.push({ at: rem, channel: 'email', messageId: msg.id });
        inv.lastReminderAt = rem;
      }
    }
  },
});
