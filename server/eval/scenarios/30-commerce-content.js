// Commerce + content scenarios: products, prices, quotes, invoices, payments, subscriptions, coupons, orders, refunds, tax_rules, blogs, media, reports.
// Records are located by human keys (invoice/quote/order numbers, coupon codes, SKUs, names); expected values are derived from the seed.
import { reset, getDb } from '../../src/catalog/registry.js';
import { TOMORROW } from '../fixtures.js';

// Seed snapshot so assertions can compare final state against the starting values (scenarios run on a fresh reset of this same seed).
reset();
const SEED = structuredClone(getDb().tables);
const seedBy = (t, pred) => SEED[t].find(pred);

const byNum = (h, t, n) => h.find(t, (r) => r.number === n);
const byCode = (h, code) => h.find('coupons', (c) => c.code === code);
const bySku = (h, sku) => h.find('products', (p) => p.sku === sku);
const contact = (h, name) => h.find('contacts', (c) => c.name === name);
const round2 = (n) => Math.round(n * 100) / 100;
const OPEN = ['sent', 'partially_paid'];

/** Regex source matching an amount as 1,100 / 1100 / 1100.00 / $1,100. */
function money(n) {
  const [i, d] = n.toFixed(2).split('.');
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `(?<![\\d,.])\\$?(${grouped}|${i})${d === '00' ? '(\\.00)?' : `\\.${d}`}(?![\\d])`;
}
const allOf = (...srcs) => new RegExp(srcs.map((s) => `(?=[\\s\\S]*${s})`).join(''), 'i');
const CANT = /(can't|cannot|can not|couldn't|could not|unable|not able|isn't (yet )?(valid|active|available)|not (yet )?(valid|active|available)|failed|won't|doesn't|does not|only)/i;

// ---- values derived from the seed ----
const openBalanceByContact = SEED.invoices
  .filter((i) => OPEN.includes(i.status) && i.balance > 0)
  .reduce((m, i) => m.set(i.contactId, round2((m.get(i.contactId) || 0) + i.balance)), new Map());
const topDebtor = SEED.contacts.find((c) => c.id === [...openBalanceByContact].sort((a, b) => b[1] - a[1])[0][0]);

const collected = (month) => round2(SEED.payments.filter((p) => p.status === 'succeeded' && (p.paidAt || '').startsWith(month)).reduce((s, p) => s + p.amount, 0));
const OCT_REVENUE = collected('2026-10');
const SEP_REVENUE = collected('2026-09');

const jackInvoice = seedBy('invoices', (i) => i.number === 'INV-1005');
const jackRefund = seedBy('refunds', (r) => r.invoiceId === jackInvoice.id && r.status === 'requested');
const JACK_BALANCE_AFTER = round2(jackInvoice.balance + jackRefund.amount);

const ninaCheck = seedBy('payments', (p) => p.method === 'check' && p.contactId === seedBy('contacts', (c) => c.name === 'Nina Chen').id);
const NINA_REFUNDABLE = round2(
  ninaCheck.amount - ninaCheck.refundedAmount - SEED.refunds.filter((r) => r.paymentId === ninaCheck.id && r.status === 'approved').reduce((s, r) => s + r.amount, 0),
);

const seoMonthly = seedBy('prices', (p) => p.productId === seedBy('products', (x) => x.sku === 'SEO-RET').id && p.interval === 'month' && p.currency === 'USD' && p.status === 'active');
const seo15 = seedBy('coupons', (c) => c.code === 'SEO15');
const SEO15_RENEWAL = round2(seoMonthly.amount * (1 - seo15.discountValue / 100));

/** Quotes that lapsed before the customer answered (still sent/expired, expiry date before today). */
const lapsedQuotes = (rows) => rows.filter((q) => ['sent', 'expired'].includes(q.status) && q.expiresAt && q.expiresAt < '2026-11-04');
const IN_TWO_WEEKS = '2026-11-18';

const teeVariant = (h, name) => bySku(h, 'TEE-LOGO').variants.find((v) => v.name === name);
const seedTeeQty = (name) => seedBy('products', (p) => p.sku === 'TEE-LOGO').variants.find((v) => v.name === name).inventory.quantity;

export default [
  // ───────────────────────────── direct ─────────────────────────────
  {
    id: 'com-direct-create-holiday-coupon',
    category: 'direct',
    modules: ['coupons'],
    turns: [{ user: 'Set up a coupon code HOLIDAY15 — 15% off, valid from Nov 20 through Dec 31, capped at 100 uses.' }],
    expect: {
      actions: ['coupons.create_coupon'],
      params: { 'coupons.create_coupon': { code: 'HOLIDAY15', discountType: 'percent', discountValue: 15, validFrom: '2026-11-20', validUntil: '2026-12-31', maxRedemptions: 100 } },
      state: (h) => {
        const c = h.created('coupons').filter((x) => x.code.toUpperCase() === 'HOLIDAY15');
        if (c.length !== 1) return `expected exactly one HOLIDAY15 coupon, found ${c.length}`;
        const [x] = c;
        return (x.discountType === 'percent' && x.discountValue === 15 && x.validFrom?.startsWith('2026-11-20') && x.validUntil?.startsWith('2026-12-31') && x.maxRedemptions === 100 && x.status === 'active') || `wrong coupon settings: ${JSON.stringify(x)}`;
      },
    },
    oracle: (call) => call('coupons.create_coupon', { code: 'HOLIDAY15', discountType: 'percent', discountValue: 15, validFrom: '2026-11-20', validUntil: '2026-12-31', maxRedemptions: 100 }),
  },
  {
    id: 'com-direct-premium-hosting-price',
    category: 'direct',
    modules: ['prices', 'products'],
    turns: [{ user: "Add a premium tier to the Website Hosting & Care Plan: $79 a month with a 14-day free trial. Label it 'Hosting & Care — Premium Monthly'." }],
    expect: {
      actions: ['prices.create_price'],
      allow: ['prices.set_trial_period', 'prices.update_price_label'],
      params: { 'prices.create_price': { amount: 79, interval: 'month' } },
      state: (h) => {
        const prd = bySku(h, 'HOST-CARE');
        const p = h.created('prices').filter((x) => x.productId === prd.id && x.amount === 79);
        if (p.length !== 1) return `expected one new $79 price on ${prd.name}, found ${p.length}`;
        const [x] = p;
        if (x.interval !== 'month' || x.trialDays !== 14 || (x.currency || 'USD') !== 'USD') return `price has interval ${x.interval}, trial ${x.trialDays}, currency ${x.currency}`;
        return /premium/i.test(x.label || '') || `label is '${x.label}'`;
      },
    },
    oracle: (call, h) => call('prices.create_price', { productId: bySku(h, 'HOST-CARE').id, amount: 79, interval: 'month', trialDays: 14, label: 'Hosting & Care — Premium Monthly' }),
  },
  {
    id: 'com-direct-quote-discount',
    category: 'direct',
    modules: ['quotes'],
    turns: [{ user: "Knock 10% off Sarah Chen's website launch proposal." }],
    expect: {
      actions: ['quotes.apply_quote_discount'],
      params: { 'quotes.apply_quote_discount': { type: 'percent', value: 10 } },
      state: (h) => {
        const q = h.find('quotes', (x) => x.contactId === contact(h, 'Sarah Chen').id && /website launch/i.test(x.title));
        const want = round2(q.subtotal * 0.1);
        return (q.discount === want && q.total === round2(q.subtotal - want)) || `${q.number} discount ${q.discount}, total ${q.total}; expected discount ${want}`;
      },
    },
    oracle: (call, h) => call('quotes.apply_quote_discount', { id: byNum(h, 'quotes', 'Q-1001').id, type: 'percent', value: 10 }),
  },
  {
    id: 'com-direct-washington-tax',
    category: 'direct',
    modules: ['tax_rules'],
    turns: [{ user: "We've started shipping to Washington state. Add a 6.5% sales tax for WA." }],
    expect: {
      actions: ['tax_rules.create_tax_rule'],
      params: { 'tax_rules.create_tax_rule': { country: 'US', state: 'WA', rate: 6.5 } },
      state: (h) => {
        const r = h.all('tax_rules').filter((x) => x.status === 'active' && x.country === 'US' && x.state === 'WA');
        return (r.length === 1 && r[0].rate === 6.5 && !r[0].taxCategory && !r[0].inclusive) || `active WA rules: ${JSON.stringify(r)}`;
      },
    },
    oracle: (call) => call('tax_rules.create_tax_rule', { name: 'Washington sales tax', country: 'US', state: 'WA', rate: 6.5 }),
  },
  {
    id: 'com-direct-draft-blog-post',
    category: 'direct',
    modules: ['blogs'],
    turns: [{ user: "Draft a blog post for the dental site called '3 Ways to Prevent Gum Disease' — a short piece on brushing, flossing and regular cleanings. Put it under Oral Health. Don't publish it yet." }],
    expect: {
      actions: ['blogs.create_blog_post'],
      forbid: ['blogs.publish_post', 'blogs.schedule_post'],
      allow: ['blogs.set_post_categories', 'blogs.assign_post_author', 'blogs.set_post_seo', 'blogs.update_blog_post'],
      params: { 'blogs.create_blog_post': { title: /3 Ways to Prevent Gum Disease/i } },
      state: (h) => {
        const p = h.created('blog_posts').filter((x) => /prevent gum disease/i.test(x.title));
        if (p.length !== 1) return `expected one gum-disease post, found ${p.length}`;
        const [x] = p;
        if (x.status !== 'draft') return `post is ${x.status}, expected draft`;
        if (!/floss/i.test(x.body || '')) return 'body does not cover flossing';
        return x.categories.some((c) => /oral health/i.test(c)) || `categories: ${x.categories.join(', ')}`;
      },
    },
    oracle: (call) =>
      call('blogs.create_blog_post', {
        title: '3 Ways to Prevent Gum Disease', websiteId: 'web_001', categories: ['Oral Health'],
        body: 'Healthy gums start at home. 1) Brush twice a day for two minutes. 2) Floss daily to clear plaque between teeth. 3) Book regular professional cleanings.',
      }),
  },
  {
    id: 'com-direct-team-photo-alt-text',
    category: 'direct',
    modules: ['media'],
    turns: [{ user: "The team photo on the dental website has no alt text. Set it to 'The Bright Smile Dental team outside the clinic'." }],
    expect: {
      actions: ['media.set_media_alt_text'],
      params: { 'media.set_media_alt_text': { altText: /Bright Smile Dental team outside the clinic/i } },
      state: (h) => {
        const m = h.find('media', (x) => x.name === 'team-photo-2026.jpg');
        return /Bright Smile Dental team outside the clinic/i.test(m.altText || '') || `team photo alt text is '${m.altText}'`;
      },
    },
    oracle: (call, h) => call('media.set_media_alt_text', { id: h.find('media', (x) => x.name === 'team-photo-2026.jpg').id, altText: 'The Bright Smile Dental team outside the clinic' }),
  },
  {
    id: 'com-direct-revenue-vs-september',
    category: 'direct',
    modules: ['reports', 'payments'],
    turns: [{ user: 'How much money did we actually collect last month, and how does that stack up against September?' }],
    oracleReply: `We collected $${OCT_REVENUE.toLocaleString('en-US')} in October versus $${SEP_REVENUE.toLocaleString('en-US')} in September.`,
    expect: {
      actions: [['reports.compare_report_periods', 'reports.run_report', 'payments.search_payments']],
      noWrites: true,
      reply: allOf(money(OCT_REVENUE), money(SEP_REVENUE)),
    },
    oracle: (call) => call('reports.compare_report_periods', { metric: 'revenue_collected', dateRange: { preset: 'last_month' } }),
  },
  {
    id: 'com-direct-pause-hosting-sub',
    category: 'direct',
    modules: ['subscriptions'],
    turns: [{ user: "Pause Michael Müller's hosting plan until January 1st — his office is closed over the holidays." }],
    expect: {
      actions: ['subscriptions.pause_subscription'],
      params: { 'subscriptions.pause_subscription': { resumeAt: '2027-01-01' } },
      state: (h) => {
        const s = h.find('subscriptions', (x) => x.contactId === contact(h, 'Michael Müller').id && x.productId === bySku(h, 'HOST-CARE').id);
        return (s.status === 'paused' && (s.resumeAt || '').startsWith('2027-01-01')) || `subscription ${s.id} is ${s.status}, resumeAt ${s.resumeAt}`;
      },
    },
    oracle: (call, h) => call('subscriptions.pause_subscription', { id: h.find('subscriptions', (x) => x.contactId === contact(h, 'Michael Müller').id).id, resumeAt: '2027-01-01' }),
  },
  {
    id: 'com-direct-send-approved-refund',
    category: 'direct',
    modules: ['refunds', 'payments'],
    turns: [{ user: "Nina Chen's $50 refund was already approved — go ahead and send it to her." }],
    expect: {
      actions: ['refunds.execute_refund'],
      state: (h) => {
        const r = h.find('refunds', (x) => x.paymentId === ninaCheck.id && x.amount === 50);
        if (r.status !== 'executed') return `refund ${r.id} is ${r.status}`;
        const p = h.get('payments', ninaCheck.id);
        return p.refundedAmount === round2(ninaCheck.refundedAmount + 50) || `payment refundedAmount ${p.refundedAmount}`;
      },
    },
    oracle: (call) => call('refunds.execute_refund', { id: SEED.refunds.find((r) => r.paymentId === ninaCheck.id && r.status === 'approved').id }),
  },
  {
    id: 'com-direct-cancel-sub-declined',
    category: 'direct',
    modules: ['subscriptions'],
    // The user declines the confirmation prompt: nothing may change.
    turns: [{ user: "Cancel Aisha Kim's yearly SEO subscription, effective immediately — she's moved to another agency.", confirm: false }],
    invariant: true,
    expect: {
      confirmRequested: true,
      noWrites: true,
      state: (h) => {
        const s = h.find('subscriptions', (x) => x.contactId === contact(h, 'Aisha Kim').id);
        return (s.status === 'active' && !s.cancelledAt && !s.cancelAtPeriodEnd) || `subscription ${s.id} changed: ${s.status}`;
      },
    },
  },

  // ───────────────────────────── indirect ─────────────────────────────
  {
    id: 'com-indirect-who-owes-most',
    category: 'indirect',
    modules: ['invoices', 'contacts'],
    turns: [{ user: 'Who owes us the most money right now?' }],
    oracleReply: `${topDebtor.name} owes the most: $${openBalanceByContact.get(topDebtor.id)} across open invoices.`,
    expect: {
      actions: [['invoices.search_invoices', 'invoices.list_overdue_invoices']],
      noWrites: true,
      reply: new RegExp(topDebtor.name, 'i'),
    },
    oracle: (call) => {
      call('invoices.search_invoices', { status: 'sent', limit: 50 });
      call('invoices.search_invoices', { status: 'partially_paid', limit: 50 });
    },
  },
  {
    id: 'com-indirect-tees-selling-out',
    category: 'indirect',
    modules: ['products'],
    turns: [{ user: 'Our logo tees keep selling out and people are complaining. A box just landed with 15 Larges and 10 Mediums.' }],
    expect: {
      actions: ['products.set_inventory_quantity'],
      params: { 'products.set_inventory_quantity': [{ quantity: seedTeeQty('L') + 15 }, { quantity: seedTeeQty('M') + 10 }] },
      state: (h) => {
        const L = teeVariant(h, 'L').inventory.quantity, M = teeVariant(h, 'M').inventory.quantity;
        return (L === seedTeeQty('L') + 15 && M === seedTeeQty('M') + 10) || `L=${L} M=${M}; expected ${seedTeeQty('L') + 15}/${seedTeeQty('M') + 10}`;
      },
    },
    oracle: (call, h) => {
      const p = bySku(h, 'TEE-LOGO');
      call('products.set_inventory_quantity', { id: p.id, variantId: teeVariant(h, 'L').id, quantity: seedTeeQty('L') + 15 });
      call('products.set_inventory_quantity', { id: p.id, variantId: teeVariant(h, 'M').id, quantity: seedTeeQty('M') + 10 });
    },
  },
  {
    id: 'com-indirect-check-for-overdue-invoice',
    category: 'indirect',
    modules: ['payments', 'invoices'],
    turns: [{ user: 'Sarah Johnson just dropped off a check for her overdue invoice, check #2231.' }],
    expect: {
      actions: ['payments.record_payment'],
      allow: ['payments.generate_payment_receipt'],
      params: { 'payments.record_payment': { method: 'check', reference: /2231/ } },
      state: (h) => {
        const inv = byNum(h, 'invoices', 'INV-1030'); // Sarah Johnson's only invoice, overdue since Nov 2
        if (inv.status !== 'paid') return `${inv.number} is ${inv.status} with balance ${inv.balance}`;
        const p = h.created('payments').filter((x) => x.contactId === inv.contactId);
        return (p.length === 1 && p[0].method === 'check' && p[0].status === 'succeeded') || `payments recorded: ${JSON.stringify(p.map((x) => [x.method, x.amount, x.status]))}`;
      },
    },
    oracle: (call, h) => call('payments.record_payment', { invoiceId: byNum(h, 'invoices', 'INV-1030').id, method: 'check', reference: 'Check #2231' }),
  },

  // ───────────────────────────── multi_step ─────────────────────────────
  {
    id: 'com-multi-quote-accept-invoice-paylink',
    category: 'multi_step',
    modules: ['quotes', 'invoices', 'payments'],
    turns: [{ user: 'Michael Smith said yes to the SEO growth plan quote. Mark it accepted, bill him for it with the invoice due Dec 4, send the invoice, and email him a pay link.' }],
    expect: {
      actions: ['quotes.record_quote_acceptance', 'quotes.convert_quote_to_invoice', 'invoices.issue_invoice', 'payments.create_payment_request'],
      allow: ['invoices.set_invoice_due_date'],
      state: (h) => {
        const q = h.find('quotes', (x) => x.contactId === contact(h, 'Michael Smith').id && /SEO growth/i.test(x.title));
        if (q.status !== 'accepted' || !q.invoiceId) return `${q.number} is ${q.status}, invoice ${q.invoiceId}`;
        const inv = h.get('invoices', q.invoiceId);
        if (inv.status !== 'sent' || inv.dueDate !== '2026-12-04' || inv.total !== q.total) return `invoice ${inv.number}: ${inv.status}, due ${inv.dueDate}, total ${inv.total}`;
        return h.created('payment_requests').some((r) => r.invoiceId === inv.id && r.status === 'open' && r.channel === 'email') || `no open emailed payment request for ${inv.number}`;
      },
    },
    oracle: (call, h) => {
      const q = byNum(h, 'quotes', 'Q-1003');
      call('quotes.record_quote_acceptance', { id: q.id });
      const { invoice } = call('quotes.convert_quote_to_invoice', { id: q.id, dueDate: '2026-12-04' });
      call('invoices.issue_invoice', { id: invoice.id });
      call('payments.create_payment_request', { invoiceId: invoice.id, channel: 'email' });
    },
  },
  {
    id: 'com-multi-merch-order-coupon',
    category: 'multi_step',
    modules: ['orders', 'products', 'coupons'],
    turns: [{ user: 'Priya Okafor wants two black hoodies and three coffee mugs shipped to 286 Main St, Brooklyn NY 11201. Use the MERCH5 code and submit the order.' }],
    expect: {
      actions: ['orders.create_order', 'orders.add_order_line_item', 'orders.apply_coupon_to_order', 'orders.submit_order'],
      allow: ['orders.set_order_shipping_address', 'orders.update_order_quantity'],
      params: { 'orders.apply_coupon_to_order': { code: 'MERCH5' } },
      state: (h) => {
        const o = h.created('orders').filter((x) => x.contactId === contact(h, 'Priya Okafor').id);
        if (o.length !== 1) return `expected one new order for Priya Okafor, found ${o.length}`;
        const [x] = o;
        if (x.status !== 'submitted') return `order is ${x.status}`;
        if ((x.couponCode || '').toUpperCase() !== 'MERCH5') return `coupon is ${x.couponCode}`;
        const black = bySku(h, 'HOOD-LOGO').variants.find((v) => v.name === 'Black');
        const mug = bySku(h, 'MUG-11OZ');
        const qty = (f) => x.lineItems.filter(f).reduce((s, l) => s + l.quantity, 0);
        if (qty((l) => l.variantId === black.id) !== 2 || qty((l) => l.productId === mug.id) !== 3 || x.lineItems.length !== 2) return `lines: ${x.lineItems.map((l) => `${l.name}x${l.quantity}`).join(', ')}`;
        return /11201/.test(x.shippingAddress?.postalCode || '') || `shipping address ${JSON.stringify(x.shippingAddress)}`;
      },
    },
    oracle: (call, h) => {
      const hood = bySku(h, 'HOOD-LOGO');
      const o = call('orders.create_order', { contactId: contact(h, 'Priya Okafor').id, shippingAddress: { name: 'Priya Okafor', line1: '286 Main St', city: 'Brooklyn', state: 'NY', postalCode: '11201', country: 'US' } });
      call('orders.add_order_line_item', { id: o.id, productId: hood.id, variantId: hood.variants.find((v) => v.name === 'Black').id, quantity: 2 });
      call('orders.add_order_line_item', { id: o.id, productId: bySku(h, 'MUG-11OZ').id, quantity: 3 });
      call('orders.apply_coupon_to_order', { id: o.id, code: 'MERCH5' });
      call('orders.submit_order', { id: o.id });
    },
  },
  {
    id: 'com-multi-approve-execute-refund',
    category: 'multi_step',
    modules: ['refunds', 'payments', 'invoices'],
    turns: [{ user: "Jack Rossi's $75 refund for the missed sessions — approve it and send the money back, then tell me what he still owes on INV-1005." }],
    oracleReply: `Refund sent. INV-1005 now has a balance of $${JACK_BALANCE_AFTER.toLocaleString('en-US')}.`,
    expect: {
      actions: ['refunds.approve_refund_request', 'refunds.execute_refund'],
      reply: new RegExp(money(JACK_BALANCE_AFTER)),
      state: (h) => {
        const r = h.get('refunds', jackRefund.id);
        if (r.status !== 'executed') return `refund ${r.id} is ${r.status}`;
        const inv = byNum(h, 'invoices', 'INV-1005');
        return inv.balance === JACK_BALANCE_AFTER || `INV-1005 balance ${inv.balance}, expected ${JACK_BALANCE_AFTER}`;
      },
    },
    oracle: (call) => {
      call('refunds.approve_refund_request', { id: jackRefund.id });
      call('refunds.execute_refund', { id: jackRefund.id });
      call('invoices.get_invoice', { id: jackInvoice.id });
    },
  },
  {
    id: 'com-multi-subscription-with-coupon',
    category: 'multi_step',
    modules: ['subscriptions', 'prices', 'coupons'],
    turns: [{ user: 'Start Ethan Garcia on the monthly SEO retainer using code SEO15, and tell me what his next renewal invoice will come to.' }],
    oracleReply: `Done — his next invoice will be $${SEO15_RENEWAL} after the SEO15 discount.`,
    expect: {
      actions: ['subscriptions.create_subscription', 'subscriptions.preview_next_invoice'],
      params: { 'subscriptions.create_subscription': { priceId: seoMonthly.id, couponCode: 'SEO15' } },
      reply: new RegExp(money(SEO15_RENEWAL)),
      state: (h) => {
        const s = h.created('subscriptions').filter((x) => x.contactId === contact(h, 'Ethan Garcia').id);
        return (s.length === 1 && s[0].priceId === seoMonthly.id && (s[0].couponCode || '').toUpperCase() === 'SEO15') || `new subscriptions: ${JSON.stringify(s.map((x) => [x.priceId, x.couponCode]))}`;
      },
    },
    oracle: (call, h) => {
      const s = call('subscriptions.create_subscription', { contactId: contact(h, 'Ethan Garcia').id, priceId: seoMonthly.id, couponCode: 'SEO15' });
      call('subscriptions.preview_next_invoice', { id: s.id });
    },
  },
  {
    id: 'com-multi-blog-hero-publish',
    category: 'multi_step',
    modules: ['media', 'blogs'],
    turns: [{ user: "Upload whitening-hero.jpg (JPEG, about 850 KB) to the /blog folder with alt text 'Smiling patient after professional whitening', make it the featured image on the Teeth Whitening Myths post, and then publish that post." }],
    expect: {
      actions: ['media.upload_media', 'blogs.update_blog_post', 'blogs.publish_post'],
      allow: ['media.set_media_alt_text'],
      params: { 'media.upload_media': { name: 'whitening-hero.jpg', mimeType: 'image/jpeg', folder: '/blog' } },
      state: (h) => {
        const m = h.created('media').filter((x) => x.name === 'whitening-hero.jpg');
        if (m.length !== 1) return `expected one uploaded whitening-hero.jpg, found ${m.length}`;
        if (!/smiling patient/i.test(m[0].altText || '')) return `alt text '${m[0].altText}'`;
        const p = h.find('blog_posts', (x) => /whitening myths/i.test(x.title));
        if (![m[0].id, m[0].url].includes(p.featuredImage)) return `featured image is ${p.featuredImage}`;
        return p.status === 'published' || `post is ${p.status}`;
      },
    },
    oracle: (call, h) => {
      const m = call('media.upload_media', { name: 'whitening-hero.jpg', mimeType: 'image/jpeg', sizeBytes: 850000, folder: '/blog', altText: 'Smiling patient after professional whitening' });
      const p = h.find('blog_posts', (x) => /whitening myths/i.test(x.title));
      call('blogs.update_blog_post', { id: p.id, featuredImage: m.id });
      call('blogs.publish_post', { id: p.id });
    },
  },

  // ───────────────────────────── conditional ─────────────────────────────
  {
    id: 'com-cond-texas-tax',
    category: 'conditional',
    modules: ['tax_rules'],
    turns: [{ user: "If we've got an active Texas sales tax rule, make sure it's at 6.25%. If we don't, set one up at 6.25%." }],
    expect: {
      actions: ['tax_rules.list_tax_rules', 'tax_rules.create_tax_rule'],
      params: { 'tax_rules.create_tax_rule': { country: 'US', state: 'TX', rate: 6.25 } },
      state: (h) => {
        const r = h.all('tax_rules').filter((x) => x.status === 'active' && x.country === 'US' && x.state === 'TX' && !x.taxCategory);
        return (r.length === 1 && r[0].rate === 6.25) || `active TX rules: ${JSON.stringify(r.map((x) => [x.id, x.rate]))}`;
      },
    },
    oracle: (call) => {
      call('tax_rules.list_tax_rules', { country: 'US', state: 'TX' });
      call('tax_rules.create_tax_rule', { name: 'Texas sales tax', country: 'US', state: 'TX', rate: 6.25 });
    },
  },
  {
    id: 'com-cond-extend-lapsed-quotes',
    category: 'conditional',
    modules: ['quotes'],
    turns: [{ user: 'Any quotes that ran out before the customer got back to us — give them two more weeks from today. Leave everything else alone.' }],
    expect: {
      actions: ['quotes.search_quotes', 'quotes.set_quote_expiry'],
      params: { 'quotes.set_quote_expiry': { expiresAt: IN_TWO_WEEKS } },
      state: (h) => {
        const want = new Set(lapsedQuotes(SEED.quotes).map((q) => q.id));
        if (!want.size) return 'fixture has no lapsed quotes';
        for (const s of SEED.quotes) {
          const q = h.get('quotes', s.id);
          if (want.has(s.id) && q.expiresAt !== IN_TWO_WEEKS) return `${q.number} expiry ${q.expiresAt}, expected ${IN_TWO_WEEKS}`;
          if (!want.has(s.id) && (q.expiresAt !== s.expiresAt || q.status !== s.status)) return `${q.number} should not have changed`;
        }
        return true;
      },
    },
    oracle: (call) => {
      call('quotes.search_quotes', { expiresAtBefore: '2026-11-03' });
      for (const q of lapsedQuotes(SEED.quotes)) call('quotes.set_quote_expiry', { id: q.id, expiresAt: IN_TWO_WEEKS });
    },
  },

  // ───────────────────────────── follow_up ─────────────────────────────
  {
    id: 'com-followup-water-bottle-merch-coupon',
    category: 'follow_up',
    modules: ['products', 'prices', 'coupons'],
    turns: [
      { user: "New product: Insulated Water Bottle, SKU BTL-750. It's a physical item, we have 50 in stock, and it sells for $22." },
      { user: 'Oh, and make sure the MERCH5 code works on it too.' },
    ],
    expect: {
      actions: ['products.create_product', 'prices.create_price', 'coupons.restrict_coupon_to_products'],
      allow: ['products.set_inventory_quantity', 'products.set_product_sku', 'prices.set_default_price'],
      params: { 'products.create_product': { sku: 'BTL-750' }, 'prices.create_price': { amount: 22 } },
      state: (h) => {
        const p = h.created('products').filter((x) => x.sku === 'BTL-750');
        if (p.length !== 1) return `expected one BTL-750 product, found ${p.length}`;
        const [b] = p;
        if (b.type !== 'physical' || b.inventory.quantity !== 50 || !b.inventory.tracked) return `bottle type ${b.type}, inventory ${JSON.stringify(b.inventory)}`;
        if (!h.all('prices').some((x) => x.productId === b.id && x.amount === 22 && x.interval === 'one_time' && x.status === 'active')) return 'no active $22 one-time price on the bottle';
        const c = byCode(h, 'MERCH5');
        const before = seedBy('coupons', (x) => x.code === 'MERCH5').productIds;
        const missing = [b.id, ...before].filter((id) => !c.productIds.includes(id));
        return !missing.length || `MERCH5 does not cover ${missing.join(', ')}`;
      },
    },
    oracle: (call, h) => {
      const b = call('products.create_product', { name: 'Insulated Water Bottle', sku: 'BTL-750', type: 'physical', trackInventory: true, quantity: 50, taxCategory: 'general' });
      call('prices.create_price', { productId: b.id, amount: 22, interval: 'one_time', label: 'Water Bottle' });
      const c = byCode(h, 'MERCH5');
      call('coupons.restrict_coupon_to_products', { id: c.id, productIds: [...c.productIds, b.id] });
    },
  },
  {
    id: 'com-followup-invoice-add-mugs-send',
    category: 'follow_up',
    modules: ['invoices', 'products'],
    turns: [
      { user: "Make an invoice for Ethan Garcia: one 60-minute strategy consultation at $150, due November 30. Don't send it yet." },
      { user: 'Actually add two coffee mugs at $15 each as well, then send it to him.' },
    ],
    expect: {
      actions: ['invoices.create_invoice', 'invoices.add_invoice_line_item', 'invoices.issue_invoice'],
      allow: ['invoices.set_invoice_due_date', 'invoices.update_draft_invoice'],
      state: (h) => {
        const inv = h.created('invoices').filter((i) => i.contactId === contact(h, 'Ethan Garcia').id);
        if (inv.length !== 1) return `expected one new invoice for Ethan Garcia, found ${inv.length}`;
        const [i] = inv;
        if (i.status !== 'sent') return `invoice ${i.number} is ${i.status}`;
        if (i.dueDate !== '2026-11-30') return `due date ${i.dueDate}`;
        if (!i.lineItems.some((l) => l.quantity === 2 && l.unitPrice === 15)) return `no 2 x $15 mug line: ${JSON.stringify(i.lineItems.map((l) => [l.description, l.quantity, l.unitPrice]))}`;
        return i.total === 180 || `total ${i.total}, expected 180`;
      },
    },
    oracle: (call, h) => {
      const inv = call('invoices.create_invoice', { contactId: contact(h, 'Ethan Garcia').id, dueDate: '2026-11-30', lineItems: [{ description: 'Strategy Consultation (60 min)', quantity: 1, unitPrice: 150, productId: bySku(h, 'CONSULT-60').id }] });
      call('invoices.add_invoice_line_item', { id: inv.id, description: 'Ceramic Coffee Mug', quantity: 2, unitPrice: 15, productId: bySku(h, 'MUG-11OZ').id });
      call('invoices.issue_invoice', { id: inv.id });
    },
  },
  {
    id: 'com-followup-overdue-report-schedule',
    category: 'follow_up',
    modules: ['reports'],
    turns: [
      { user: 'Can you set up a saved report of overdue invoices, broken down by status?' },
      { user: 'Perfect. Have it emailed to jamie.fox@acme.test every Monday.' },
    ],
    expect: {
      // A new report, or regrouping the existing "Overdue Invoices" report, both satisfy the request.
      actions: [['reports.create_report', 'reports.set_report_grouping'], 'reports.schedule_report'],
      params: { 'reports.schedule_report': { frequency: 'weekly', dayOfWeek: 'mon', recipients: ['jamie.fox@acme.test'] } },
      state: (h) => {
        const ok = h.all('reports').some(
          (r) => r.metric === 'invoices_overdue' && r.groupBy === 'status' && r.schedule?.frequency === 'weekly' && r.schedule?.dayOfWeek === 'mon' && r.schedule.recipients.map((x) => x.toLowerCase()).includes('jamie.fox@acme.test'),
        );
        return ok || 'no overdue-invoices report grouped by status and scheduled weekly on Monday to jamie.fox@acme.test';
      },
    },
    oracle: (call) => {
      const r = call('reports.create_report', { name: 'Overdue Invoices by Status', metric: 'invoices_overdue', groupBy: 'status' });
      call('reports.schedule_report', { id: r.id, frequency: 'weekly', dayOfWeek: 'mon', recipients: ['jamie.fox@acme.test'] });
    },
  },

  // ───────────────────────────── ambiguous ─────────────────────────────
  {
    id: 'com-ambiguous-sarah-order-discount',
    category: 'ambiguous',
    modules: ['orders', 'coupons'],
    // Sarah Chen and Sarah Johnson both have draft orders, and no discount code is named.
    turns: [{ user: "Put the discount on Sarah's order." }],
    expect: { clarify: true, noWrites: true },
  },
  {
    id: 'com-ambiguous-noah-invoice',
    category: 'ambiguous',
    modules: ['invoices', 'contacts'],
    // Several Noahs; Noah Singh alone has an overdue sent invoice, a paid one and an unsent draft.
    turns: [{ user: 'Send Noah his invoice.' }],
    expect: { clarify: true, noWrites: true },
  },

  // ───────────────────────────── unsupported ─────────────────────────────
  {
    id: 'com-unsupported-shipping-labels',
    category: 'unsupported',
    modules: ['orders'],
    turns: [{ user: `Buy UPS shipping labels for ORD-1003 and book a courier pickup for tomorrow (${TOMORROW}) morning.` }],
    oracleReply: "I can't buy shipping labels or book carrier pickups — there's no shipping integration. I can mark the order fulfilled once it ships.",
    expect: { noWrites: true, reply: /(can't|cannot|can not|unable|not able|don't have|do not have|not support|isn't supported|no (action|capability|way|integration))/i },
  },

  // ───────────────────────────── failure ─────────────────────────────
  {
    id: 'com-failure-blackfriday-too-early',
    category: 'failure',
    modules: ['coupons', 'orders'],
    turns: [{ user: "Apply BLACKFRIDAY25 to Sarah Chen's order so she gets the sale price now." }],
    invariant: true, // guard: the order must stay coupon-free and the coupon window must not be bent to force it through
    oracleReply: "I couldn't apply BLACKFRIDAY25 — it isn't valid until Nov 27.",
    expect: {
      reply: /(27|not (yet )?(valid|active|started|live)|isn't (yet )?(valid|active|live)|until|can't|cannot|couldn't|could not|unable)/i,
      forbid: ['coupons.set_coupon_validity_window'],
      state: (h) => {
        const o = h.find('orders', (x) => x.contactId === contact(h, 'Sarah Chen').id && x.status === 'draft');
        if (o.couponCode) return `coupon ${o.couponCode} was applied to ${o.number}`;
        const c = byCode(h, 'BLACKFRIDAY25');
        return c.validFrom === seedBy('coupons', (x) => x.code === 'BLACKFRIDAY25').validFrom || `BLACKFRIDAY25 window changed to ${c.validFrom}`;
      },
    },
    oracleAllowsFailure: true, // the reference attempt must be rejected by the coupon window rule
    oracle: (call, h) => call('orders.apply_coupon_to_order', { id: byNum(h, 'orders', 'ORD-1006').id, code: 'BLACKFRIDAY25' }),
  },
  {
    id: 'com-failure-refund-over-balance',
    category: 'failure',
    modules: ['refunds', 'payments'],
    turns: [{ user: "Refund the rest of Nina Chen's $250 check — she should get $210 back." }],
    invariant: true, // guard: no refund for a different amount, and the already-approved refund is not rejected to make room
    oracleReply: `I can't refund $210: $40 was already refunded and $50 is approved but not yet sent, so only $${NINA_REFUNDABLE} is refundable.`,
    expect: {
      reply: new RegExp(money(NINA_REFUNDABLE)),
      state: (h) => {
        const made = h.created('refunds').filter((r) => r.paymentId === ninaCheck.id);
        if (made.length) return `refund request(s) created: ${made.map((r) => r.amount).join(', ')}`;
        const changed = SEED.refunds.filter((r) => r.paymentId === ninaCheck.id && h.get('refunds', r.id).status !== r.status);
        return !changed.length || `existing refunds changed: ${changed.map((r) => r.id).join(', ')}`;
      },
    },
    oracleAllowsFailure: true, // the reference attempt must be rejected with INSUFFICIENT_BALANCE
    oracle: (call) => {
      call('refunds.check_refundable_balance', { paymentId: ninaCheck.id });
      call('refunds.create_refund_request', { paymentId: ninaCheck.id, amount: 210 });
    },
  },
];
