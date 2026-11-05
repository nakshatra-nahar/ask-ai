import { defineModule, ops, z, id, entity, fail } from '../kit.js';

const TYPES = ['physical', 'digital', 'service'];
export const TAX_CATEGORIES = ['general', 'digital', 'services', 'food', 'exempt'];
const inventory = z.object({ quantity: z.number(), tracked: z.boolean() });
const variant = z.looseObject({
  id: z.string(), name: z.string(), sku: z.string().nullable().optional(), options: z.record(z.string(), z.string()).optional(),
  price: z.number().nullable().optional(), inventory, status: z.enum(['active', 'archived']),
});
export const productSchema = entity({
  name: z.string(), description: z.string().optional(), type: z.enum(TYPES), sku: z.string().nullable().optional(),
  status: z.enum(['active', 'archived']), variants: z.array(variant), inventory, defaultPriceId: z.string().nullable().optional(),
  taxCategory: z.enum(TAX_CATEGORIES),
});
const stockRowSchema = z.looseObject({
  productId: z.string(), variantId: z.string().nullable(), name: z.string(), tracked: z.boolean(),
  onHand: z.number(), reserved: z.number(), available: z.number().nullable(), reservedByOrderIds: z.array(z.string()),
});
const skuSchema = z.string().min(2).max(40).regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, dot, dash, underscore only');

/** Units of a product/variant held by submitted (not yet fulfilled) orders. */
export function reservedQty(ctx, productId, variantId = null, excludeOrderId = null) {
  let reserved = 0;
  const orderIds = new Set();
  for (const o of ctx.all('orders')) {
    if (o.status !== 'submitted' || o.id === excludeOrderId) continue;
    for (const l of o.lineItems || [])
      if (l.productId === productId && (l.variantId || null) === (variantId || null)) (reserved += l.quantity), orderIds.add(o.id);
  }
  return { reserved, orderIds: [...orderIds] };
}
export function stockRow(ctx, p, v = null, excludeOrderId = null) {
  const inv = (v || p).inventory;
  const { reserved, orderIds } = reservedQty(ctx, p.id, v?.id, excludeOrderId);
  return {
    productId: p.id, variantId: v?.id ?? null, name: v ? `${p.name} — ${v.name}` : p.name, sku: (v || p).sku ?? null,
    tracked: inv.tracked, onHand: inv.quantity, reserved, available: inv.tracked ? inv.quantity - reserved : null, reservedByOrderIds: orderIds,
  };
}
/** Products with variants carry stock per variant; the product-level figure is their sum. */
export function syncStock(p) {
  if (p.variants?.length)
    p.inventory = { quantity: p.variants.reduce((s, v) => s + v.inventory.quantity, 0), tracked: p.variants.some((v) => v.inventory.tracked) };
}
export function findVariant(p, variantId) {
  const v = (p.variants || []).find((x) => x.id === variantId);
  if (!v) fail('NOT_FOUND', `variant ${variantId} not found on product ${p.id}; variants: ${p.variants.map((x) => `${x.id} (${x.name})`).join(', ') || 'none'}`);
  return v;
}
function assertSkuFree(ctx, sku, self) {
  const s = sku.toLowerCase();
  for (const p of ctx.all('products'))
    for (const o of [p, ...(p.variants || [])])
      if (o !== self && o.sku?.toLowerCase() === s)
        fail('DUPLICATE', `SKU ${sku} is already used by ${o === p ? `product ${p.id} (${p.name})` : `variant ${o.id} (${p.name} — ${o.name})`}; choose another SKU`, { existingId: o.id });
}
function activeProduct(ctx, pid) {
  const p = ctx.get('products', pid, 'product');
  if (p.status !== 'active') fail('INVALID_STATE', `product ${pid} (${p.name}) is archived; archived products cannot be changed or sold`);
  return p;
}
const bySku = (ctx, sku) => ctx.all('products').find((p) => p.sku === sku);

export default defineModule({
  id: 'products',
  code: 'M25',
  name: 'Products',
  description: 'Manage the catalog of products and services, their variants, SKUs and inventory.',
  tables: { products: { prefix: 'prd', schema: productSchema } },
  actions: [
    {
      id: 'create_product', name: 'Create product',
      description: 'Add a product or service to the catalog (physical, digital, or service). Prices are added separately with prices.create_price.',
      keywords: ['new product', 'add item', 'add service', 'catalog item'],
      ...ops.create('products', {
        input: z.object({
          name: z.string().min(1), description: z.string().optional(), type: z.enum(TYPES).default('service'),
          sku: skuSchema.optional(), taxCategory: z.enum(TAX_CATEGORIES).default('general'),
          trackInventory: z.boolean().optional().describe('default: true for physical products'),
          quantity: z.number().int().min(0).optional().describe('initial stock on hand'),
        }),
        check: (i, ctx) => {
          if (i.sku) assertSkuFree(ctx, i.sku, null);
          const dup = ctx.all('products').find((p) => p.status === 'active' && p.name.toLowerCase() === i.name.toLowerCase());
          if (dup) fail('DUPLICATE', `an active product named '${i.name}' already exists (${dup.id})`, { existingId: dup.id });
        },
        build: (i) => ({
          description: i.description ?? '', sku: i.sku ?? null, status: 'active', variants: [], defaultPriceId: null,
          inventory: { quantity: i.quantity ?? 0, tracked: i.trackInventory ?? (i.type === 'physical' || i.quantity != null) },
          trackInventory: undefined, quantity: undefined,
        }),
      }),
      example: () => ({ name: 'Holiday Gift Basket', type: 'physical', sku: 'GIFT-BASKET', quantity: 20 }),
    },
    {
      id: 'get_product', name: 'Get product details', description: 'Fetch one catalog product by ID, including variants, SKU, inventory and default price ID.',
      ...ops.get('products', { what: 'product' }),
      example: (ctx) => ({ id: ctx.all('products')[0].id }),
    },
    {
      id: 'search_products', name: 'Search products',
      description: 'Find catalog products by name/description/SKU text, type, or tax category. Archived products excluded unless status is given.',
      keywords: ['find product', 'list products', 'catalog', 'services list'],
      ...ops.search('products', {
        text: ['name', 'description', 'sku'],
        filters: { status: z.enum(['active', 'archived']).optional(), type: z.enum(TYPES).optional(), taxCategory: z.enum(TAX_CATEGORIES).optional() },
        where: (r, i) => i.status || r.status === 'active',
      }),
      example: () => ({ query: 'shirt' }),
    },
    {
      id: 'update_product', name: 'Update product details',
      description: 'Change a product name, description, or type. SKU, variants, inventory, prices and tax category have their own actions.',
      ...ops.update('products', {
        what: 'product',
        fields: { name: z.string().min(1), description: z.string(), type: z.enum(TYPES) },
        guard: (rec) => rec.status !== 'active' && fail('INVALID_STATE', `product ${rec.id} is archived; archived products cannot be edited`),
      }),
      example: (ctx) => ({ id: bySku(ctx, 'CONSULT-60').id, description: '60-minute strategy call with a senior consultant, recording included.' }),
    },
    {
      id: 'archive_product', name: 'Archive product',
      description: 'Archive (retire) a catalog product so it can no longer be added to orders, quotes or subscriptions. Blocked while submitted orders still reserve it.',
      keywords: ['delete product', 'discontinue', 'remove product'],
      ...ops.transition('products', {
        to: 'archived', from: ['active'], risk: 'destructive', what: 'product',
        guard: (rec, i, ctx) => {
          const open = ctx.all('orders').filter((o) => o.status === 'submitted' && o.lineItems?.some((l) => l.productId === rec.id));
          if (open.length) fail('CONFLICT', `product ${rec.id} is reserved by submitted orders ${open.map((o) => o.id).join(', ')}; fulfil or cancel them first`);
        },
      }),
      example: (ctx) => ({ id: bySku(ctx, 'CONSULT-60').id }),
    },
    {
      id: 'add_product_variant', name: 'Add product variant',
      description: 'Add a variant (e.g. size or color) to a product with its own SKU, optional price override, and stock. Once a product has variants, stock is tracked per variant.',
      keywords: ['size', 'color', 'option'],
      risk: 'write',
      input: z.object({
        id: id('product'), name: z.string().min(1).describe('e.g. "XL" or "Navy / Large"'), sku: skuSchema.optional(),
        options: z.record(z.string(), z.string()).optional().describe('e.g. {"size":"XL"}'),
        price: z.number().nonnegative().optional().describe('overrides the product default price for this variant'),
        quantity: z.number().int().min(0).optional().describe('stock on hand for this variant'),
      }),
      output: z.looseObject({ ...productSchema.shape, added: variant }),
      handler: ({ id: pid, name, sku, options, price, quantity }, ctx) => {
        const p = activeProduct(ctx, pid);
        if (p.variants.some((v) => v.name.toLowerCase() === name.toLowerCase())) fail('DUPLICATE', `product ${pid} already has a variant named '${name}'`);
        if (sku) assertSkuFree(ctx, sku, null);
        // The first variant inherits product-level stock so adding variants never silently zeroes inventory.
        const qty = quantity ?? (p.variants.length ? 0 : p.inventory.quantity);
        const added = {
          id: ctx.newId('pvr'), name, sku: sku ?? null, options: options || {}, price: price ?? null,
          inventory: { quantity: qty, tracked: p.inventory.tracked || quantity != null }, status: 'active',
        };
        p.variants.push(added);
        syncStock(p);
        ctx.patch(p, {});
        return { ...p, added };
      },
      example: (ctx) => ({ id: bySku(ctx, 'TEE-LOGO').id, name: 'XXL', sku: 'TEE-XXL', options: { size: 'XXL' }, quantity: 5 }),
    },
    {
      id: 'update_product_variant', name: 'Update product variant',
      description: 'Rename a variant, change its options or price override, or archive/reactivate it. Use set_product_sku for SKUs and set_inventory_quantity for stock.',
      risk: 'write',
      input: z.object({
        id: id('product'), variantId: id('variant'), name: z.string().min(1).optional(), options: z.record(z.string(), z.string()).optional(),
        price: z.number().nonnegative().nullable().optional().describe('null clears the override'), status: z.enum(['active', 'archived']).optional(),
      }),
      output: productSchema,
      handler: ({ id: pid, variantId, ...changes }, ctx) => {
        const p = activeProduct(ctx, pid);
        const v = findVariant(p, variantId);
        if (!Object.keys(changes).length) fail('VALIDATION', 'provide at least one of name, options, price, status');
        if (changes.name && p.variants.some((x) => x !== v && x.name.toLowerCase() === changes.name.toLowerCase()))
          fail('DUPLICATE', `product ${pid} already has a variant named '${changes.name}'`);
        if (changes.status === 'archived') {
          const { orderIds } = reservedQty(ctx, pid, variantId);
          if (orderIds.length) fail('CONFLICT', `variant ${variantId} is reserved by submitted orders ${orderIds.join(', ')}; fulfil or cancel them first`);
        }
        Object.assign(v, changes);
        return ctx.patch(p, {});
      },
      example: (ctx) => {
        const p = bySku(ctx, 'TEE-LOGO');
        return { id: p.id, variantId: p.variants[0].id, price: 22 };
      },
    },
    {
      id: 'set_product_sku', name: 'Set product SKU',
      description: 'Set the SKU of a product or (with variantId) one of its variants. SKUs must be unique across all products and variants.',
      keywords: ['stock keeping unit', 'item code'],
      risk: 'write',
      input: z.object({ id: id('product'), variantId: z.string().optional().describe('set the SKU of this variant instead of the product'), sku: skuSchema }),
      output: productSchema,
      handler: ({ id: pid, variantId, sku }, ctx) => {
        const p = activeProduct(ctx, pid);
        const target = variantId ? findVariant(p, variantId) : p;
        assertSkuFree(ctx, sku, target);
        target.sku = sku;
        return ctx.patch(p, {});
      },
      example: (ctx) => ({ id: bySku(ctx, 'MUG-11OZ').id, sku: 'MUG-CERAMIC-11' }),
    },
    {
      id: 'set_inventory_quantity', name: 'Set inventory quantity',
      description: 'Set on-hand stock for a product, or for a variant (required when the product has variants). Cannot go below units reserved by submitted orders.',
      keywords: ['stock level', 'restock', 'adjust inventory', 'stock count'],
      risk: 'write',
      input: z.object({
        id: id('product'), variantId: z.string().optional(), quantity: z.number().int().min(0).describe('units on hand'),
        tracked: z.boolean().default(true).describe('false stops inventory tracking (unlimited stock)'),
      }),
      output: stockRowSchema,
      handler: ({ id: pid, variantId, quantity, tracked }, ctx) => {
        const p = activeProduct(ctx, pid);
        if (p.variants.length && !variantId)
          fail('VALIDATION', `product ${pid} tracks stock per variant; pass variantId (one of ${p.variants.map((v) => `${v.id} ${v.name}`).join(', ')})`);
        const v = variantId ? findVariant(p, variantId) : null;
        const { reserved, orderIds } = reservedQty(ctx, pid, v?.id);
        if (tracked && quantity < reserved)
          fail('CONFLICT', `${reserved} units are reserved by submitted orders ${orderIds.join(', ')}; set at least ${reserved} or cancel those orders`);
        (v || p).inventory = { quantity, tracked };
        syncStock(p);
        ctx.patch(p, {});
        return stockRow(ctx, p, v);
      },
      example: (ctx) => ({ id: bySku(ctx, 'WHT-KIT').id, quantity: 25 }),
    },
    {
      id: 'get_inventory_availability', name: 'Get inventory availability',
      description: 'Sellable stock for a product or variant: on-hand quantity minus units reserved by submitted-but-unfulfilled orders. Lists every variant when variantId is omitted.',
      keywords: ['in stock', 'stock available', 'how many left', 'reserved stock'],
      risk: 'read',
      input: z.object({ id: id('product'), variantId: z.string().optional() }),
      output: z.looseObject({ productId: z.string(), name: z.string(), items: z.array(stockRowSchema), totalAvailable: z.number().nullable() }),
      handler: ({ id: pid, variantId }, ctx) => {
        const p = ctx.get('products', pid, 'product');
        const items = variantId ? [stockRow(ctx, p, findVariant(p, variantId))] : p.variants.length ? p.variants.map((v) => stockRow(ctx, p, v)) : [stockRow(ctx, p)];
        const tracked = items.filter((r) => r.tracked);
        return { productId: p.id, name: p.name, status: p.status, items, totalAvailable: tracked.length ? tracked.reduce((s, r) => s + r.available, 0) : null };
      },
      example: (ctx) => ({ id: bySku(ctx, 'WHT-KIT').id }),
    },
  ],

  seed(ctx) {
    const v = (name, sku, quantity, price = null) => ({ id: ctx.newId('pvr'), name, sku, options: { size: name }, price, inventory: { quantity, tracked: true }, status: 'active' });
    const rows = [
      { name: 'Starter Website Package', type: 'service', sku: 'WEB-START', taxCategory: 'services', description: '5-page responsive website with contact form and basic SEO setup.' },
      { name: 'Monthly SEO Retainer', type: 'service', sku: 'SEO-RET', taxCategory: 'services', description: 'Ongoing keyword tracking, on-page optimisation and monthly reporting.' },
      { name: 'Social Media Management', type: 'service', sku: 'SMM-STD', taxCategory: 'services', description: '12 posts/month across two networks plus community replies.' },
      { name: 'Website Hosting & Care Plan', type: 'digital', sku: 'HOST-CARE', taxCategory: 'digital', description: 'Managed hosting, backups, SSL and plugin updates.' },
      { name: 'Teeth Whitening Kit', type: 'physical', sku: 'WHT-KIT', taxCategory: 'general', description: 'At-home whitening kit with LED tray and 3 gel syringes.', inventory: { quantity: 5, tracked: true } },
      { name: 'Gift Card', type: 'digital', sku: 'GIFT-CARD', taxCategory: 'exempt', description: 'Store gift card redeemable for any service.' },
      { name: 'Logo T-Shirt', type: 'physical', sku: 'TEE-LOGO', taxCategory: 'general', description: 'Cotton tee with embroidered logo.', variants: [v('S', 'TEE-S', 12), v('M', 'TEE-M', 3), v('L', 'TEE-L', 0), v('XL', 'TEE-XL', 6, 27)] },
      { name: 'Branded Hoodie', type: 'physical', sku: 'HOOD-LOGO', taxCategory: 'general', description: 'Heavyweight pullover hoodie.', variants: [{ ...v('Black', 'HOOD-BLK', 6), options: { color: 'Black' } }, { ...v('Grey', 'HOOD-GRY', 4), options: { color: 'Grey' } }] },
      { name: 'Ceramic Coffee Mug', type: 'physical', sku: 'MUG-11OZ', taxCategory: 'general', description: '11oz glossy mug with logo.', inventory: { quantity: 40, tracked: true } },
      { name: 'Online Marketing Masterclass', type: 'digital', sku: 'COURSE-MKT', taxCategory: 'digital', description: 'Self-paced 6-module video course.' },
      { name: 'Strategy Consultation (60 min)', type: 'service', sku: 'CONSULT-60', taxCategory: 'services', description: 'One-hour strategy call.' },
      { name: 'Print Ad Design (Legacy)', type: 'service', sku: 'PRINT-AD', taxCategory: 'services', description: 'Discontinued print advertisement design service.', status: 'archived' },
    ];
    for (const r of rows) {
      const p = ctx.insert('products', { variants: [], inventory: { quantity: 0, tracked: false }, status: 'active', defaultPriceId: null, ...r });
      syncStock(p);
    }
  },
});
