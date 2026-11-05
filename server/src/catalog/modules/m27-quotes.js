import { defineModule, ops, z, id, entity, isoDate, fail, addDays, toTime, round2 } from '../kit.js';

const STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'];
const lineSchema = z.looseObject({
  id: z.string(), description: z.string(), productId: z.string().nullable(), priceId: z.string().nullable().optional(),
  quantity: z.number(), unitPrice: z.number(), amount: z.number(),
});
const quote = entity({
  number: z.string(), contactId: z.string(), title: z.string(), status: z.enum(STATUSES), lineItems: z.array(lineSchema),
  subtotal: z.number(), discountType: z.enum(['percent', 'amount']).nullable().optional(), discountValue: z.number().nullable().optional(),
  discount: z.number(), total: z.number(), currency: z.string(), expiresAt: z.string().nullable().optional(),
  sentAt: z.string().nullable().optional(), acceptedAt: z.string().nullable().optional(), invoiceId: z.string().nullable().optional(),
});
const lineInput = {
  productId: z.string().optional().describe('catalog product; fills description and price'), priceId: z.string().optional().describe('specific price of the product'),
  description: z.string().min(1).optional(), quantity: z.number().positive().default(1), unitPrice: z.number().nonnegative().optional().describe('overrides the catalog price'),
};
const dateOnly = (iso) => iso.slice(0, 10);

function buildLine(ctx, i, currency) {
  let description = i.description, unitPrice = i.unitPrice, priceId = null;
  if (i.productId) {
    const p = ctx.get('products', i.productId, 'product');
    if (p.status !== 'active') fail('INVALID_STATE', `product ${p.id} (${p.name}) is archived and cannot be quoted`);
    const price = i.priceId ? ctx.get('prices', i.priceId, 'price') : p.defaultPriceId ? ctx.find('prices', p.defaultPriceId) : null;
    if (price && price.productId !== p.id) fail('VALIDATION', `price ${price.id} belongs to product ${price.productId}, not ${p.id}`);
    if (price && price.status !== 'active') fail('INVALID_STATE', `price ${price.id} is archived; choose an active price`);
    if (price && unitPrice == null && price.currency !== currency) fail('VALIDATION', `price ${price.id} is in ${price.currency} but the quote is in ${currency}; pass unitPrice`);
    priceId = price?.id ?? null;
    unitPrice ??= price?.amount;
    description ??= price && price.interval !== 'one_time' ? `${p.name} (per ${price.interval})` : p.name;
  } else if (i.priceId) fail('VALIDATION', 'priceId requires productId');
  if (!description || unitPrice == null) fail('VALIDATION', 'each line needs productId (with a default price), or both description and unitPrice');
  return { id: ctx.newId('qli'), description, productId: i.productId ?? null, priceId, quantity: i.quantity, unitPrice, amount: round2(unitPrice * i.quantity) };
}
function recalc(ctx, q) {
  q.subtotal = round2(q.lineItems.reduce((s, l) => s + l.amount, 0));
  q.discount = !q.discountType ? 0 : round2(Math.min(q.subtotal, q.discountType === 'percent' ? (q.subtotal * q.discountValue) / 100 : q.discountValue));
  q.total = round2(q.subtotal - q.discount);
  return ctx.patch(q, {});
}
function draft(ctx, qid) {
  const q = ctx.get('quotes', qid, 'quote');
  if (q.status !== 'draft') fail('INVALID_STATE', `quote ${q.number} is '${q.status}'; only draft quotes can be edited (create a new quote to revise a sent one)`);
  return q;
}
const notPast = (ctx, d) => toTime(d, true) < toTime(ctx.today) && fail('VALIDATION', `expiry ${d} is in the past (today is ${ctx.today})`);
const isExpired = (ctx, q) => q.expiresAt && toTime(q.expiresAt, true) < toTime(ctx.now);
const nextNum = (rows, prefix, start) => {
  let max = start, width = String(start).length;
  for (const r of rows) {
    const m = /(\d+)\s*$/.exec(r.number || '');
    if (m && +m[1] > max) (max = +m[1]), (width = m[1].length);
  }
  return `${prefix}${String(max + 1).padStart(width, '0')}`;
};
const byNum = (ctx, n) => ctx.all('quotes').find((q) => q.number === n);

export default defineModule({
  id: 'quotes',
  code: 'M27',
  name: 'Quotes',
  description: 'Prepare proposed purchases for customer acceptance.',
  tables: { quotes: { prefix: 'quo', schema: quote } },
  actions: [
    {
      id: 'create_quote', name: 'Create quote',
      description: 'Draft a quote/estimate/proposal for a contact, optionally with initial line items. Not a bill: convert it to an invoice once accepted.',
      keywords: ['estimate', 'proposal', 'new quote', 'price quote'],
      ...ops.create('quotes', {
        input: z.object({
          contactId: id('contact'), title: z.string().min(1).optional(), expiresAt: isoDate('expiry date, e.g. 2026-12-04').optional(),
          currency: z.string().length(3).transform((s) => s.toUpperCase()).default('USD'),
          lineItems: z.array(z.object(lineInput)).optional(), notes: z.string().optional(),
        }),
        check: (i, ctx) => {
          const c = ctx.get('contacts', i.contactId, 'contact');
          if (c.status !== 'active') fail('INVALID_STATE', `contact ${c.id} is ${c.status}`);
          if (i.expiresAt) notPast(ctx, i.expiresAt);
        },
        build: (i, ctx) => {
          const q = {
            number: nextNum(ctx.all('quotes'), 'Q-', 1000), title: i.title ?? 'Proposal', status: 'draft',
            lineItems: (i.lineItems || []).map((l) => buildLine(ctx, l, i.currency)), discountType: null, discountValue: null,
            expiresAt: i.expiresAt ? dateOnly(i.expiresAt) : null, sentAt: null, acceptedAt: null, invoiceId: null, notes: i.notes ?? '',
          };
          q.subtotal = round2(q.lineItems.reduce((s, l) => s + l.amount, 0));
          return { ...q, discount: 0, total: q.subtotal };
        },
      }),
      example: (ctx) => ({ contactId: 'con_002', title: 'Website + SEO bundle', lineItems: [{ productId: ctx.all('products').find((p) => p.sku === 'WEB-START').id }] }),
    },
    {
      id: 'get_quote', name: 'Get quote details', description: 'Fetch one quote by ID with line items, discount, totals, status, expiry and linked invoice.',
      ...ops.get('quotes', { what: 'quote' }),
      example: (ctx) => ({ id: ctx.all('quotes')[0].id }),
    },
    {
      id: 'search_quotes', name: 'Search quotes',
      description: 'Find quotes by number/title text, contact, status, total range, expiry or created date range.',
      keywords: ['list quotes', 'open proposals', 'pending estimates'],
      ...ops.search('quotes', {
        text: ['number', 'title'],
        filters: {
          contactId: z.string().optional(), status: z.enum(STATUSES).optional(), totalMin: z.number().optional(), totalMax: z.number().optional(),
          expiresAtBefore: isoDate().optional(), expiresAtAfter: isoDate().optional(), createdAtAfter: isoDate().optional(), createdAtBefore: isoDate().optional(),
        },
      }),
      example: () => ({ status: 'sent' }),
    },
    {
      id: 'add_quote_line_item', name: 'Add quote line item',
      description: 'Add a line to a draft quote: a catalog product (price filled from its default or priceId) or a custom description + unitPrice.',
      risk: 'write',
      input: z.object({ id: id('quote'), ...lineInput }),
      output: quote,
      handler: ({ id: qid, ...l }, ctx) => {
        const q = draft(ctx, qid);
        q.lineItems.push(buildLine(ctx, l, q.currency));
        return recalc(ctx, q);
      },
      example: (ctx) => ({ id: byNum(ctx, 'Q-1001').id, productId: ctx.all('products').find((p) => p.sku === 'CONSULT-60').id, quantity: 2 }),
    },
    {
      id: 'update_quote_line_item', name: 'Update quote line item', description: 'Change the description, quantity or unit price of a line on a draft quote.',
      risk: 'write',
      input: z.object({ id: id('quote'), itemId: id('quote line item'), description: z.string().min(1).optional(), quantity: z.number().positive().optional(), unitPrice: z.number().nonnegative().optional() }),
      output: quote,
      handler: ({ id: qid, itemId, ...changes }, ctx) => {
        const q = draft(ctx, qid);
        const l = q.lineItems.find((x) => x.id === itemId);
        if (!l) fail('NOT_FOUND', `line ${itemId} not on quote ${q.number}; lines: ${q.lineItems.map((x) => `${x.id} ${x.description}`).join(', ') || 'none'}`);
        if (!Object.keys(changes).length) fail('VALIDATION', 'provide description, quantity or unitPrice');
        Object.assign(l, changes);
        l.amount = round2(l.quantity * l.unitPrice);
        return recalc(ctx, q);
      },
      example: (ctx) => {
        const q = byNum(ctx, 'Q-1001');
        return { id: q.id, itemId: q.lineItems[0].id, unitPrice: 1299 };
      },
    },
    {
      id: 'set_quote_expiry', name: 'Set quote expiry',
      description: 'Set the date a draft/sent quote stops being acceptable. Extending an expired quote re-opens it as sent.',
      keywords: ['extend quote', 'valid until'],
      risk: 'write',
      input: z.object({ id: id('quote'), expiresAt: isoDate('new expiry date, e.g. 2026-12-15') }),
      output: quote,
      handler: ({ id: qid, expiresAt }, ctx) => {
        const q = ctx.get('quotes', qid, 'quote');
        if (!['draft', 'sent', 'expired'].includes(q.status)) fail('INVALID_STATE', `quote ${q.number} is '${q.status}'; expiry can only change on draft, sent or expired quotes`);
        notPast(ctx, expiresAt);
        return ctx.patch(q, { expiresAt: dateOnly(expiresAt), ...(q.status === 'expired' ? { status: 'sent' } : {}) });
      },
      example: (ctx) => ({ id: byNum(ctx, 'Q-1004').id, expiresAt: '2026-12-15' }),
    },
    {
      id: 'apply_quote_discount', name: 'Apply quote discount',
      description: 'Apply a whole-quote discount to a draft quote, as a percent or a fixed amount (replaces any previous quote discount). For coupon codes on orders use orders.apply_coupon_to_order.',
      risk: 'write',
      input: z.object({ id: id('quote'), type: z.enum(['percent', 'amount']), value: z.number().nonnegative().describe('percent (0-100) or amount; 0 removes the discount') }),
      output: quote,
      handler: ({ id: qid, type, value }, ctx) => {
        const q = draft(ctx, qid);
        if (type === 'percent' && value > 100) fail('VALIDATION', 'percent discount cannot exceed 100');
        if (type === 'amount' && value > q.subtotal) fail('VALIDATION', `discount ${value} exceeds the quote subtotal ${q.subtotal}`);
        Object.assign(q, value ? { discountType: type, discountValue: value } : { discountType: null, discountValue: null });
        return recalc(ctx, q);
      },
      example: (ctx) => ({ id: byNum(ctx, 'Q-1001').id, type: 'percent', value: 10 }),
    },
    {
      id: 'send_quote', name: 'Send quote for acceptance',
      description: 'Email a draft quote to the contact for acceptance (draft → sent). Requires line items and a contact email; sets a 30-day expiry if none.',
      keywords: ['email quote', 'share proposal', 'send estimate'],
      risk: 'external',
      input: z.object({ id: id('quote'), email: z.email().optional().describe('override recipient; defaults to contact email') }),
      output: quote,
      handler: ({ id: qid, email }, ctx) => {
        const q = draft(ctx, qid);
        if (!q.lineItems.length) fail('VALIDATION', `quote ${q.number} has no line items; add some with add_quote_line_item before sending`);
        const to = email ?? ctx.get('contacts', q.contactId, 'contact').email;
        if (!to) fail('VALIDATION', `contact ${q.contactId} has no email; pass email`);
        if (q.expiresAt) notPast(ctx, q.expiresAt);
        const expiresAt = q.expiresAt ?? dateOnly(addDays(ctx.now, 30));
        // The "send" is a recorded outbound email, like invoices.issue_invoice.
        const msg = ctx.insert('messages', {
          channel: 'email', direction: 'outbound', contactId: q.contactId, to, subject: `Quote ${q.number}: ${q.title}`,
          body: `Your quote ${q.number} for ${q.currency} ${q.total} is ready for review and valid until ${expiresAt}.`,
          status: 'sent', sentAt: ctx.now, relatedType: 'quotes', relatedId: q.id, purpose: 'quote',
        });
        return ctx.patch(q, { status: 'sent', sentAt: ctx.now, sentTo: to, expiresAt, messageId: msg.id });
      },
      example: (ctx) => ({ id: byNum(ctx, 'Q-1001').id }),
    },
    {
      id: 'record_quote_acceptance', name: 'Record quote acceptance',
      description: 'Record that the customer accepted a sent quote (sent → accepted). Fails if the quote has passed its expiry date.',
      keywords: ['quote approved', 'customer signed', 'accept proposal'],
      risk: 'write',
      input: z.object({ id: id('quote'), acceptedBy: z.string().optional().describe('name of the person who accepted') }),
      output: quote,
      handler: ({ id: qid, acceptedBy }, ctx) => {
        const q = ctx.get('quotes', qid, 'quote');
        if (q.status !== 'sent') fail('INVALID_STATE', `quote ${q.number} is '${q.status}'; only sent quotes can be accepted${q.status === 'draft' ? ' (send it first)' : ''}`);
        if (isExpired(ctx, q)) fail('INVALID_STATE', `quote ${q.number} expired on ${q.expiresAt}; extend it with set_quote_expiry first`);
        return ctx.patch(q, { status: 'accepted', acceptedAt: ctx.now, acceptedBy: acceptedBy ?? ctx.find('contacts', q.contactId)?.name ?? null });
      },
      example: (ctx) => ({ id: byNum(ctx, 'Q-1003').id }),
    },
    {
      id: 'convert_quote_to_invoice', name: 'Convert accepted quote to invoice',
      description: 'Create a draft invoice from an accepted quote (copies lines, discount and totals; next INV- number) and link it on the quote. Send it with the invoices module.',
      keywords: ['bill the quote', 'invoice from quote'],
      risk: 'write',
      input: z.object({ id: id('quote'), dueDate: isoDate('invoice due date; default 30 days from today').optional() }),
      output: z.looseObject({ quote, invoice: z.looseObject({ id: z.string(), number: z.string(), status: z.string(), total: z.number() }) }),
      handler: ({ id: qid, dueDate }, ctx) => {
        const q = ctx.get('quotes', qid, 'quote');
        if (q.status !== 'accepted') fail('INVALID_STATE', `quote ${q.number} is '${q.status}'; only accepted quotes can be converted`);
        if (q.invoiceId) fail('CONFLICT', `quote ${q.number} was already converted to invoice ${q.invoiceId}`, { invoiceId: q.invoiceId });
        const invoice = ctx.insert('invoices', {
          number: nextNum(ctx.all('invoices'), 'INV-', 1000), contactId: q.contactId, status: 'draft', issueDate: null, // set by issue_invoice, like other drafts
          dueDate: dueDate ? dateOnly(dueDate) : dateOnly(addDays(ctx.now, 30)), currency: q.currency,
          lineItems: q.lineItems.map((l) => ({ id: ctx.newId('li'), description: l.description, productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount })),
          subtotal: q.subtotal, discount: q.discount, tax: 0, total: q.total, amountPaid: 0, balance: q.total,
          remindersSent: [], lastReminderAt: null, quoteId: q.id,
        });
        ctx.patch(q, { invoiceId: invoice.id, convertedAt: ctx.now });
        return { quote: q, invoice };
      },
      example: (ctx) => ({ id: byNum(ctx, 'Q-1006').id }),
    },
  ],

  seed(ctx, h) {
    const P = (sku) => ctx.all('products').find((p) => p.sku === sku);
    if (!P('WEB-START')) return;
    const contacts = ctx.all('contacts');
    const con = (i) => contacts[i]?.id ?? `con_${String(i + 1).padStart(3, '0')}`;
    const L = (sku, quantity = 1, extra = {}) => ({ productId: P(sku).id, quantity, ...extra });
    const yearly = ctx.all('prices').find((x) => x.productId === P('SEO-RET').id && x.interval === 'year');
    // [contactIdx, status, title, lines, createdDaysAgo, expiresInDays, discount]
    const rows = [
      [1, 'draft', 'Website launch proposal', [L('WEB-START'), L('HOST-CARE', 12, { description: 'Hosting & Care (12 months prepaid)' })], 2, 28],
      [7, 'draft', 'Brand refresh (scoping)', [], 1, null],
      [2, 'sent', 'SEO growth plan', [L('SEO-RET', 6), L('CONSULT-60')], 5, 25],
      [12, 'sent', 'Social media starter', [L('SMM-STD', 3)], 40, -10],
      [17, 'expired', 'Print campaign refresh', [{ description: 'Custom print campaign design', unitPrice: 1200 }], 75, -45],
      [0, 'accepted', 'Annual SEO + consultation', [L('SEO-RET', 1, yearly ? { priceId: yearly.id } : {}), L('CONSULT-60', 2)], 9, 21, ['percent', 10]],
      [21, 'accepted', 'Merch order for staff', [L('MUG-11OZ', 20), { description: 'Custom engraving', unitPrice: 4, quantity: 20 }], 14, 16],
      [25, 'declined', 'Full-service marketing', [L('SMM-STD', 12), L('SEO-RET', 12)], 30, 0],
    ];
    for (const [ci, status, title, lines, ago, exp, disc] of rows) {
      const createdAt = h.daysAgo(ago);
      const q = ctx.insert('quotes', {
        number: nextNum(ctx.all('quotes'), 'Q-', 1000), contactId: con(ci), title, status, lineItems: lines.map((l) => buildLine(ctx, { quantity: 1, ...l }, 'USD')),
        discountType: disc?.[0] ?? null, discountValue: disc?.[1] ?? null, currency: 'USD',
        expiresAt: exp == null ? null : dateOnly(addDays(ctx.now, exp)), sentAt: status === 'draft' ? null : h.daysAgo(Math.max(ago - 1, 0)),
        acceptedAt: status === 'accepted' ? h.daysAgo(Math.max(ago - 3, 0)) : null, invoiceId: null, notes: '', createdAt,
      });
      recalc(ctx, q);
      q.updatedAt = createdAt;
    }
  },
});
