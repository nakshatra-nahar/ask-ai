import { defineModule, ops, z, id, entity, isoDate, fail, toTime, round2 } from '../kit.js';

const TYPES = ['percent', 'fixed'];
const coupon = entity({
  code: z.string(), description: z.string().optional(), discountType: z.enum(TYPES), discountValue: z.number(),
  validFrom: z.string().nullable().optional(), validUntil: z.string().nullable().optional(),
  maxRedemptions: z.number().nullable().optional(), redemptionCount: z.number(), productIds: z.array(z.string()),
  status: z.enum(['active', 'inactive']),
});
const evaluation = z.looseObject({
  valid: z.boolean(), couponId: z.string(), code: z.string(), discountType: z.enum(TYPES), discountValue: z.number(),
  eligibleAmount: z.number(), discount: z.number(), reasons: z.array(z.string()),
});

export const findCoupon = (ctx, code) =>
  ctx.all('coupons').find((c) => c.code.toLowerCase() === code.toLowerCase()) || fail('NOT_FOUND', `coupon code '${code}' not found; use coupons.search_coupons to list codes`);

/**
 * Single source of truth for coupon eligibility (used by coupons.validate_coupon, orders.apply_coupon, subscriptions preview).
 * lines: [{productId, amount}]. ignoreRedemptions: true for coupons already redeemed (e.g. on a subscription).
 */
export function evaluateCoupon(ctx, c, lines, { at = ctx.now, ignoreRedemptions = false } = {}) {
  const reasons = [];
  if (c.status !== 'active') reasons.push(`coupon is ${c.status}`);
  if (c.validFrom && toTime(c.validFrom) > toTime(at)) reasons.push(`not valid until ${c.validFrom}`);
  if (c.validUntil && toTime(c.validUntil, true) < toTime(at)) reasons.push(`expired on ${c.validUntil}`);
  if (!ignoreRedemptions && c.maxRedemptions != null && c.redemptionCount >= c.maxRedemptions)
    reasons.push(`redemption limit reached (${c.redemptionCount}/${c.maxRedemptions})`);
  const restricted = c.productIds?.length > 0;
  const eligible = restricted ? lines.filter((l) => c.productIds.includes(l.productId)) : lines;
  if (restricted && !eligible.length) reasons.push(`only applies to products ${c.productIds.join(', ')}; none are in this order`);
  const eligibleAmount = round2(eligible.reduce((s, l) => s + l.amount, 0));
  if (!reasons.length && eligibleAmount <= 0) reasons.push('order amount is 0; add line items first');
  const discount = reasons.length ? 0 : round2(c.discountType === 'percent' ? (eligibleAmount * c.discountValue) / 100 : Math.min(c.discountValue, eligibleAmount));
  return { valid: !reasons.length, couponId: c.id, code: c.code, discountType: c.discountType, discountValue: c.discountValue, eligibleAmount, discount, reasons };
}

function checkValue(type, value) {
  if (type === 'percent' && (value <= 0 || value > 100)) fail('VALIDATION', 'percent discounts must be greater than 0 and at most 100');
  if (type === 'fixed' && value <= 0) fail('VALIDATION', 'fixed discounts must be a positive amount');
}
function checkWindow(from, until) {
  if (from && until && toTime(until, true) < toTime(from)) fail('VALIDATION', `validUntil (${until}) must be on or after validFrom (${from})`);
}
function checkProducts(ctx, ids) {
  for (const pid of ids) {
    const p = ctx.get('products', pid, 'product');
    if (p.status !== 'active') fail('INVALID_STATE', `product ${pid} (${p.name}) is archived and cannot be a coupon target`);
  }
}
const byCode = (ctx, code) => ctx.all('coupons').find((c) => c.code === code);

export default defineModule({
  id: 'coupons',
  code: 'M31',
  name: 'Coupons',
  description: 'Create and manage discount codes: value, validity window, redemption limits and product restrictions.',
  tables: { coupons: { prefix: 'cpn', schema: coupon } },
  actions: [
    {
      id: 'create_coupon', name: 'Create coupon',
      description: 'Create a discount code (percent or fixed amount) with optional validity window, redemption limit and product restriction. Codes are unique.',
      keywords: ['promo code', 'discount code', 'voucher', 'promotion'],
      ...ops.create('coupons', {
        input: z.object({
          code: z.string().min(3).max(32).regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, dash, underscore').transform((s) => s.toUpperCase()),
          description: z.string().optional(), discountType: z.enum(TYPES), discountValue: z.number().positive().describe('percent (1-100) or amount'),
          validFrom: isoDate().optional(), validUntil: isoDate().optional(),
          maxRedemptions: z.number().int().min(1).optional(), productIds: z.array(z.string()).optional().describe('restrict to these products'),
        }),
        check: (i, ctx) => {
          const dup = ctx.all('coupons').find((c) => c.code.toLowerCase() === i.code.toLowerCase());
          if (dup) fail('DUPLICATE', `coupon code ${i.code} already exists (${dup.id}, ${dup.status})`, { existingId: dup.id });
          checkValue(i.discountType, i.discountValue);
          checkWindow(i.validFrom, i.validUntil);
          checkProducts(ctx, i.productIds || []);
        },
        build: (i) => ({
          description: i.description ?? '', validFrom: i.validFrom ?? null, validUntil: i.validUntil ?? null,
          maxRedemptions: i.maxRedemptions ?? null, redemptionCount: 0, productIds: i.productIds || [], status: 'active',
        }),
      }),
      example: () => ({ code: 'SPRING15', discountType: 'percent', discountValue: 15, validFrom: '2026-12-01', validUntil: '2026-12-31' }),
    },
    {
      id: 'get_coupon', name: 'Get coupon details', description: 'Fetch one coupon by ID (code, value, window, redemptions, product restriction).',
      ...ops.get('coupons', { what: 'coupon' }),
      example: (ctx) => ({ id: byCode(ctx, 'WELCOME10').id }),
    },
    {
      id: 'search_coupons', name: 'Search coupons',
      description: 'Find coupons by code/description text, status, or discount type.',
      keywords: ['list promo codes', 'find discount code'],
      ...ops.search('coupons', {
        text: ['code', 'description'],
        filters: { status: z.enum(['active', 'inactive']).optional(), discountType: z.enum(TYPES).optional() },
      }),
      example: () => ({ status: 'active' }),
    },
    {
      id: 'update_coupon_description', name: 'Update coupon description', description: 'Change the internal/customer-facing description of a coupon.',
      ...ops.set('coupons', 'description', z.string().min(1).max(200), { what: 'coupon' }),
      example: (ctx) => ({ id: byCode(ctx, 'WELCOME10').id, description: '10% off the first order for new customers' }),
    },
    {
      id: 'set_discount_value', name: 'Set discount value',
      description: 'Change how much a coupon takes off: a percent (max 100) or a fixed amount. Optionally switch the discount type.',
      risk: 'write',
      input: z.object({ id: id('coupon'), discountValue: z.number().positive(), discountType: z.enum(TYPES).optional().describe('defaults to the current type') }),
      output: coupon,
      handler: ({ id: cid, discountValue, discountType }, ctx) => {
        const c = ctx.get('coupons', cid, 'coupon');
        const type = discountType ?? c.discountType;
        checkValue(type, discountValue);
        return ctx.patch(c, { discountType: type, discountValue });
      },
      example: (ctx) => ({ id: byCode(ctx, 'WELCOME10').id, discountValue: 12 }),
    },
    {
      id: 'set_coupon_validity_window', name: 'Set coupon validity window',
      description: 'Set when a coupon can be redeemed (validFrom / validUntil dates). Pass null to remove a bound.',
      keywords: ['expiry', 'start date', 'end date', 'extend coupon'],
      risk: 'write',
      input: z.object({ id: id('coupon'), validFrom: isoDate().nullable().optional(), validUntil: isoDate().nullable().optional() }),
      output: coupon,
      handler: ({ id: cid, ...w }, ctx) => {
        const c = ctx.get('coupons', cid, 'coupon');
        if (!Object.keys(w).length) fail('VALIDATION', 'provide validFrom and/or validUntil');
        const next = { validFrom: c.validFrom, validUntil: c.validUntil, ...w };
        checkWindow(next.validFrom, next.validUntil);
        return ctx.patch(c, next);
      },
      example: (ctx) => ({ id: byCode(ctx, 'SUMMER20').id, validUntil: '2026-12-31' }),
    },
    {
      id: 'set_redemption_limit', name: 'Set redemption limit',
      description: 'Cap how many times a coupon can be redeemed in total (null = unlimited). Cannot be set below redemptions already used.',
      risk: 'write',
      input: z.object({ id: id('coupon'), maxRedemptions: z.number().int().min(1).nullable() }),
      output: coupon,
      handler: ({ id: cid, maxRedemptions }, ctx) => {
        const c = ctx.get('coupons', cid, 'coupon');
        if (maxRedemptions != null && maxRedemptions < c.redemptionCount)
          fail('VALIDATION', `coupon ${c.code} has already been redeemed ${c.redemptionCount} times; limit must be at least ${c.redemptionCount}`);
        return ctx.patch(c, { maxRedemptions });
      },
      example: (ctx) => ({ id: byCode(ctx, 'LAUNCH50').id, maxRedemptions: 50 }),
    },
    {
      id: 'restrict_coupon_to_products', name: 'Restrict coupon to products',
      description: 'Limit a coupon to specific products (discount applies only to those lines). An empty list removes the restriction.',
      risk: 'write',
      input: z.object({ id: id('coupon'), productIds: z.array(z.string()).describe('product IDs; [] = applies to all products') }),
      output: coupon,
      handler: ({ id: cid, productIds }, ctx) => {
        const c = ctx.get('coupons', cid, 'coupon');
        checkProducts(ctx, productIds);
        return ctx.patch(c, { productIds: [...new Set(productIds)] });
      },
      example: (ctx) => ({ id: byCode(ctx, 'WELCOME10').id, productIds: [ctx.all('products').find((p) => p.sku === 'WHT-KIT').id] }),
    },
    {
      id: 'validate_coupon', name: 'Validate coupon for order',
      description: 'Check whether a coupon code can be used right now on an order (orderId) or a basket (productIds + amount): active, within window, redemptions left, product restriction. Returns valid, discount and reasons. Does not apply it (use orders.apply_coupon_to_order).',
      keywords: ['check promo code', 'is coupon valid', 'discount preview'],
      risk: 'read',
      input: z.object({
        code: z.string().min(1).describe('coupon code'), orderId: z.string().optional(),
        productIds: z.array(z.string()).optional().describe('basket products when no orderId'), amount: z.number().nonnegative().optional().describe('basket subtotal when no orderId'),
      }).refine((i) => i.orderId || i.amount != null, 'provide orderId, or amount (with optional productIds)'),
      output: evaluation,
      handler: ({ code, orderId, productIds = [], amount }, ctx) => {
        const c = findCoupon(ctx, code);
        let lines;
        if (orderId) lines = (ctx.get('orders', orderId, 'order').lineItems || []).map((l) => ({ productId: l.productId, amount: l.amount }));
        // shortcut: basket mode has no per-product amounts, so a restricted coupon applies to the whole amount if any listed product matches; pass orderId for exact lines.
        else lines = [{ productId: productIds.find((p) => c.productIds.includes(p)) ?? productIds[0] ?? null, amount }];
        return evaluateCoupon(ctx, c, lines);
      },
      example: () => ({ code: 'WELCOME10', amount: 200 }),
    },
    {
      id: 'deactivate_coupon', name: 'Deactivate coupon',
      description: 'Turn off a coupon so it can no longer be redeemed. Orders and subscriptions that already used it keep their discount history.',
      keywords: ['disable coupon', 'kill promo code', 'expire coupon'],
      ...ops.transition('coupons', { to: 'inactive', from: ['active'], risk: 'destructive', what: 'coupon' }),
      example: (ctx) => ({ id: byCode(ctx, 'SEO15').id }),
    },
  ],

  seed(ctx) {
    const sku = (s) => ctx.all('products').find((p) => p.sku === s)?.id;
    const rows = [
      { code: 'WELCOME10', description: 'New customer welcome discount', discountType: 'percent', discountValue: 10, validFrom: '2026-01-01', redemptionCount: 37 },
      { code: 'BLACKFRIDAY25', description: 'Black Friday weekend sale', discountType: 'percent', discountValue: 25, validFrom: '2026-11-27', validUntil: '2026-11-30', maxRedemptions: 200 },
      { code: 'SUMMER20', description: 'Summer promo (ended)', discountType: 'percent', discountValue: 20, validFrom: '2026-06-01', validUntil: '2026-08-31', redemptionCount: 54 },
      { code: 'LAUNCH50', description: '$50 off for launch week signups', discountType: 'fixed', discountValue: 50, maxRedemptions: 25, redemptionCount: 25 },
      { code: 'SEO15', description: '15% off the SEO retainer', discountType: 'percent', discountValue: 15, productIds: [sku('SEO-RET')], redemptionCount: 4 },
      { code: 'MERCH5', description: '$5 off branded merch', discountType: 'fixed', discountValue: 5, productIds: [sku('TEE-LOGO'), sku('HOOD-LOGO'), sku('MUG-11OZ')], maxRedemptions: 100, redemptionCount: 12 },
      { code: 'VIP20', description: 'Old VIP code (retired)', discountType: 'percent', discountValue: 20, status: 'inactive', redemptionCount: 9 },
    ];
    for (const r of rows)
      ctx.insert('coupons', {
        description: '', validFrom: null, validUntil: null, maxRedemptions: null, redemptionCount: 0, status: 'active', ...r,
        productIds: (r.productIds || []).filter(Boolean),
      });
  },
});
