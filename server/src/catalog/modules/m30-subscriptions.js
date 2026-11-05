import { defineModule, ops, z, id, entity, isoDate, fail, addDays, toTime, round2 } from '../kit.js';
import { evaluateCoupon, findCoupon } from './m31-coupons.js';

const STATUSES = ['trialing', 'active', 'past_due', 'paused', 'cancelled'];
const LIVE = ['trialing', 'active', 'past_due'];
const sub = entity({
  contactId: z.string(), priceId: z.string(), productId: z.string(), quantity: z.number(), status: z.enum(STATUSES),
  trialEnd: z.string().nullable().optional(), currentPeriodStart: z.string(), currentPeriodEnd: z.string(), cancelAtPeriodEnd: z.boolean(),
  cancelledAt: z.string().nullable().optional(), pausedAt: z.string().nullable().optional(), couponCode: z.string().nullable().optional(),
});
const addInterval = (iso, interval) => {
  const d = new Date(iso);
  if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
};

function recurringPrice(ctx, priceId) {
  const pr = ctx.get('prices', priceId, 'price');
  if (pr.status !== 'active') fail('INVALID_STATE', `price ${pr.id} is archived; pick an active recurring price with prices.list_product_prices`);
  if (pr.interval === 'one_time') fail('VALIDATION', `price ${pr.id} is one-time; subscriptions need a recurring (month/year) price — sell one-time items with orders`);
  const p = ctx.get('products', pr.productId, 'product');
  if (p.status !== 'active') fail('INVALID_STATE', `product ${p.id} (${p.name}) is archived`);
  return { pr, p };
}
function live(ctx, sid, allowed = LIVE) {
  const s = ctx.get('subscriptions', sid, 'subscription');
  if (!allowed.includes(s.status)) fail('INVALID_STATE', `subscription ${s.id} is '${s.status}'; this action requires: ${allowed.join(', ')}`);
  return s;
}
/** Fraction of the current billing period still ahead of now (0-1). */
const remainingFraction = (ctx, s) => {
  const start = toTime(s.currentPeriodStart), end = toTime(s.currentPeriodEnd), now = toTime(ctx.now);
  return end > start ? Math.min(1, Math.max(0, (end - now) / (end - start))) : 0;
};
const bySub = (ctx, f) => ctx.all('subscriptions').find(f);

export default defineModule({
  id: 'subscriptions',
  code: 'M30',
  name: 'Subscriptions',
  description: 'Manage recurring billing plans for customers: trials, plan changes, quantity, pause/resume and cancellation.',
  tables: { subscriptions: { prefix: 'sub', schema: sub } },
  actions: [
    {
      id: 'create_subscription', name: 'Create subscription',
      description: "Start a recurring subscription for a contact on a recurring (monthly/yearly) price. Trial defaults to the price's trial days; an optional coupon code is validated and redeemed.",
      keywords: ['subscribe', 'start plan', 'recurring billing', 'retainer', 'membership billing'],
      risk: 'write',
      input: z.object({
        contactId: id('contact'), priceId: id('recurring price'), quantity: z.number().int().min(1).default(1),
        trialDays: z.number().int().min(0).max(365).optional().describe("override the price's default trial; 0 = no trial"), couponCode: z.string().optional(),
      }),
      output: sub,
      handler: (i, ctx) => {
        const c = ctx.get('contacts', i.contactId, 'contact');
        if (c.status !== 'active') fail('INVALID_STATE', `contact ${c.id} is ${c.status}`);
        const { pr, p } = recurringPrice(ctx, i.priceId);
        const dup = ctx.all('subscriptions').find((s) => s.contactId === c.id && s.productId === p.id && s.status !== 'cancelled');
        if (dup) fail('DUPLICATE', `contact ${c.id} already has subscription ${dup.id} (${dup.status}) to ${p.name}; use change_subscription_plan or update_subscription_quantity`, { existingId: dup.id });
        let coupon = null;
        if (i.couponCode) {
          coupon = findCoupon(ctx, i.couponCode);
          const ev = evaluateCoupon(ctx, coupon, [{ productId: p.id, amount: pr.amount * i.quantity }]);
          if (!ev.valid) fail('VALIDATION', `coupon ${coupon.code} cannot be used: ${ev.reasons.join('; ')}`, ev);
        }
        const trialDays = i.trialDays ?? pr.trialDays ?? 0;
        const trialEnd = trialDays > 0 ? addDays(ctx.now, trialDays) : null;
        const s = ctx.insert('subscriptions', {
          contactId: c.id, priceId: pr.id, productId: p.id, quantity: i.quantity, status: trialEnd ? 'trialing' : 'active', trialEnd,
          currentPeriodStart: ctx.now, currentPeriodEnd: trialEnd ?? addInterval(ctx.now, pr.interval), cancelAtPeriodEnd: false,
          cancelledAt: null, pausedAt: null, couponCode: coupon?.code ?? null,
        });
        if (coupon) ctx.patch(coupon, { redemptionCount: coupon.redemptionCount + 1 });
        return s;
      },
      example: (ctx) => ({ contactId: 'con_002', priceId: ctx.all('prices').find((p) => p.interval === 'month' && p.status === 'active' && p.trialDays > 0).id }),
    },
    {
      id: 'get_subscription', name: 'Get subscription details', description: 'Fetch one subscription by ID: plan price, quantity, status, trial end, current period and cancellation flags.',
      ...ops.get('subscriptions', { what: 'subscription' }),
      example: (ctx) => ({ id: ctx.all('subscriptions')[0].id }),
    },
    {
      id: 'search_subscriptions', name: 'Search subscriptions',
      description: 'Find subscriptions by contact, product, price, status, scheduled cancellation, or renewal (currentPeriodEnd) date range.',
      keywords: ['list subscriptions', 'active plans', 'renewals', 'churn'],
      ...ops.search('subscriptions', {
        filters: {
          contactId: z.string().optional(), productId: z.string().optional(), priceId: z.string().optional(), status: z.enum(STATUSES).optional(),
          cancelAtPeriodEnd: z.boolean().optional(), currentPeriodEndAfter: isoDate().optional(), currentPeriodEndBefore: isoDate().optional(),
        },
      }),
      example: () => ({ status: 'active' }),
    },
    {
      id: 'change_subscription_plan', name: 'Change subscription plan',
      description: 'Move a subscription to another recurring price (upgrade/downgrade, monthly↔yearly). Returns the prorated amount for the rest of the current period (positive = charge, negative = credit).',
      keywords: ['upgrade', 'downgrade', 'switch plan', 'switch to annual'],
      risk: 'write',
      input: z.object({ id: id('subscription'), priceId: id('new recurring price'), prorate: z.boolean().default(true) }),
      output: z.looseObject({ subscription: sub, proration: z.looseObject({ credit: z.number(), charge: z.number(), net: z.number() }) }),
      handler: ({ id: sid, priceId, prorate }, ctx) => {
        const s = live(ctx, sid, [...LIVE, 'paused']);
        if (s.priceId === priceId) fail('VALIDATION', `subscription ${sid} is already on price ${priceId}`);
        const { pr, p } = recurringPrice(ctx, priceId);
        const old = ctx.get('prices', s.priceId, 'price');
        if (old.currency !== pr.currency) fail('VALIDATION', `new price is in ${pr.currency} but the subscription bills in ${old.currency}; pick a ${old.currency} price`);
        const f = prorate && s.status !== 'trialing' ? remainingFraction(ctx, s) : 0;
        const intervalChanged = old.interval !== pr.interval;
        // Same interval: swap plans for the rest of the period. Interval change: a new full period starts now, minus unused credit.
        const credit = round2(old.amount * s.quantity * f);
        const charge = !prorate || s.status === 'trialing' ? 0 : round2(pr.amount * s.quantity * (intervalChanged ? 1 : f));
        ctx.patch(s, {
          priceId: pr.id, productId: p.id,
          ...(intervalChanged && s.status !== 'trialing' ? { currentPeriodStart: ctx.now, currentPeriodEnd: addInterval(ctx.now, pr.interval) } : {}),
        });
        return {
          subscription: s,
          proration: { fromPriceId: old.id, toPriceId: pr.id, fractionRemaining: round2(f), credit, charge, net: round2(charge - credit), currency: pr.currency, billingPeriodReset: intervalChanged },
        };
      },
      example: (ctx) => {
        const s = bySub(ctx, (x) => x.status === 'active' && ctx.all('prices').some((p) => p.productId === x.productId && p.id !== x.priceId && p.interval !== 'one_time' && p.status === 'active' && p.currency === 'USD'));
        return { id: s.id, priceId: ctx.all('prices').find((p) => p.productId === s.productId && p.id !== s.priceId && p.interval !== 'one_time' && p.status === 'active' && p.currency === 'USD').id };
      },
    },
    {
      id: 'update_subscription_quantity', name: 'Update subscription quantity', description: 'Change the number of seats/units billed on a live subscription (applies from the next invoice).',
      keywords: ['seats', 'licenses', 'units'],
      risk: 'write',
      input: z.object({ id: id('subscription'), quantity: z.number().int().min(1) }),
      output: sub,
      handler: ({ id: sid, quantity }, ctx) => {
        const s = live(ctx, sid, [...LIVE, 'paused']);
        if (s.quantity === quantity) fail('VALIDATION', `subscription ${sid} already has quantity ${quantity}`);
        return ctx.patch(s, { quantity });
      },
      example: (ctx) => ({ id: bySub(ctx, (x) => x.status === 'active').id, quantity: 3 }),
    },
    {
      id: 'set_subscription_trial_end', name: 'Set subscription trial end',
      description: 'Set or extend the free-trial end date of a subscription (must be in the future). Puts the subscription in trialing until that date; first charge happens then.',
      keywords: ['extend trial', 'free trial'],
      risk: 'write',
      input: z.object({ id: id('subscription'), trialEnd: isoDate('new trial end, e.g. 2026-12-01') }),
      output: sub,
      handler: ({ id: sid, trialEnd }, ctx) => {
        const s = live(ctx, sid, ['trialing', 'active']);
        if (toTime(trialEnd) <= toTime(ctx.now)) fail('VALIDATION', `trialEnd must be after now (${ctx.now})`);
        const iso = new Date(toTime(trialEnd)).toISOString();
        return ctx.patch(s, { status: 'trialing', trialEnd: iso, currentPeriodEnd: iso });
      },
      example: (ctx) => ({ id: bySub(ctx, (x) => x.status === 'trialing').id, trialEnd: '2026-12-15' }),
    },
    {
      id: 'pause_subscription', name: 'Pause subscription', description: 'Temporarily stop billing a live subscription (no invoices while paused). Use resume_subscription to restart.',
      keywords: ['hold', 'freeze', 'suspend billing'],
      risk: 'write',
      input: z.object({ id: id('subscription'), resumeAt: isoDate('optional planned resume date').optional() }),
      output: sub,
      handler: ({ id: sid, resumeAt }, ctx) => {
        const s = live(ctx, sid);
        if (resumeAt && toTime(resumeAt) <= toTime(ctx.now)) fail('VALIDATION', 'resumeAt must be in the future');
        return ctx.patch(s, { status: 'paused', pausedAt: ctx.now, pausedFromStatus: s.status, resumeAt: resumeAt ?? null });
      },
      example: (ctx) => ({ id: bySub(ctx, (x) => x.status === 'active').id }),
    },
    {
      id: 'resume_subscription', name: 'Resume subscription',
      description: 'Restart a paused subscription (a new billing period starts now if the old one lapsed), or undo a scheduled cancel-at-period-end.',
      keywords: ['unpause', 'reactivate', 'undo cancellation'],
      risk: 'write',
      input: z.object({ id: id('subscription') }),
      output: sub,
      handler: ({ id: sid }, ctx) => {
        const s = ctx.get('subscriptions', sid, 'subscription');
        if (s.status === 'paused') {
          const pr = ctx.get('prices', s.priceId, 'price');
          const lapsed = toTime(s.currentPeriodEnd) <= toTime(ctx.now);
          // past_due stays past_due: pausing must not clear an unpaid balance
          const back = s.pausedFromStatus === 'past_due' ? 'past_due' : s.pausedFromStatus === 'trialing' && !lapsed ? 'trialing' : 'active';
          return ctx.patch(s, {
            status: back, pausedAt: null, resumeAt: null, pausedFromStatus: undefined,
            ...(lapsed ? { currentPeriodStart: ctx.now, currentPeriodEnd: addInterval(ctx.now, pr.interval) } : {}),
          });
        }
        if (s.cancelAtPeriodEnd && s.status !== 'cancelled') return ctx.patch(s, { cancelAtPeriodEnd: false });
        fail('INVALID_STATE', `subscription ${sid} is '${s.status}' and not scheduled to cancel; only paused subscriptions (or ones set to cancel at period end) can be resumed${s.status === 'cancelled' ? ' — create a new subscription instead' : ''}`);
      },
      example: (ctx) => ({ id: bySub(ctx, (x) => x.status === 'paused').id }),
    },
    {
      id: 'cancel_subscription', name: 'Cancel subscription',
      description: 'Cancel a subscription immediately, or at the end of the current paid period (atPeriodEnd=true keeps access until then).',
      keywords: ['unsubscribe', 'stop plan', 'end subscription', 'churn'],
      risk: 'destructive',
      input: z.object({ id: id('subscription'), atPeriodEnd: z.boolean().default(false), reason: z.string().optional() }),
      output: sub,
      handler: ({ id: sid, atPeriodEnd, reason }, ctx) => {
        const s = live(ctx, sid, [...LIVE, 'paused']);
        if (atPeriodEnd) {
          if (s.cancelAtPeriodEnd) fail('INVALID_STATE', `subscription ${sid} is already set to cancel on ${s.currentPeriodEnd}`);
          if (s.status === 'paused') fail('INVALID_STATE', `subscription ${sid} is paused; cancel immediately (atPeriodEnd=false) or resume first`);
          return ctx.patch(s, { cancelAtPeriodEnd: true, cancelReason: reason ?? null });
        }
        return ctx.patch(s, { status: 'cancelled', cancelledAt: ctx.now, cancelAtPeriodEnd: false, cancelReason: reason ?? null });
      },
      example: (ctx) => ({ id: bySub(ctx, (x) => x.status === 'active').id, atPeriodEnd: true, reason: 'Budget cuts' }),
    },
    {
      id: 'preview_next_invoice', name: 'Preview next subscription invoice',
      description: 'Preview what the next renewal of a subscription will bill: date, line items, coupon discount and total. Read-only; does not create an invoice.',
      keywords: ['upcoming invoice', 'next charge', 'renewal amount', 'next bill'],
      risk: 'read',
      input: z.object({ id: id('subscription') }),
      output: z.looseObject({ subscriptionId: z.string(), invoiceDate: z.string(), lineItems: z.array(z.looseObject({})), subtotal: z.number(), discount: z.number(), total: z.number() }),
      handler: ({ id: sid }, ctx) => {
        const s = ctx.get('subscriptions', sid, 'subscription');
        if (s.status === 'cancelled') fail('INVALID_STATE', `subscription ${sid} is cancelled; there is no upcoming invoice`);
        if (s.status === 'paused') fail('INVALID_STATE', `subscription ${sid} is paused; resume it to see the next invoice`);
        if (s.cancelAtPeriodEnd) fail('INVALID_STATE', `subscription ${sid} cancels on ${s.currentPeriodEnd}; no further invoices (resume_subscription undoes the cancellation)`);
        const pr = ctx.get('prices', s.priceId, 'price');
        const p = ctx.find('products', s.productId);
        const invoiceDate = s.status === 'trialing' && s.trialEnd ? s.trialEnd : s.currentPeriodEnd;
        const amount = round2(pr.amount * s.quantity);
        const lineItems = [{ description: `${p?.name ?? pr.label} (${pr.interval}ly) × ${s.quantity}`, productId: s.productId, priceId: pr.id, quantity: s.quantity, unitPrice: pr.amount, amount }];
        let coupon = null, discount = 0;
        if (s.couponCode) {
          const c = ctx.all('coupons').find((x) => x.code === s.couponCode);
          const ev = c ? evaluateCoupon(ctx, c, lineItems, { at: invoiceDate, ignoreRedemptions: true }) : { valid: false, reasons: ['coupon no longer exists'] };
          coupon = { code: s.couponCode, applied: ev.valid, ...(ev.valid ? { discountType: ev.discountType, discountValue: ev.discountValue } : { reasons: ev.reasons }) };
          discount = ev.valid ? ev.discount : 0;
        }
        return {
          subscriptionId: s.id, contactId: s.contactId, status: s.status, invoiceDate, periodStart: invoiceDate, periodEnd: addInterval(invoiceDate, pr.interval),
          currency: pr.currency, lineItems, subtotal: amount, discount, coupon, total: round2(amount - discount),
        };
      },
      example: (ctx) => ({ id: bySub(ctx, (x) => x.couponCode && x.status === 'active').id }),
    },
  ],

  seed(ctx, h) {
    const prices = ctx.all('prices').filter((p) => p.interval !== 'one_time' && p.status === 'active' && p.currency === 'USD');
    if (!prices.length) return;
    const contacts = ctx.all('contacts');
    const con = (i) => contacts[i]?.id ?? `con_${String(i + 1).padStart(3, '0')}`;
    const sku = (s, interval) => {
      const pid = ctx.all('products').find((p) => p.sku === s)?.id;
      return prices.find((p) => p.productId === pid && p.interval === interval) ?? prices[0];
    };
    // [contactIdx, sku, interval, status, startedDaysAgo, extra]
    const rows = [
      [0, 'SEO-RET', 'month', 'active', 95, { couponCode: 'WELCOME10' }],
      [2, 'HOST-CARE', 'year', 'active', 200],
      [5, 'SMM-STD', 'month', 'trialing', 4],
      [7, 'HOST-CARE', 'month', 'active', 50, { quantity: 3 }],
      [10, 'SEO-RET', 'year', 'active', 30],
      [12, 'SMM-STD', 'month', 'paused', 120],
      [15, 'HOST-CARE', 'month', 'past_due', 70],
      [18, 'SMM-STD', 'year', 'active', 300, { cancelAtPeriodEnd: true, cancelReason: 'Moving to in-house team' }],
      [21, 'SEO-RET', 'month', 'cancelled', 150],
      [24, 'HOST-CARE', 'month', 'trialing', 20],
    ];
    for (const [ci, s, interval, status, ago, extra = {}] of rows) {
      const pr = sku(s, interval);
      const started = h.daysAgo(ago);
      let start = started, end = addInterval(started, pr.interval);
      while (toTime(end) <= toTime(ctx.now) && status !== 'cancelled' && status !== 'paused' && status !== 'past_due') (start = end), (end = addInterval(end, pr.interval));
      const trialEnd = status === 'trialing' ? addDays(started, pr.trialDays || 14) : null;
      ctx.insert('subscriptions', {
        contactId: con(ci), priceId: pr.id, productId: pr.productId, quantity: 1, status, trialEnd,
        currentPeriodStart: status === 'trialing' ? started : start, currentPeriodEnd: trialEnd ?? end, cancelAtPeriodEnd: false,
        cancelledAt: status === 'cancelled' ? h.daysAgo(20) : null, pausedAt: status === 'paused' ? h.daysAgo(10) : null,
        ...(status === 'paused' ? { pausedFromStatus: 'active' } : {}), couponCode: null, createdAt: started, ...extra,
      });
    }
  },
});
