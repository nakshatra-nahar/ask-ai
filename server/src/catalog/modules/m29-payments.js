import { defineModule, ops, z, id, entity, isoDate, limit, fail, page, matchFilters, addDays, toTime, round2 } from '../kit.js';

const STATUSES = ['pending', 'succeeded', 'failed', 'refunded', 'partially_refunded'];
const METHODS = ['card', 'ach', 'bank_transfer', 'cash', 'check'];
const allocation = z.looseObject({ invoiceId: z.string(), amount: z.number() });
export const paymentSchema = entity({
  contactId: z.string(), invoiceId: z.string().nullable().optional(), amount: z.number(), currency: z.string(), method: z.enum(METHODS),
  status: z.enum(STATUSES), allocations: z.array(allocation), refundedAmount: z.number(),
  failureCode: z.string().nullable().optional(), failureMessage: z.string().nullable().optional(), paidAt: z.string().nullable().optional(),
});
const preq = entity({
  contactId: z.string(), invoiceId: z.string().nullable().optional(), amount: z.number(), currency: z.string(), description: z.string(),
  status: z.enum(['open', 'paid', 'cancelled', 'expired']), link: z.string(), expiresAt: z.string(), paymentId: z.string().nullable().optional(),
});
const OPEN_INV = ['sent', 'partially_paid'];
const CAPTURED = ['succeeded', 'partially_refunded'];
const FAILURES = {
  card_declined: ['The card was declined by the issuing bank.', 'Ask the customer for another card or to contact their bank; send a new payment request.', false],
  insufficient_funds: ['The card has insufficient funds.', 'Retry in a few days or ask for another payment method.', true],
  expired_card: ['The card has expired.', 'Request updated card details with a payment request link.', false],
};
// Simulated processor test cards (Stripe-style): ...0002 declined, ...9995 insufficient funds, ...0069 expired; anything else succeeds.
const CARD_OUTCOME = { '0002': 'card_declined', 9995: 'insufficient_funds', '0069': 'expired_card' };

/** Apply a payment delta (+ allocate, − reverse) to an invoice: amountPaid, balance = total − amountPaid, status. */
export function applyInvoicePayment(ctx, inv, delta) {
  const amountPaid = round2((inv.amountPaid || 0) + delta);
  const balance = round2(inv.total - amountPaid);
  const status = inv.status === 'void' ? 'void' : balance <= 0 ? 'paid' : amountPaid > 0 ? 'partially_paid' : 'sent';
  return ctx.patch(inv, { amountPaid, balance, status, paidAt: status === 'paid' ? ctx.now : null });
}
export const allocatedTotal = (p) => round2((p.allocations || []).reduce((s, a) => s + a.amount, 0));
export const unallocated = (p) => (CAPTURED.includes(p.status) ? round2(p.amount - (p.refundedAmount || 0) - allocatedTotal(p)) : 0);
const view = (p) => ({ ...p, unallocatedAmount: unallocated(p) });
const reqView = (ctx, r) => (r.status === 'open' && toTime(r.expiresAt) < toTime(ctx.now) ? { ...r, status: 'expired' } : r);

function openInvoice(ctx, invoiceId) {
  const inv = ctx.get('invoices', invoiceId, 'invoice');
  if (!OPEN_INV.includes(inv.status) || inv.balance <= 0)
    fail('INVALID_STATE', `invoice ${inv.number} is '${inv.status}' with balance ${inv.balance}; payments apply only to sent or partially_paid invoices with a balance${inv.status === 'draft' ? ' (send the invoice first)' : ''}`);
  return inv;
}
const findPay = (ctx, f) => ctx.all('payments').find(f);

export default defineModule({
  id: 'payments',
  code: 'M29',
  name: 'Payments',
  description: 'Track payment attempts and invoice settlement.',
  tables: { payments: { prefix: 'pay', schema: paymentSchema }, payment_requests: { prefix: 'preq', schema: preq } },
  actions: [
    {
      id: 'create_payment_request', name: 'Create payment request',
      description: 'Send the customer a pay-now link for an invoice balance (or part of it) or a custom amount. This collects money; to just nudge about an unpaid invoice use invoices.send_invoice_reminder.',
      keywords: ['payment link', 'request payment', 'collect payment', 'pay link'],
      risk: 'external',
      input: z.object({
        invoiceId: z.string().optional().describe('request the balance of this invoice'), contactId: z.string().optional().describe('required for custom-amount requests'),
        amount: z.number().positive().optional().describe('default: full invoice balance'), description: z.string().optional(),
        channel: z.enum(['email', 'sms']).default('email'), expiresInDays: z.number().int().min(1).max(90).default(7),
      }).refine((i) => i.invoiceId || (i.contactId && i.amount), 'provide invoiceId, or contactId + amount for a custom request'),
      output: preq,
      handler: (i, ctx) => {
        const inv = i.invoiceId && openInvoice(ctx, i.invoiceId);
        const contactId = inv?.contactId ?? i.contactId;
        if (inv && i.contactId && i.contactId !== inv.contactId) fail('VALIDATION', `invoice ${inv.number} belongs to ${inv.contactId}, not ${i.contactId}`);
        const c = ctx.get('contacts', contactId, 'contact');
        const to = i.channel === 'email' ? c.email : c.phone;
        if (!to) fail('VALIDATION', `contact ${c.id} has no ${i.channel === 'email' ? 'email' : 'phone'}; use the other channel`);
        if (i.channel === 'sms' && c.preferences?.sms === false) fail('PERMISSION', `contact ${c.id} opted out of SMS; use channel email`);
        const amount = round2(i.amount ?? inv.balance);
        if (inv && amount > inv.balance) fail('VALIDATION', `amount ${amount} exceeds invoice ${inv.number} balance ${inv.balance}`);
        if (inv) {
          const dup = ctx.all('payment_requests').find((r) => r.invoiceId === inv.id && reqView(ctx, r).status === 'open');
          if (dup) fail('DUPLICATE', `payment request ${dup.id} is already open for invoice ${inv.number} (${dup.link}); cancel it first or resend that link`, { existingId: dup.id });
        }
        const r = ctx.insert('payment_requests', {
          contactId, invoiceId: inv?.id ?? null, amount, currency: inv?.currency ?? 'USD',
          description: i.description ?? (inv ? `Payment for invoice ${inv.number}` : 'Payment request'),
          status: 'open', channel: i.channel, sentTo: to, link: '', expiresAt: addDays(ctx.now, i.expiresInDays), paymentId: null, sentAt: ctx.now,
        });
        return ctx.patch(r, { link: `https://pay.example.com/r/${r.id}` });
      },
      example: (ctx) => {
        const taken = new Set(ctx.all('payment_requests').filter((r) => r.status === 'open').map((r) => r.invoiceId));
        const inv = ctx.all('invoices').find((x) => OPEN_INV.includes(x.status) && x.balance > 0 && !taken.has(x.id));
        return inv ? { invoiceId: inv.id } : { contactId: 'con_001', amount: 150, description: 'Deposit' };
      },
    },
    {
      id: 'get_payment_request', name: 'Get payment request', description: 'Fetch one payment request (pay link) by ID with its status (open/paid/cancelled/expired) and resulting payment.',
      risk: 'read',
      input: z.object({ id: id('payment request') }),
      output: preq,
      handler: ({ id: rid }, ctx) => reqView(ctx, ctx.get('payment_requests', rid, 'payment request')),
      example: (ctx) => ({ id: ctx.all('payment_requests')[0].id }),
    },
    {
      id: 'cancel_payment_request', name: 'Cancel unpaid payment request', description: 'Cancel an open (unpaid) payment request so its pay link stops working.',
      keywords: ['void payment link', 'revoke pay link'],
      risk: 'destructive',
      input: z.object({ id: id('payment request'), reason: z.string().optional() }),
      output: preq,
      handler: ({ id: rid, reason }, ctx) => {
        const r = ctx.get('payment_requests', rid, 'payment request');
        const st = reqView(ctx, r).status; // a lapsed link reads as 'expired', same as get_payment_request
        if (st !== 'open') fail('INVALID_STATE', `payment request ${rid} is '${st}'; only open requests can be cancelled${st === 'paid' ? ' (refund the payment instead)' : ''}`);
        return ctx.patch(r, { status: 'cancelled', cancelledAt: ctx.now, cancelReason: reason ?? null });
      },
      example: (ctx) => ({ id: ctx.all('payment_requests').find((r) => r.status === 'open').id }),
    },
    {
      id: 'record_payment', name: 'Record simulated payment',
      description: 'Charge/record a payment (simulated processor). Card numbers ending 0002 decline (card_declined), 9995 insufficient_funds, 0069 expired_card; others succeed. With invoiceId (or a paymentRequestId) a successful payment is auto-allocated to the invoice.',
      keywords: ['take payment', 'charge card', 'mark paid', 'record cash payment', 'collect'],
      risk: 'external',
      input: z.object({
        invoiceId: z.string().optional(), paymentRequestId: z.string().optional(), contactId: z.string().optional(),
        amount: z.number().positive().optional().describe('default: invoice balance or payment request amount'), currency: z.string().length(3).optional(),
        method: z.enum(METHODS).default('card'), cardNumber: z.string().regex(/^[\d ]{12,23}$/).optional().describe('simulated card number'),
        reference: z.string().optional().describe('check number / transfer reference'),
      }).refine((i) => i.invoiceId || i.paymentRequestId || (i.contactId && i.amount), 'provide invoiceId, paymentRequestId, or contactId + amount'),
      output: paymentSchema,
      handler: (i, ctx) => {
        let req, inv;
        if (i.paymentRequestId) {
          req = reqView(ctx, ctx.get('payment_requests', i.paymentRequestId, 'payment request'));
          if (req.status !== 'open') fail('INVALID_STATE', `payment request ${req.id} is '${req.status}'; create a new request`);
          if (i.amount != null && i.amount !== req.amount) fail('VALIDATION', `payment request ${req.id} is for exactly ${req.amount}`);
          if (i.invoiceId && req.invoiceId && i.invoiceId !== req.invoiceId) fail('VALIDATION', `payment request ${req.id} is for invoice ${req.invoiceId}`);
        }
        const invoiceId = i.invoiceId ?? req?.invoiceId;
        if (invoiceId) inv = openInvoice(ctx, invoiceId);
        const contactId = i.contactId ?? inv?.contactId ?? req.contactId;
        ctx.get('contacts', contactId, 'contact');
        if (inv && contactId !== inv.contactId) fail('VALIDATION', `invoice ${inv.number} belongs to ${inv.contactId}, not ${contactId}`);
        if (req && contactId !== req.contactId) fail('VALIDATION', `payment request ${req.id} belongs to ${req.contactId}, not ${contactId}`);
        const currency = (i.currency ?? inv?.currency ?? req?.currency ?? 'USD').toUpperCase();
        const expected = inv?.currency ?? req?.currency;
        if (expected && currency !== expected) fail('VALIDATION', `${inv ? `invoice ${inv.number}` : `payment request ${req.id}`} is in ${expected}; pay in ${expected} (got ${currency})`);
        const amount = round2(i.amount ?? req?.amount ?? inv.balance);
        const last4 = i.method === 'card' ? (i.cardNumber || '4242424242424242').replace(/\s/g, '').slice(-4) : null;
        const code = last4 && CARD_OUTCOME[last4];
        const p = ctx.insert('payments', {
          contactId, invoiceId: inv?.id ?? null, amount, currency, method: i.method,
          status: code ? 'failed' : 'succeeded', allocations: [], refundedAmount: 0, failureCode: code || null, failureMessage: code ? FAILURES[code][0] : null,
          paidAt: code ? null : ctx.now, attemptedAt: ctx.now, cardLast4: last4, reference: i.reference ?? null, paymentRequestId: req?.id ?? null, receiptNumber: null,
        });
        if (!code && inv) {
          const alloc = round2(Math.min(amount, inv.balance));
          p.allocations.push({ invoiceId: inv.id, amount: alloc });
          applyInvoicePayment(ctx, inv, alloc);
        }
        if (!code && req) ctx.patch(ctx.find('payment_requests', req.id), { status: 'paid', paymentId: p.id, paidAt: ctx.now });
        return { ...view(p), invoice: inv ? { id: inv.id, number: inv.number, status: inv.status, amountPaid: inv.amountPaid, balance: inv.balance } : null };
      },
      example: (ctx) => {
        const inv = ctx.all('invoices').find((x) => OPEN_INV.includes(x.status) && x.balance > 0);
        return inv ? { invoiceId: inv.id, cardNumber: '4242 4242 4242 4242' } : { contactId: 'con_001', amount: 99, method: 'cash' };
      },
    },
    {
      id: 'get_payment', name: 'Get payment details', description: 'Fetch one payment by ID: amount, status, method, invoice allocations, unallocated amount and refunded amount.',
      risk: 'read',
      input: z.object({ id: id('payment') }),
      output: paymentSchema,
      handler: ({ id: pid }, ctx) => view(ctx.get('payments', pid, 'payment')),
      example: (ctx) => ({ id: ctx.all('payments')[0].id }),
    },
    {
      id: 'search_payments', name: 'Search payments',
      description: 'Find payment attempts by contact, invoice (including allocations), status, method, amount range or payment date range.',
      keywords: ['list payments', 'failed payments', 'transactions', 'payment history'],
      risk: 'read',
      input: z.object({
        contactId: z.string().optional(), invoiceId: z.string().optional().describe('payments recorded against or allocated to this invoice'),
        status: z.enum(STATUSES).optional(), method: z.enum(METHODS).optional(), amountMin: z.number().optional(), amountMax: z.number().optional(),
        paidAtAfter: isoDate().optional(), paidAtBefore: isoDate().optional(), limit,
      }),
      output: z.looseObject({ total: z.number(), items: z.array(paymentSchema) }),
      handler: ({ invoiceId, limit: lim, ...f }, ctx) =>
        page(ctx.all('payments').filter((p) => matchFilters(p, f) && (!invoiceId || p.invoiceId === invoiceId || p.allocations.some((a) => a.invoiceId === invoiceId))).map(view), lim),
      example: () => ({ status: 'failed' }),
    },
    {
      id: 'allocate_payment', name: 'Allocate payment to invoice',
      description: "Apply part of a payment's unallocated amount to an open invoice of the same contact; updates the invoice amountPaid, balance and status.",
      keywords: ['apply payment', 'match payment to invoice', 'apply credit'],
      risk: 'write',
      input: z.object({ id: id('payment'), invoiceId: id('invoice'), amount: z.number().positive().optional().describe('default: min(unallocated, invoice balance)') }),
      output: paymentSchema,
      handler: ({ id: pid, invoiceId, amount }, ctx) => {
        const p = ctx.get('payments', pid, 'payment');
        if (!CAPTURED.includes(p.status)) fail('INVALID_STATE', `payment ${pid} is '${p.status}'; only succeeded payments can be allocated`);
        const inv = openInvoice(ctx, invoiceId);
        if (inv.contactId !== p.contactId) fail('CONFLICT', `invoice ${inv.number} belongs to ${inv.contactId} but payment ${pid} is from ${p.contactId}`);
        if (inv.currency !== p.currency) fail('CONFLICT', `invoice ${inv.number} is in ${inv.currency} but payment ${pid} is in ${p.currency}`);
        const free = unallocated(p);
        const amt = round2(amount ?? Math.min(free, inv.balance));
        if (amt <= 0 || amt > free) fail('INSUFFICIENT_BALANCE', `payment ${pid} has ${free} unallocated; cannot allocate ${amt}`);
        if (amt > inv.balance) fail('VALIDATION', `invoice ${inv.number} balance is ${inv.balance}; allocate at most that`);
        const existing = p.allocations.find((a) => a.invoiceId === inv.id);
        if (existing) existing.amount = round2(existing.amount + amt);
        else p.allocations.push({ invoiceId: inv.id, amount: amt });
        applyInvoicePayment(ctx, inv, amt);
        ctx.patch(p, { invoiceId: p.invoiceId ?? inv.id });
        return { ...view(p), invoice: { id: inv.id, number: inv.number, status: inv.status, amountPaid: inv.amountPaid, balance: inv.balance } };
      },
      example: (ctx) => {
        const p = ctx.all('payments').find((x) => unallocated(x) > 0);
        const inv = ctx.all('invoices').find((x) => x.contactId === p.contactId && OPEN_INV.includes(x.status) && x.balance > 0);
        return { id: p.id, invoiceId: inv?.id ?? 'inv_001' };
      },
    },
    {
      id: 'remove_payment_allocation', name: 'Remove payment allocation',
      description: 'Un-apply a payment from an invoice: the allocated amount returns to the payment as unallocated and the invoice amountPaid/balance/status are reversed. Money is not refunded (use refunds for that).',
      keywords: ['unapply payment', 'reverse allocation', 'misapplied payment'],
      risk: 'write',
      input: z.object({ id: id('payment'), invoiceId: id('invoice') }),
      output: paymentSchema,
      handler: ({ id: pid, invoiceId }, ctx) => {
        const p = ctx.get('payments', pid, 'payment');
        const a = p.allocations.find((x) => x.invoiceId === invoiceId);
        if (!a) fail('NOT_FOUND', `payment ${pid} is not allocated to ${invoiceId}; allocations: ${p.allocations.map((x) => `${x.invoiceId} ${x.amount}`).join(', ') || 'none'}`);
        const inv = ctx.get('invoices', invoiceId, 'invoice');
        if (inv.status === 'void') fail('INVALID_STATE', `invoice ${inv.number} is void; its payments cannot be changed`);
        p.allocations = p.allocations.filter((x) => x !== a);
        applyInvoicePayment(ctx, inv, -a.amount);
        ctx.patch(p, { invoiceId: p.allocations[0]?.invoiceId ?? null });
        return { ...view(p), removed: a, invoice: { id: inv.id, number: inv.number, status: inv.status, amountPaid: inv.amountPaid, balance: inv.balance } };
      },
      example: (ctx) => {
        const p = ctx.all('payments').find((x) => x.allocations.length) || ctx.all('payments')[0];
        return { id: p.id, invoiceId: p.allocations[0]?.invoiceId ?? 'inv_001' };
      },
    },
    {
      id: 'generate_payment_receipt', name: 'Generate payment receipt',
      description: 'Issue (or re-fetch) the receipt for a successful payment: receipt number and printable text. Failed or pending payments have no receipt.',
      keywords: ['receipt', 'proof of payment'],
      risk: 'write',
      input: z.object({ id: id('payment') }),
      output: z.looseObject({ paymentId: z.string(), receiptNumber: z.string(), text: z.string() }),
      handler: ({ id: pid }, ctx) => {
        const p = ctx.get('payments', pid, 'payment');
        if (!CAPTURED.includes(p.status) && p.status !== 'refunded') fail('INVALID_STATE', `payment ${pid} is '${p.status}'; receipts exist only for successful payments`);
        if (!p.receiptNumber) ctx.patch(p, { receiptNumber: `RCPT-${p.id.split('_')[1]}`, receiptIssuedAt: ctx.now });
        const c = ctx.find('contacts', p.contactId);
        const invs = p.allocations.map((a) => `${ctx.find('invoices', a.invoiceId)?.number ?? a.invoiceId}: ${a.amount.toFixed(2)}`);
        const text = [
          `Receipt ${p.receiptNumber}`, `Date: ${(p.paidAt || p.createdAt).slice(0, 10)}`, `Received from: ${c?.name ?? p.contactId}`,
          `Amount: ${p.amount.toFixed(2)} ${p.currency} via ${p.method}${p.cardLast4 ? ` ****${p.cardLast4}` : ''}`,
          ...(invs.length ? [`Applied to: ${invs.join(', ')}`] : []), ...(p.refundedAmount ? [`Refunded: ${p.refundedAmount.toFixed(2)}`] : []),
        ].join('\n');
        return { paymentId: p.id, receiptNumber: p.receiptNumber, issuedAt: p.receiptIssuedAt, amount: p.amount, currency: p.currency, text };
      },
      example: (ctx) => ({ id: ctx.all('payments').find((p) => p.status === 'succeeded' && !p.receiptNumber).id }),
    },
    {
      id: 'get_payment_failure', name: 'Get payment failure details',
      description: 'Explain why a failed payment attempt failed: decline code, message, whether a retry may work, recommended next step, and other failed attempts by the same customer.',
      keywords: ['declined', 'why did payment fail', 'decline reason'],
      risk: 'read',
      input: z.object({ id: id('payment') }),
      output: z.looseObject({ paymentId: z.string(), failureCode: z.string(), failureMessage: z.string(), retryable: z.boolean(), recommendedAction: z.string() }),
      handler: ({ id: pid }, ctx) => {
        const p = ctx.get('payments', pid, 'payment');
        if (p.status !== 'failed') fail('INVALID_STATE', `payment ${pid} did not fail (status '${p.status}')`);
        const [msg, action, retryable] = FAILURES[p.failureCode] || [p.failureMessage || 'Processing error', 'Retry the payment or use another method.', true];
        return {
          paymentId: p.id, contactId: p.contactId, invoiceId: p.invoiceId, amount: p.amount, attemptedAt: p.attemptedAt ?? p.createdAt, method: p.method, cardLast4: p.cardLast4 ?? null,
          failureCode: p.failureCode ?? 'processing_error', failureMessage: p.failureMessage ?? msg, retryable, recommendedAction: action,
          otherFailedAttempts: ctx.all('payments').filter((x) => x.id !== p.id && x.status === 'failed' && x.contactId === p.contactId).map((x) => x.id),
        };
      },
      example: (ctx) => ({ id: ctx.all('payments').find((p) => p.status === 'failed').id }),
    },
  ],

  seed(ctx, h) {
    const invoices = ctx.all('invoices');
    const contacts = ctx.all('contacts');
    const con = (i) => contacts[i]?.id ?? `con_${String(i + 1).padStart(3, '0')}`;
    const pay = (r) => ctx.insert('payments', {
      currency: 'USD', allocations: [], refundedAmount: 0, failureCode: null, failureMessage: null, cardLast4: null, reference: null,
      paymentRequestId: null, receiptNumber: null, ...r, attemptedAt: r.paidAt ?? r.attemptedAt, createdAt: r.paidAt ?? r.attemptedAt,
    });
    // 1) Every invoice with money received gets the succeeded payment that explains it.
    for (const inv of invoices.filter((x) => x.amountPaid > 0)) {
      const method = h.pick(['card', 'card', 'ach', 'bank_transfer', 'check']);
      const issuedAgo = inv.issueDate ? Math.max(0, Math.floor((toTime(ctx.today) - toTime(inv.issueDate)) / 864e5)) : 10;
      pay({
        contactId: inv.contactId, invoiceId: inv.id, amount: inv.amountPaid, currency: inv.currency || 'USD', method, status: 'succeeded',
        allocations: [{ invoiceId: inv.id, amount: inv.amountPaid }], paidAt: h.daysAgo(Math.max(0, issuedAgo - h.int(2, 20))), cardLast4: method === 'card' ? h.pick(['4242', '1881', '5556']) : null,
      });
    }
    // 2) Failed card attempts on overdue invoices.
    const overdue = invoices.filter((x) => OPEN_INV.includes(x.status) && x.dueDate && x.dueDate < ctx.today);
    ['card_declined', 'insufficient_funds', 'expired_card'].forEach((code, i) => {
      const inv = overdue[i];
      pay({
        contactId: inv?.contactId ?? con(i + 2), invoiceId: inv?.id ?? null, amount: inv?.balance ?? 250, currency: inv?.currency || 'USD', method: 'card', status: 'failed',
        failureCode: code, failureMessage: FAILURES[code][0], paidAt: null, attemptedAt: h.daysAgo(i + 1), cardLast4: Object.keys(CARD_OUTCOME).find((k) => CARD_OUTCOME[k] === code),
      });
    });
    // 3) An unallocated check from a customer who still has an open invoice (to exercise allocate_payment).
    const open = invoices.filter((x) => OPEN_INV.includes(x.status) && x.balance > 0);
    const target = open.find((x) => !overdue.slice(0, 3).includes(x)) ?? open[0];
    pay({ contactId: target?.contactId ?? con(0), invoiceId: null, amount: 250, method: 'check', status: 'succeeded', paidAt: h.daysAgo(2), reference: 'Check #4471' });
    // Payment requests: one open for an overdue invoice, one cancelled, one lapsed.
    const req = (r) => {
      const x = ctx.insert('payment_requests', { currency: 'USD', paymentId: null, channel: 'email', link: '', ...r });
      x.link = `https://pay.example.com/r/${x.id}`;
      x.sentTo = ctx.find('contacts', x.contactId)?.email ?? null;
    };
    if (overdue[0]) req({ contactId: overdue[0].contactId, invoiceId: overdue[0].id, amount: overdue[0].balance, description: `Payment for invoice ${overdue[0].number}`, status: 'open', expiresAt: h.daysFromNow(5), createdAt: h.daysAgo(2) });
    req({ contactId: con(1), invoiceId: null, amount: 300, description: 'Deposit for website build', status: 'cancelled', expiresAt: h.daysAgo(3), createdAt: h.daysAgo(10), cancelledAt: h.daysAgo(9) });
    req({ contactId: con(2), invoiceId: null, amount: 150, description: 'Consultation fee', status: 'open', expiresAt: h.daysAgo(1), createdAt: h.daysAgo(8) });
    if (!overdue[0]) req({ contactId: con(0), invoiceId: null, amount: 99, description: 'Teeth whitening kit', status: 'open', expiresAt: h.daysFromNow(5), createdAt: h.daysAgo(1) });
  },
});
