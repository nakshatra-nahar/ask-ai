import { defineModule, ops, z, id, entity, isoDate, limit, fail, page, textMatch, matchFilters, round2 } from '../kit.js';
import { findVariant, reservedQty, syncStock } from './m25-products.js';
import { evaluateCoupon, findCoupon } from './m31-coupons.js';

const STATUSES = ['draft', 'submitted', 'fulfilled', 'cancelled'];
const line = z.looseObject({
  id: z.string(), productId: z.string(), variantId: z.string().nullable(), priceId: z.string().nullable(), name: z.string(),
  quantity: z.number(), unitPrice: z.number(), amount: z.number(), requiresShipping: z.boolean(),
});
const address = z.object({
  name: z.string().optional(), line1: z.string().min(1), line2: z.string().optional(), city: z.string().min(1),
  state: z.string().optional().describe('state/province code, e.g. CA'), postalCode: z.string().min(1),
  country: z.string().length(2).transform((s) => s.toUpperCase()).describe('ISO 3166 2-letter country, e.g. US, GB'),
});
const order = entity({
  number: z.string(), contactId: z.string(), status: z.enum(STATUSES), lineItems: z.array(line), shippingAddress: z.looseObject({}).nullable().optional(),
  couponId: z.string().nullable().optional(), couponCode: z.string().nullable().optional(),
  subtotal: z.number(), discount: z.number(), total: z.number(), currency: z.string(),
});

export function buildOrderLine(ctx, { productId, variantId, priceId, quantity }) {
  const p = ctx.get('products', productId, 'product');
  if (p.status !== 'active') fail('INVALID_STATE', `product ${p.id} (${p.name}) is archived and cannot be ordered`);
  let v = null;
  if (p.variants?.length) {
    if (!variantId) fail('VALIDATION', `product ${p.id} has variants; pass variantId (one of ${p.variants.filter((x) => x.status === 'active').map((x) => `${x.id} ${x.name}`).join(', ')})`);
    v = findVariant(p, variantId);
    if (v.status !== 'active') fail('INVALID_STATE', `variant ${v.id} (${v.name}) is archived and cannot be ordered`);
  } else if (variantId) fail('VALIDATION', `product ${p.id} has no variants; omit variantId`);
  const price = priceId ? ctx.get('prices', priceId, 'price') : p.defaultPriceId ? ctx.find('prices', p.defaultPriceId) : null;
  if (price && price.productId !== p.id) fail('VALIDATION', `price ${price.id} belongs to product ${price.productId}, not ${p.id}`);
  if (price && price.status !== 'active') fail('INVALID_STATE', `price ${price.id} is archived; pick an active price with prices.list_product_prices`);
  if (price && price.interval !== 'one_time') fail('VALIDATION', `price ${price.id} is recurring (${price.interval}); orders take one-time prices — use subscriptions.create_subscription for plans`);
  if (price && price.currency !== 'USD') fail('VALIDATION', `price ${price.id} is in ${price.currency}; orders are billed in USD — pick a USD price`);
  const unitPrice = priceId ? price.amount : v?.price ?? price?.amount;
  if (unitPrice == null) fail('INVALID_STATE', `product ${p.id} has no active one-time default price; set one with prices.set_default_price or pass priceId`);
  return {
    id: ctx.newId('oli'), productId: p.id, variantId: v?.id ?? null, priceId: price?.id ?? null, name: v ? `${p.name} — ${v.name}` : p.name,
    sku: (v || p).sku ?? null, quantity, unitPrice, amount: round2(unitPrice * quantity), requiresShipping: p.type === 'physical',
  };
}

/** Recompute totals; re-checks an applied coupon (already counted, so redemption limit ignored) and drops it if no longer valid. */
function recalc(ctx, o) {
  o.subtotal = round2(o.lineItems.reduce((s, l) => s + l.amount, 0));
  o.discount = 0;
  let couponRemoved;
  if (o.couponId) {
    const c = ctx.find('coupons', o.couponId);
    const ev = c && evaluateCoupon(ctx, c, o.lineItems, { ignoreRedemptions: true });
    if (ev?.valid) o.discount = ev.discount;
    else (couponRemoved = { code: o.couponCode, reasons: ev?.reasons || ['coupon deleted'] }), (o.couponId = null), (o.couponCode = null);
  }
  o.total = round2(o.subtotal - o.discount);
  ctx.patch(o, {});
  return couponRemoved ? { ...o, couponRemoved } : o;
}
function draft(ctx, oid) {
  const o = ctx.get('orders', oid, 'order');
  if (o.status !== 'draft') fail('INVALID_STATE', `order ${o.id} is '${o.status}'; only draft orders can be edited`);
  return o;
}
const nextNumber = (ctx) => `ORD-${1001 + ctx.all('orders').reduce((m, o) => Math.max(m, Number(o.number?.split('-')[1]) - 1000 || 0), 0)}`;
const byNum = (ctx, n) => ctx.all('orders').find((o) => o.number === n);

export default defineModule({
  id: 'orders',
  code: 'M32',
  name: 'Orders',
  description: 'Build, submit, and fulfil product orders with stock reservation, coupons and shipping.',
  tables: { orders: { prefix: 'ord', schema: order } },
  actions: [
    {
      id: 'create_order', name: 'Create draft order',
      description: 'Start a draft product order for a contact. Add lines with add_order_line_item, then submit_order to reserve stock. (Quotes and invoices are separate modules.)',
      keywords: ['new order', 'start order', 'cart', 'checkout'],
      risk: 'write',
      input: z.object({ contactId: id('contact'), shippingAddress: address.optional(), notes: z.string().optional() }),
      output: order,
      handler: ({ contactId, shippingAddress, notes }, ctx) => {
        const c = ctx.get('contacts', contactId, 'contact');
        if (c.status !== 'active') fail('INVALID_STATE', `contact ${c.id} is ${c.status}`);
        return ctx.insert('orders', {
          number: nextNumber(ctx), contactId, status: 'draft', lineItems: [], shippingAddress: shippingAddress ?? null, couponId: null, couponCode: null,
          subtotal: 0, discount: 0, total: 0, currency: 'USD', notes: notes ?? '', submittedAt: null, fulfilledAt: null, cancelledAt: null,
        });
      },
      example: () => ({ contactId: 'con_001' }),
    },
    {
      id: 'get_order', name: 'Get order details', description: 'Fetch one product order by ID with its lines, shipping address, coupon and totals.',
      ...ops.get('orders', { what: 'order' }),
      example: (ctx) => ({ id: ctx.all('orders')[0].id }),
    },
    {
      id: 'search_orders', name: 'Search orders',
      description: 'Find product orders by number, contact, status, product, total range or created date range.',
      keywords: ['list orders', 'find order', 'unfulfilled orders', 'open orders'],
      risk: 'read',
      input: z.object({
        query: z.string().optional().describe('order number text'), contactId: z.string().optional(), status: z.enum(STATUSES).optional(),
        productId: z.string().optional().describe('orders containing this product'), totalMin: z.number().optional(), totalMax: z.number().optional(),
        createdAtAfter: isoDate().optional(), createdAtBefore: isoDate().optional(), limit,
      }),
      output: z.looseObject({ total: z.number(), items: z.array(order) }),
      handler: ({ query, productId, limit: lim, ...f }, ctx) =>
        page(ctx.all('orders').filter((o) => textMatch(o, ['number'], query) && matchFilters(o, f) && (!productId || o.lineItems.some((l) => l.productId === productId))), lim),
      example: () => ({ status: 'submitted' }),
    },
    {
      id: 'add_order_line_item', name: 'Add order line item',
      description: 'Add a product (and variant, if it has variants) to a draft order. Unit price comes from priceId, else the variant override, else the product default one-time price. Same product+variant merges quantities.',
      keywords: ['add to cart', 'add product to order'],
      risk: 'write',
      input: z.object({
        id: id('order'), productId: id('product'), variantId: z.string().optional(), priceId: z.string().optional().describe('one-time price; defaults to product default'),
        quantity: z.number().int().min(1).default(1),
      }),
      output: order,
      handler: ({ id: oid, ...item }, ctx) => {
        const o = draft(ctx, oid);
        const l = buildOrderLine(ctx, item);
        const same = o.lineItems.find((x) => x.productId === l.productId && x.variantId === l.variantId && x.priceId === l.priceId);
        if (same) (same.quantity += l.quantity), (same.amount = round2(same.quantity * same.unitPrice));
        else o.lineItems.push(l);
        return recalc(ctx, o);
      },
      example: (ctx) => ({ id: byNum(ctx, 'ORD-1012').id, productId: ctx.all('products').find((p) => p.sku === 'MUG-11OZ').id, quantity: 2 }),
    },
    {
      id: 'update_order_quantity', name: 'Update order quantity',
      description: 'Change the quantity of a line on a draft order; quantity 0 removes the line. Totals and any applied coupon are recalculated.',
      risk: 'write',
      input: z.object({ id: id('order'), lineItemId: id('order line item'), quantity: z.number().int().min(0).describe('0 removes the line') }),
      output: order,
      handler: ({ id: oid, lineItemId, quantity }, ctx) => {
        const o = draft(ctx, oid);
        const l = o.lineItems.find((x) => x.id === lineItemId);
        if (!l) fail('NOT_FOUND', `line ${lineItemId} not on order ${oid}; lines: ${o.lineItems.map((x) => `${x.id} ${x.name}`).join(', ') || 'none'}`);
        if (quantity === 0) o.lineItems = o.lineItems.filter((x) => x !== l);
        else (l.quantity = quantity), (l.amount = round2(quantity * l.unitPrice));
        return recalc(ctx, o);
      },
      example: (ctx) => {
        const o = byNum(ctx, 'ORD-1006');
        return { id: o.id, lineItemId: o.lineItems[0].id, quantity: 3 };
      },
    },
    {
      id: 'set_order_shipping_address', name: 'Set order shipping address',
      description: 'Set or replace the shipping address of a draft order (required before submitting orders with physical items).',
      keywords: ['ship to', 'delivery address'],
      risk: 'write',
      input: z.object({ id: id('order'), address }),
      output: order,
      handler: ({ id: oid, address: a }, ctx) => ctx.patch(draft(ctx, oid), { shippingAddress: a }),
      example: (ctx) => ({ id: byNum(ctx, 'ORD-1007').id, address: { name: 'Olivia Martin', line1: '88 Pine St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' } }),
    },
    {
      id: 'apply_coupon_to_order', name: 'Apply coupon to order',
      description: 'Apply a coupon code to a draft order using the same rules as coupons.validate_coupon (active, window, redemptions left, product restriction); stores the discount. Replaces any existing coupon.',
      keywords: ['promo code', 'discount code', 'redeem coupon'],
      risk: 'write',
      input: z.object({ id: id('order'), code: z.string().min(1) }),
      output: order,
      handler: ({ id: oid, code }, ctx) => {
        const o = draft(ctx, oid);
        const c = findCoupon(ctx, code);
        const ev = evaluateCoupon(ctx, c, o.lineItems);
        if (!ev.valid) fail('VALIDATION', `coupon ${c.code} cannot be applied to ${o.id}: ${ev.reasons.join('; ')}`, ev);
        o.couponId = c.id;
        o.couponCode = c.code;
        return recalc(ctx, o);
      },
      example: (ctx) => ({ id: byNum(ctx, 'ORD-1006').id, code: 'WELCOME10' }),
    },
    {
      id: 'submit_order', name: 'Submit order',
      description: 'Submit a draft order: requires lines, a shipping address when any item is physical, and enough available stock (on hand minus other reservations). Reserves stock and redeems the coupon.',
      keywords: ['place order', 'confirm order', 'checkout'],
      risk: 'write',
      input: z.object({ id: id('order') }),
      output: order,
      handler: ({ id: oid }, ctx) => {
        const o = draft(ctx, oid);
        if (!o.lineItems.length) fail('VALIDATION', `order ${o.id} has no line items; add some with add_order_line_item`);
        if (o.lineItems.some((l) => l.requiresShipping) && !o.shippingAddress)
          fail('VALIDATION', `order ${o.id} contains physical items and has no shipping address; set one with set_order_shipping_address`);
        const need = new Map();
        for (const l of o.lineItems) {
          const k = `${l.productId}|${l.variantId ?? ''}`;
          need.set(k, (need.get(k) || 0) + l.quantity);
        }
        const short = [];
        for (const [k, qty] of need) {
          const [pid, vid] = k.split('|');
          const p = ctx.get('products', pid, 'product');
          if (p.status !== 'active') fail('INVALID_STATE', `product ${pid} (${p.name}) was archived; remove it from the order`);
          const v = vid ? findVariant(p, vid) : null;
          const inv = (v || p).inventory;
          if (!inv.tracked) continue;
          const avail = inv.quantity - reservedQty(ctx, pid, vid || null, o.id).reserved;
          if (qty > avail) short.push(`${v ? `${p.name} — ${v.name}` : p.name}: need ${qty}, available ${Math.max(avail, 0)}`);
        }
        if (short.length) fail('LIMIT_EXCEEDED', `insufficient stock — ${short.join('; ')}. Reduce quantities or restock with products.set_inventory_quantity`);
        if (o.couponId) {
          const c = ctx.get('coupons', o.couponId, 'coupon');
          const ev = evaluateCoupon(ctx, c, o.lineItems);
          if (!ev.valid) fail('VALIDATION', `coupon ${c.code} is no longer valid (${ev.reasons.join('; ')}); apply another or recreate the order without it`);
          ctx.patch(c, { redemptionCount: c.redemptionCount + 1 });
        }
        return ctx.patch(o, { status: 'submitted', submittedAt: ctx.now });
      },
      example: (ctx) => ({ id: byNum(ctx, 'ORD-1006').id }),
    },
    {
      id: 'cancel_order', name: 'Cancel order',
      description: 'Cancel a draft or submitted order, releasing reserved stock and the coupon redemption. Fulfilled orders cannot be cancelled (refund the payment instead).',
      keywords: ['void order', 'delete order'],
      risk: 'destructive',
      input: z.object({ id: id('order'), reason: z.string().optional() }),
      output: order,
      handler: ({ id: oid, reason }, ctx) => {
        const o = ctx.get('orders', oid, 'order');
        if (o.status === 'fulfilled') fail('INVALID_STATE', `order ${o.id} is already fulfilled; use refunds.create_refund_request for the payment instead`);
        if (o.status === 'cancelled') fail('INVALID_STATE', `order ${o.id} is already cancelled`);
        const released = o.status === 'submitted' ? o.lineItems.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: l.quantity })) : [];
        if (o.status === 'submitted' && o.couponId) {
          const c = ctx.find('coupons', o.couponId);
          if (c && c.redemptionCount > 0) ctx.patch(c, { redemptionCount: c.redemptionCount - 1 });
        }
        ctx.patch(o, { status: 'cancelled', cancelledAt: ctx.now, cancelReason: reason ?? null });
        return { ...o, releasedReservations: released };
      },
      example: (ctx) => ({ id: byNum(ctx, 'ORD-1003').id, reason: 'Customer requested cancellation' }),
    },
    {
      id: 'fulfill_order', name: 'Mark order fulfilled',
      description: 'Mark a submitted order as shipped/delivered: converts its reservation into a stock decrement for tracked items.',
      keywords: ['ship order', 'complete order', 'deliver'],
      risk: 'write',
      input: z.object({ id: id('order'), trackingNumber: z.string().optional() }),
      output: order,
      handler: ({ id: oid, trackingNumber }, ctx) => {
        const o = ctx.get('orders', oid, 'order');
        if (o.status !== 'submitted') fail('INVALID_STATE', `order ${o.id} is '${o.status}'; only submitted orders can be fulfilled`);
        // resolve every line first so a missing product/variant fails before any stock moves
        const targets = o.lineItems.map((l) => {
          const p = ctx.get('products', l.productId, 'product');
          return [l, p, l.variantId ? findVariant(p, l.variantId) : p];
        });
        for (const [l, p, t] of targets) {
          if (t.inventory.tracked) t.inventory.quantity = Math.max(0, t.inventory.quantity - l.quantity);
          syncStock(p);
          ctx.patch(p, {});
        }
        return ctx.patch(o, { status: 'fulfilled', fulfilledAt: ctx.now, trackingNumber: trackingNumber ?? null });
      },
      example: (ctx) => ({ id: byNum(ctx, 'ORD-1004').id, trackingNumber: '1Z999AA10123456784' }),
    },
  ],

  seed(ctx, h) {
    const prods = ctx.all('products');
    if (!prods.length) return;
    const P = (sku) => prods.find((p) => p.sku === sku);
    const V = (sku, vsku) => P(sku).variants.find((v) => v.sku === vsku).id;
    const contacts = ctx.all('contacts');
    const con = (i) => contacts[i]?.id ?? `con_${String(i + 1).padStart(3, '0')}`;
    const addr = (name, city, state, postalCode, country = 'US') => ({ name, line1: `${h.int(10, 999)} Main St`, city, state, postalCode, country });
    const rows = [
      [0, 'fulfilled', [['WHT-KIT', null, 1], ['MUG-11OZ', null, 2]], addr('Sarah Johnson', 'San Diego', 'CA', '92101'), 40],
      [6, 'fulfilled', [['HOOD-LOGO', 'HOOD-BLK', 1]], addr('Customer', 'Brooklyn', 'NY', '11201'), 25],
      [2, 'submitted', [['WHT-KIT', null, 3]], addr('Michael Smith', 'Los Angeles', 'CA', '90012'), 3],
      [9, 'submitted', [['TEE-LOGO', 'TEE-M', 2]], addr('Customer', 'Albany', 'NY', '12207'), 2],
      [11, 'submitted', [['COURSE-MKT', null, 1]], null, 1],
      [1, 'draft', [['TEE-LOGO', 'TEE-S', 2], ['MUG-11OZ', null, 1]], addr('Sarah Chen', 'Oakland', 'CA', '94612'), 1],
      [4, 'draft', [['WHT-KIT', null, 1]], null, 0],
      [13, 'draft', [['TEE-LOGO', 'TEE-M', 2]], addr('Customer', 'Seattle', 'WA', '98101'), 0],
      [14, 'cancelled', [['HOOD-LOGO', 'HOOD-GRY', 2]], addr('Customer', 'London', null, 'SW1A 1AA', 'GB'), 12],
      [15, 'draft', [['COURSE-MKT', null, 1], ['GIFT-CARD', null, 1]], null, 2, 'WELCOME10'],
      [19, 'fulfilled', [['WEB-START', null, 1]], null, 60],
      [0, 'draft', [], null, 0],
    ];
    for (const [ci, status, lines, shippingAddress, ago, code] of rows) {
      const lineItems = lines.map(([sku, vsku, quantity]) => buildOrderLine(ctx, { productId: P(sku).id, variantId: vsku ? V(sku, vsku) : undefined, quantity }));
      const at = h.daysAgo(ago);
      const o = ctx.insert('orders', {
        number: nextNumber(ctx), contactId: con(ci), status, lineItems, shippingAddress, couponId: null, couponCode: null,
        subtotal: 0, discount: 0, total: 0, currency: 'USD', notes: '', createdAt: at,
        submittedAt: status !== 'draft' ? at : null, fulfilledAt: status === 'fulfilled' ? h.daysAgo(Math.max(0, ago - 3)) : null,
        cancelledAt: status === 'cancelled' ? h.daysAgo(ago - 1) : null, ...(status === 'cancelled' ? { cancelReason: 'Customer changed their mind' } : {}),
      });
      const c = code && ctx.all('coupons').find((x) => x.code === code);
      if (c) Object.assign(o, { couponId: c.id, couponCode: c.code });
      recalc(ctx, o);
      o.updatedAt = at;
    }
  },
});
