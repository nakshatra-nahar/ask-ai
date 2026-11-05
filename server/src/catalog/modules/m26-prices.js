import { defineModule, ops, z, id, entity, limit, fail, page, money, round2 } from '../kit.js';
import { productSchema } from './m25-products.js';

const INTERVALS = ['one_time', 'month', 'year'];
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'JPY', 'INR', 'SGD', 'MXN', 'BRL', 'ZAR', 'SEK', 'NOK', 'DKK', 'AED'];
export const priceSchema = entity({
  productId: z.string(), label: z.string(), amount: z.number(), currency: z.string(), interval: z.enum(INTERVALS),
  trialDays: z.number().nullable().optional(), status: z.enum(['active', 'archived']),
});
export const currencyInput = z.string().regex(/^[A-Za-z]{3}$/, 'ISO 4217 3-letter code, e.g. USD').transform((s) => s.toUpperCase()).describe('ISO 4217 code, e.g. USD, EUR, GBP');
const LIVE_SUB = ['trialing', 'active', 'past_due', 'paused'];
const liveSubs = (ctx, priceId) => ctx.all('subscriptions').filter((s) => s.priceId === priceId && LIVE_SUB.includes(s.status));
const intervalLabel = { one_time: 'One-time', month: 'Monthly', year: 'Yearly' };

function supported(c) {
  if (!CURRENCIES.includes(c)) fail('VALIDATION', `currency ${c} is not enabled; supported: ${CURRENCIES.join(', ')}`);
}
function editable(rec) {
  if (rec.status !== 'active') fail('INVALID_STATE', `price ${rec.id} is archived; create a new price instead`);
}
function noLiveSubs(ctx, rec, what) {
  const subs = liveSubs(ctx, rec.id);
  if (subs.length)
    fail('CONFLICT', `cannot change ${what} of price ${rec.id}: ${subs.length} live subscription(s) use it (${subs.slice(0, 5).map((s) => s.id).join(', ')}); create a new price and move them with subscriptions.change_subscription_plan`);
}
const priceOf = (ctx, sku, interval = 'one_time') => {
  const p = ctx.all('products').find((x) => x.sku === sku);
  return ctx.all('prices').find((x) => x.productId === p.id && x.interval === interval && x.status === 'active');
};

export default defineModule({
  id: 'prices',
  code: 'M26',
  name: 'Prices',
  description: 'Define what products cost: amounts, currencies, one-time vs recurring billing, trials and default prices.',
  tables: { prices: { prefix: 'pri', schema: priceSchema } },
  actions: [
    {
      id: 'create_price', name: 'Create product price',
      description: 'Add a price point to a catalog product: amount, currency, and billing interval (one_time, month, year). The first price of a product becomes its default.',
      keywords: ['add price', 'pricing', 'plan', 'monthly price', 'yearly price'],
      risk: 'write',
      input: z.object({
        productId: id('product'), amount: money.describe('price amount in major units, e.g. 49.99'), label: z.string().min(1).optional(),
        currency: currencyInput.default('USD'), interval: z.enum(INTERVALS).default('one_time'),
        trialDays: z.number().int().min(0).max(365).optional().describe('free trial days; recurring prices only'),
      }),
      output: priceSchema,
      handler: (i, ctx) => {
        const p = ctx.get('products', i.productId, 'product');
        if (p.status !== 'active') fail('INVALID_STATE', `product ${p.id} (${p.name}) is archived; prices can only be added to active products`);
        supported(i.currency);
        if (i.trialDays && i.interval === 'one_time') fail('VALIDATION', 'trialDays only applies to recurring prices (interval month or year)');
        const rec = ctx.insert('prices', {
          productId: p.id, label: i.label ?? `${p.name} — ${intervalLabel[i.interval]}`, amount: round2(i.amount), currency: i.currency,
          interval: i.interval, trialDays: i.interval === 'one_time' ? null : i.trialDays ?? 0, status: 'active',
        });
        if (!p.defaultPriceId) ctx.patch(p, { defaultPriceId: rec.id });
        return rec;
      },
      example: (ctx) => ({ productId: ctx.all('products').find((p) => p.sku === 'CONSULT-60').id, amount: 400, label: '3-session bundle' }),
    },
    {
      id: 'get_price', name: 'Get price details', description: 'Fetch one price by ID (amount, currency, interval, trial days, status).',
      ...ops.get('prices', { what: 'price' }),
      example: (ctx) => ({ id: ctx.all('prices')[0].id }),
    },
    {
      id: 'list_product_prices', name: 'List product prices',
      description: 'List the prices of one product, filterable by status, interval and currency; also returns which price is the default.',
      keywords: ['how much', 'pricing options', 'plans for product'],
      risk: 'read',
      input: z.object({
        productId: id('product'), status: z.enum(['active', 'archived']).optional(), interval: z.enum(INTERVALS).optional(),
        currency: z.string().optional(), limit,
      }),
      output: z.looseObject({ productId: z.string(), defaultPriceId: z.string().nullable(), total: z.number(), items: z.array(priceSchema) }),
      handler: ({ productId, status, interval, currency, limit: lim }, ctx) => {
        const p = ctx.get('products', productId, 'product');
        const rows = ctx.all('prices').filter((r) => r.productId === p.id && (!status || r.status === status) && (!interval || r.interval === interval) && (!currency || r.currency === currency.toUpperCase()));
        return { productId: p.id, productName: p.name, defaultPriceId: p.defaultPriceId ?? null, ...page(rows, lim) };
      },
      example: (ctx) => ({ productId: ctx.all('products').find((p) => p.sku === 'SEO-RET').id }),
    },
    {
      id: 'update_price_label', name: 'Update price label', description: 'Rename the customer-facing label of a price (e.g. "Pro — Monthly").',
      ...ops.set('prices', 'label', z.string().min(1).max(80), { what: 'price' }),
      example: (ctx) => ({ id: ctx.all('prices')[0].id, label: 'Starter Website — Launch Special' }),
    },
    {
      id: 'set_price_amount', name: 'Set price amount',
      description: 'Change the amount of an active price. Existing subscriptions on a recurring price are billed the new amount from their next invoice.',
      keywords: ['change price', 'raise price', 'discount price'],
      ...ops.set('prices', 'amount', money.describe('new amount in major units'), { what: 'price', guard: editable, map: round2 }),
      example: (ctx) => ({ id: priceOf(ctx, 'WHT-KIT').id, amount: 129 }),
    },
    {
      id: 'set_price_currency', name: 'Set price currency',
      description: 'Change the ISO 4217 currency of an active price. Blocked when live subscriptions use the price.',
      ...ops.set('prices', 'currency', currencyInput, {
        what: 'price',
        guard: (rec, i, ctx) => {
          editable(rec);
          supported(i.currency);
          noLiveSubs(ctx, rec, 'currency');
        },
      }),
      example: (ctx) => ({ id: priceOf(ctx, 'COURSE-MKT').id, currency: 'EUR' }),
    },
    {
      id: 'set_billing_interval', name: 'Set billing interval',
      description: 'Switch a price between one_time, month and year billing. Switching to one_time clears the trial. Blocked when live subscriptions use the price.',
      keywords: ['recurring', 'monthly', 'annual', 'one-time'],
      risk: 'write',
      input: z.object({ id: id('price'), interval: z.enum(INTERVALS) }),
      output: priceSchema,
      handler: ({ id: pid, interval }, ctx) => {
        const rec = ctx.get('prices', pid, 'price');
        editable(rec);
        if (rec.interval === interval) fail('VALIDATION', `price ${pid} is already billed '${interval}'`);
        noLiveSubs(ctx, rec, 'billing interval');
        return ctx.patch(rec, { interval, trialDays: interval === 'one_time' ? null : rec.trialDays ?? 0 });
      },
      example: (ctx) => ({ id: priceOf(ctx, 'CONSULT-60').id, interval: 'month' }),
    },
    {
      id: 'set_trial_period', name: 'Set trial period',
      description: 'Set the free-trial length (days) new subscriptions get on a recurring price. 0 removes the trial. Does not change existing subscriptions (use subscriptions.set_subscription_trial_end).',
      keywords: ['free trial', 'trial days'],
      ...ops.set('prices', 'trialDays', z.number().int().min(0).max(365).describe('trial length in days'), {
        what: 'price',
        guard: (rec) => {
          editable(rec);
          if (rec.interval === 'one_time') fail('INVALID_STATE', `price ${rec.id} is one_time; trials only apply to recurring (month/year) prices`);
        },
      }),
      example: (ctx) => ({ id: priceOf(ctx, 'SEO-RET', 'month').id, trialDays: 7 }),
    },
    {
      id: 'set_default_price', name: 'Set default product price',
      description: 'Choose which active price is the product default (used when a product is added to orders or quotes without an explicit price).',
      keywords: ['primary price', 'main price'],
      risk: 'write',
      input: z.object({ productId: id('product'), priceId: id('price') }),
      output: productSchema,
      handler: ({ productId, priceId }, ctx) => {
        const p = ctx.get('products', productId, 'product');
        const pr = ctx.get('prices', priceId, 'price');
        if (pr.productId !== p.id) fail('VALIDATION', `price ${priceId} belongs to product ${pr.productId}, not ${p.id}`);
        editable(pr);
        if (p.defaultPriceId === priceId) fail('VALIDATION', `price ${priceId} is already the default of ${p.id}`);
        return ctx.patch(p, { defaultPriceId: priceId });
      },
      example: (ctx) => {
        const p = ctx.all('products').find((x) => x.sku === 'SEO-RET');
        return { productId: p.id, priceId: priceOf(ctx, 'SEO-RET', 'year').id };
      },
    },
    {
      id: 'archive_price', name: 'Archive price',
      description: 'Archive a price so it can no longer be used for new orders, quotes or subscriptions (existing subscriptions keep billing). If it is the product default, another active price is promoted; archiving the only active price is blocked.',
      keywords: ['delete price', 'retire price', 'remove price'],
      risk: 'destructive',
      input: z.object({ id: id('price') }),
      output: z.looseObject({ ...priceSchema.shape, newDefaultPriceId: z.string().nullable().optional() }),
      handler: ({ id: pid }, ctx) => {
        const rec = ctx.get('prices', pid, 'price');
        if (rec.status === 'archived') fail('INVALID_STATE', `price ${pid} is already archived`);
        const p = ctx.find('products', rec.productId);
        let newDefaultPriceId;
        if (p?.defaultPriceId === pid) {
          const others = ctx.all('prices').filter((x) => x.productId === p.id && x.id !== pid && x.status === 'active');
          if (!others.length)
            fail('CONFLICT', `price ${pid} is the only active price of ${p.id} (${p.name}); create another price first, or archive the product instead`);
          const next = others.find((x) => x.interval === rec.interval && x.currency === rec.currency) || others[0];
          ctx.patch(p, { defaultPriceId: next.id });
          newDefaultPriceId = next.id;
        }
        ctx.patch(rec, { status: 'archived' });
        return { ...rec, newDefaultPriceId: newDefaultPriceId ?? null, liveSubscriptions: liveSubs(ctx, pid).length };
      },
      example: (ctx) => ({ id: priceOf(ctx, 'GIFT-CARD').id }),
    },
  ],

  seed(ctx) {
    const plan = {
      'WEB-START': [['Starter Website — One-time', 1499]],
      'SEO-RET': [['SEO Retainer — Monthly', 799, 'month'], ['SEO Retainer — Yearly (2 months free)', 7990, 'year'], ['SEO Retainer — Monthly (EUR)', 749, 'month', 'EUR'], ['SEO Retainer — Monthly (2025 rate)', 699, 'month', 'USD', 0, 'archived']],
      'SMM-STD': [['Social Media — Monthly', 499, 'month', 'USD', 14], ['Social Media — Yearly', 4990, 'year', 'USD', 14]],
      'HOST-CARE': [['Hosting & Care — Monthly', 49, 'month', 'USD', 30], ['Hosting & Care — Yearly', 490, 'year']],
      'WHT-KIT': [['Whitening Kit', 149]],
      'GIFT-CARD': [['$50 Gift Card', 50], ['$100 Gift Card', 100]],
      'TEE-LOGO': [['Logo T-Shirt', 25]],
      'HOOD-LOGO': [['Branded Hoodie', 55]],
      'MUG-11OZ': [['Coffee Mug', 15]],
      'COURSE-MKT': [['Masterclass — Lifetime access', 199]],
      'CONSULT-60': [['Consultation — Single session', 150]],
      'PRINT-AD': [['Print Ad Design', 300]],
    };
    for (const p of ctx.all('products')) {
      for (const [label, amount, interval = 'one_time', currency = 'USD', trialDays = 0, status = 'active'] of plan[p.sku] || [[p.name, 100]]) {
        const r = ctx.insert('prices', { productId: p.id, label, amount, currency, interval, trialDays: interval === 'one_time' ? null : trialDays, status });
        if (!p.defaultPriceId && status === 'active') p.defaultPriceId = r.id;
      }
    }
  },
});
