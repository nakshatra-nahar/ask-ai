import { defineModule, ops, z, id, entity, isoDate, fail, toTime, round2 } from '../kit.js';
import { productSchema, TAX_CATEGORIES } from './m25-products.js';

const rule = entity({
  name: z.string(), country: z.string(), state: z.string().nullable().optional(), rate: z.number(), taxCategory: z.enum(TAX_CATEGORIES).nullable().optional(),
  inclusive: z.boolean(), status: z.enum(['active', 'inactive']),
});
const exemption = entity({
  contactId: z.string(), certificateNumber: z.string(), country: z.string(), state: z.string().nullable().optional(),
  status: z.enum(['active', 'revoked']), expiresAt: z.string().nullable().optional(),
});
const country = z.string().length(2).transform((s) => (s.toUpperCase() === 'UK' ? 'GB' : s.toUpperCase())).describe('ISO 3166 2-letter country, e.g. US, GB');
const state = z.string().min(1).max(3).transform((s) => s.toUpperCase()).describe('state/province code, e.g. CA, NY');
const region = z.object({ country, state: state.optional() });
const rate = z.number().min(0).max(100).describe('percent, e.g. 7.25');
const regionLabel = (r) => (r.state ? `${r.country}-${r.state}` : r.country);

function assertNoClash(ctx, r, self) {
  const clash = ctx.all('tax_rules').find((x) => x !== self && x.status === 'active' && x.country === r.country && (x.state ?? null) === (r.state ?? null) && (x.taxCategory ?? null) === (r.taxCategory ?? null));
  if (clash) fail('DUPLICATE', `active rule ${clash.id} (${clash.name}) already covers ${regionLabel(r)} / ${r.taxCategory ?? 'all categories'}; change its rate or deactivate it first`, { existingId: clash.id });
}
/** Most specific active rule wins: category-specific beats all-category, state beats country-wide. */
function pickRule(rules, reg, category) {
  return rules
    .filter((r) => r.status === 'active' && r.country === reg.country && (!r.state || r.state === reg.state) && (!r.taxCategory || r.taxCategory === category))
    .sort((a, b) => !!b.taxCategory - !!a.taxCategory || !!b.state - !!a.state)[0] ?? null;
}
const activeExemption = (ctx, contactId, reg) =>
  contactId && ctx.all('tax_exemptions').find((e) => e.contactId === contactId && e.status === 'active' && e.country === reg.country && (!e.state || e.state === reg.state) && (!e.expiresAt || toTime(e.expiresAt, true) >= toTime(ctx.now)));
const byName = (ctx, n) => ctx.all('tax_rules').find((r) => r.name === n);

export default defineModule({
  id: 'tax_rules',
  code: 'M34',
  name: 'Tax Rules',
  description: 'Configure sales tax/VAT by region and product category, customer exemptions, and calculate tax for orders.',
  tables: { tax_rules: { prefix: 'tax', schema: rule }, tax_exemptions: { prefix: 'txe', schema: exemption } },
  actions: [
    {
      id: 'create_tax_rule', name: 'Create tax rule',
      description: 'Define a sales tax/VAT rate for a region (country, optional state), optionally only for one product tax category, as tax-exclusive or tax-inclusive pricing.',
      keywords: ['sales tax', 'vat', 'gst', 'new tax rate'],
      ...ops.create('tax_rules', {
        input: z.object({
          name: z.string().min(1), country, state: state.optional(), rate, taxCategory: z.enum(TAX_CATEGORIES).optional().describe('omit = applies to all categories'),
          inclusive: z.boolean().default(false).describe('true when prices already include this tax (e.g. UK VAT)'),
        }),
        check: (i, ctx) => assertNoClash(ctx, i, null),
        build: (i) => ({ state: i.state ?? null, taxCategory: i.taxCategory ?? null, status: 'active' }),
      }),
      example: () => ({ name: 'Washington sales tax', country: 'US', state: 'WA', rate: 6.5 }),
    },
    {
      id: 'get_tax_rule', name: 'Get tax rule', description: 'Fetch one tax rule by ID (region, rate, category, inclusive flag, status).',
      ...ops.get('tax_rules', { what: 'tax rule' }),
      example: (ctx) => ({ id: ctx.all('tax_rules')[0].id }),
    },
    {
      id: 'list_tax_rules', name: 'List tax rules', description: 'List tax rules filtered by country, state, product tax category, inclusive flag or status.',
      keywords: ['tax rates', 'vat rates'],
      ...ops.search('tax_rules', {
        text: ['name'],
        filters: {
          country: z.string().optional(), state: z.string().optional(), taxCategory: z.enum(TAX_CATEGORIES).optional(),
          inclusive: z.boolean().optional(), status: z.enum(['active', 'inactive']).optional(),
        },
      }),
      example: () => ({ country: 'US' }),
    },
    {
      id: 'set_tax_rate', name: 'Set tax rate', description: 'Change the percentage rate (0-100) of an active tax rule.',
      ...ops.set('tax_rules', 'rate', rate, { what: 'tax rule', guard: (r) => r.status !== 'active' && fail('INVALID_STATE', `tax rule ${r.id} is inactive`) }),
      example: (ctx) => ({ id: byName(ctx, 'New York sales tax').id, rate: 9 }),
    },
    {
      id: 'set_tax_region', name: 'Set applicable region', description: 'Change the region (country and optional state) an active tax rule applies to.',
      keywords: ['jurisdiction', 'tax region'],
      risk: 'write',
      input: z.object({ id: id('tax rule'), country, state: state.nullable().optional().describe('omit/null = whole country') }),
      output: rule,
      handler: ({ id: rid, country: c, state: s }, ctx) => {
        const r = ctx.get('tax_rules', rid, 'tax rule');
        if (r.status !== 'active') fail('INVALID_STATE', `tax rule ${rid} is inactive`);
        const next = { country: c, state: s ?? null };
        assertNoClash(ctx, { ...r, ...next }, r);
        return ctx.patch(r, next);
      },
      example: (ctx) => ({ id: byName(ctx, 'New York sales tax').id, country: 'US', state: 'NJ' }),
    },
    {
      id: 'set_product_tax_category', name: 'Set product tax category',
      description: 'Assign a tax category (general, digital, services, food, exempt) to a catalog product; tax rules for that category then apply to it. Exempt products are never taxed.',
      keywords: ['tax class', 'tax code', 'taxable', 'non-taxable'],
      risk: 'write',
      input: z.object({ productId: id('product'), taxCategory: z.enum(TAX_CATEGORIES) }),
      output: productSchema,
      handler: ({ productId, taxCategory }, ctx) => {
        const p = ctx.get('products', productId, 'product');
        if (p.taxCategory === taxCategory) fail('VALIDATION', `product ${p.id} is already in tax category '${taxCategory}'`);
        return ctx.patch(p, { taxCategory });
      },
      example: (ctx) => ({ productId: ctx.all('products').find((p) => p.sku === 'MUG-11OZ').id, taxCategory: 'exempt' }),
    },
    {
      id: 'set_tax_inclusive', name: 'Set tax-inclusive pricing',
      description: 'Switch a tax rule between tax-inclusive (prices already contain the tax, it is extracted) and tax-exclusive (tax is added on top).',
      keywords: ['vat included', 'prices include tax'],
      ...ops.set('tax_rules', 'inclusive', z.boolean(), { what: 'tax rule', guard: (r) => r.status !== 'active' && fail('INVALID_STATE', `tax rule ${r.id} is inactive`) }),
      example: (ctx) => ({ id: byName(ctx, 'California sales tax').id, inclusive: true }),
    },
    {
      id: 'record_tax_exemption', name: 'Record customer tax exemption',
      description: 'Record a tax-exemption certificate for a contact in a region (e.g. reseller or non-profit); their tax in that region calculates as 0.',
      keywords: ['tax exempt', 'resale certificate', 'non-profit'],
      risk: 'write',
      input: z.object({
        contactId: id('contact'), certificateNumber: z.string().min(3), country, state: state.optional(),
        expiresAt: isoDate('certificate expiry date').optional(), reason: z.string().optional(),
      }),
      output: exemption,
      handler: (i, ctx) => {
        const c = ctx.get('contacts', i.contactId, 'contact');
        if (c.status !== 'active') fail('INVALID_STATE', `contact ${c.id} is ${c.status}`);
        if (i.expiresAt && toTime(i.expiresAt, true) < toTime(ctx.now)) fail('VALIDATION', `certificate already expired on ${i.expiresAt}`);
        const dupCert = ctx.all('tax_exemptions').find((e) => e.certificateNumber.toLowerCase() === i.certificateNumber.toLowerCase() && e.status === 'active');
        if (dupCert) fail('DUPLICATE', `certificate ${i.certificateNumber} is already recorded (${dupCert.id} for ${dupCert.contactId})`, { existingId: dupCert.id });
        const reg = { country: i.country, state: i.state ?? null };
        // same contact + exact region, still in force (activeExemption would return a country-wide row first and hide a same-state duplicate)
        const existing = ctx.all('tax_exemptions').find((e) => e.contactId === c.id && e.status === 'active' && e.country === reg.country && (e.state ?? null) === reg.state && (!e.expiresAt || toTime(e.expiresAt, true) >= toTime(ctx.now)));
        if (existing) fail('DUPLICATE', `contact ${c.id} already has active exemption ${existing.id} for ${regionLabel(reg)}`, { existingId: existing.id });
        return ctx.insert('tax_exemptions', { contactId: c.id, certificateNumber: i.certificateNumber, ...reg, status: 'active', expiresAt: i.expiresAt ?? null, reason: i.reason ?? null });
      },
      example: () => ({ contactId: 'con_002', certificateNumber: 'NY-ST120-88231', country: 'US', state: 'NY', reason: 'Reseller' }),
    },
    {
      id: 'calculate_tax', name: 'Calculate tax for order',
      description: 'Compute tax for an order (orderId; region from its shipping address) or for ad-hoc lines + region. Applies the most specific active rule per line by region and product tax category; exempt contacts/products get 0; handles inclusive vs exclusive pricing. Read-only.',
      keywords: ['how much tax', 'sales tax estimate', 'vat calculation'],
      risk: 'read',
      input: z.object({
        orderId: z.string().optional(),
        lineItems: z.array(z.object({ productId: id('product'), amount: z.number().nonnegative().describe('line amount') })).optional(),
        region: region.optional().describe('required without orderId; overrides the order shipping address'), contactId: z.string().optional(),
      }).refine((i) => i.orderId || (i.lineItems?.length && i.region), 'provide orderId, or lineItems + region'),
      output: z.looseObject({ region: z.looseObject({}), exempt: z.boolean(), lines: z.array(z.looseObject({})), totalTax: z.number(), totalNet: z.number(), totalGross: z.number() }),
      handler: (i, ctx) => {
        let lines = i.lineItems, reg = i.region, contactId = i.contactId;
        if (contactId) ctx.get('contacts', contactId, 'contact');
        if (i.orderId) {
          const o = ctx.get('orders', i.orderId, 'order');
          if (!o.lineItems.length) fail('VALIDATION', `order ${o.id} has no line items`);
          const share = o.subtotal ? (o.discount || 0) / o.subtotal : 0; // spread order discount proportionally
          lines = o.lineItems.map((l) => ({ productId: l.productId, amount: round2(l.amount * (1 - share)), lineItemId: l.id }));
          reg ??= o.shippingAddress?.country ? { country: o.shippingAddress.country.toUpperCase(), state: o.shippingAddress.state?.toUpperCase() } : null;
          if (!reg) fail('VALIDATION', `order ${o.id} has no shipping address; pass region`);
          contactId ??= o.contactId;
        }
        const ex = activeExemption(ctx, contactId, reg);
        const rules = ctx.all('tax_rules');
        const out = lines.map((l) => {
          const p = ctx.get('products', l.productId, 'product');
          const r = ex || p.taxCategory === 'exempt' ? null : pickRule(rules, reg, p.taxCategory);
          const pct = r?.rate ?? 0;
          const tax = !r ? 0 : r.inclusive ? round2(l.amount - l.amount / (1 + pct / 100)) : round2((l.amount * pct) / 100);
          const net = r?.inclusive ? round2(l.amount - tax) : l.amount;
          return {
            ...(l.lineItemId ? { lineItemId: l.lineItemId } : {}), productId: p.id, name: p.name, taxCategory: p.taxCategory, amount: l.amount,
            ruleId: r?.id ?? null, ruleName: r?.name ?? null, rate: pct, inclusive: r?.inclusive ?? false, tax, net, gross: round2(net + tax),
            note: ex ? `contact exempt (${ex.id})` : p.taxCategory === 'exempt' ? 'product is tax-exempt' : r ? undefined : `no active rule for ${regionLabel(reg)}`,
          };
        });
        const sum = (k) => round2(out.reduce((s, l) => s + l[k], 0));
        return {
          ...(i.orderId ? { orderId: i.orderId } : {}), region: reg, contactId: contactId ?? null, exempt: !!ex, exemptionId: ex?.id ?? null,
          lines: out, totalTax: sum('tax'), totalNet: sum('net'), totalGross: sum('gross'),
        };
      },
      example: (ctx) => {
        const P = (s) => ctx.all('products').find((p) => p.sku === s).id;
        return { lineItems: [{ productId: P('WHT-KIT'), amount: 149 }, { productId: P('COURSE-MKT'), amount: 199 }], region: { country: 'US', state: 'CA' } };
      },
    },
    {
      id: 'deactivate_tax_rule', name: 'Deactivate tax rule', description: 'Stop applying a tax rule to new calculations (kept for history).',
      keywords: ['disable tax', 'remove tax rate'],
      ...ops.transition('tax_rules', { to: 'inactive', from: ['active'], risk: 'destructive', what: 'tax rule' }),
      example: (ctx) => ({ id: byName(ctx, 'New York sales tax').id }),
    },
  ],

  seed(ctx, h) {
    const rules = [
      { name: 'California sales tax', country: 'US', state: 'CA', rate: 7.25 },
      { name: 'California digital goods', country: 'US', state: 'CA', rate: 0, taxCategory: 'digital' },
      { name: 'New York sales tax', country: 'US', state: 'NY', rate: 8.875 },
      { name: 'New York services', country: 'US', state: 'NY', rate: 4, taxCategory: 'services' },
      { name: 'UK VAT standard', country: 'GB', rate: 20, inclusive: true },
      { name: 'UK VAT reduced (food)', country: 'GB', rate: 5, inclusive: true, taxCategory: 'food' },
      { name: 'Texas sales tax (old)', country: 'US', state: 'TX', rate: 6.25, status: 'inactive' },
    ];
    for (const r of rules) ctx.insert('tax_rules', { state: null, taxCategory: null, inclusive: false, status: 'active', ...r, createdAt: h.daysAgo(200) });
    const contacts = ctx.all('contacts');
    const con = (i) => contacts[i]?.id ?? `con_${String(i + 1).padStart(3, '0')}`;
    ctx.insert('tax_exemptions', { contactId: con(9), certificateNumber: 'CA-RESALE-55821', country: 'US', state: 'CA', status: 'active', expiresAt: '2027-06-30', reason: 'Reseller', createdAt: h.daysAgo(90) });
    ctx.insert('tax_exemptions', { contactId: con(11), certificateNumber: 'NY-ST119-10442', country: 'US', state: 'NY', status: 'active', expiresAt: '2026-09-30', reason: 'Non-profit (expired)', createdAt: h.daysAgo(400) });
  },
});
