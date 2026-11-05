import { defineModule, ops, z, id, entity, fail } from '../kit.js';

const TYPES = ['text', 'number', 'date', 'dropdown', 'checkbox'];
const option = z.looseObject({ value: z.string(), retired: z.boolean() });
const field = entity({
  module: z.string(), key: z.string(), label: z.string(), type: z.enum(TYPES), options: z.array(option), helpText: z.string(),
  validation: z.looseObject({ required: z.boolean().optional(), min: z.number().optional(), max: z.number().optional(), pattern: z.string().optional() }),
  status: z.enum(['active', 'archived']),
});

const isActive = (f) => {
  if (f.status !== 'active') fail('INVALID_STATE', `custom field ${f.id} (${f.key}) is archived`);
};
const isDropdown = (f) => {
  isActive(f);
  if (f.type !== 'dropdown') fail('INVALID_STATE', `${f.key} is a ${f.type} field; options only exist on dropdown fields`);
};
const activeOptions = (f) => f.options.filter((o) => !o.retired).map((o) => o.value);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1');

// Validate and normalize a value against the field's type, options and rules.
function coerce(f, value) {
  const { required, min, max, pattern } = f.validation || {};
  const bad = (msg) => fail('VALIDATION', `${f.label} (${f.key}) ${msg}`);
  if (value === null || value === '') {
    if (required) bad('is required and cannot be cleared');
    return null;
  }
  switch (f.type) {
    case 'text':
      if (typeof value !== 'string') bad('expects text');
      if (min != null && value.length < min) bad(`must be at least ${min} characters`);
      if (max != null && value.length > max) bad(`must be at most ${max} characters`);
      if (pattern && !new RegExp(pattern).test(value)) bad(`must match pattern ${pattern}`);
      return value;
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || Number.isNaN(n)) bad('expects a number');
      if (min != null && n < min) bad(`must be >= ${min}`);
      if (max != null && n > max) bad(`must be <= ${max}`);
      return n;
    }
    case 'date': {
      // Date.parse accepts 'March 5' and rolls 2026-02-30 over to March, so require a real YYYY-MM-DD.
      const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
      if (!d || Number.isNaN(Date.parse(value)) || new Date(d).toISOString().slice(0, 10) !== d) bad('expects an ISO date like 2026-11-05');
      return d;
    }
    case 'checkbox':
      if (typeof value !== 'boolean') bad('expects true or false');
      return value;
    case 'dropdown': {
      const o = f.options.find((x) => x.value.toLowerCase() === String(value).toLowerCase());
      if (!o) bad(`must be one of: ${activeOptions(f).join(', ')}`);
      if (o.retired) bad(`option '${o.value}' is retired; choose one of: ${activeOptions(f).join(', ')}`);
      return o.value;
    }
  }
}
const byKey = (ctx, module, key) => ctx.all('custom_fields').find((f) => f.module === module && f.key === key)?.id;

export default defineModule({
  id: 'custom_fields',
  code: 'M10',
  name: 'Custom Fields',
  description: 'Define and set extra data fields on CRM records.',
  tables: { custom_fields: { prefix: 'cf', schema: field } },
  actions: [
    {
      id: 'create_custom_field', name: 'Create custom field',
      description: 'Define a new custom field (text, number, date, dropdown, checkbox) on a record type such as contacts, leads, opportunities or companies.',
      keywords: ['add field', 'new property', 'custom attribute'],
      ...ops.create('custom_fields', {
        input: z.object({
          module: z.string().min(1).describe('table the field belongs to: contacts, leads, opportunities, companies…'),
          label: z.string().min(1), type: z.enum(TYPES),
          key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'snake_case').optional().describe('snake_case key; derived from label if omitted'),
          options: z.array(z.string().min(1)).optional().describe('choices (dropdown only)'), helpText: z.string().optional(), required: z.boolean().optional(),
        }),
        build: (i, ctx) => {
          if (!ctx.db.tables[i.module]) fail('VALIDATION', `unknown module '${i.module}'; use a table name like contacts, leads, opportunities, companies`);
          const key = i.key || slug(i.label);
          if (!key) fail('VALIDATION', `cannot derive a key from label '${i.label}'; pass key (snake_case)`);
          const dup = byKey(ctx, i.module, key);
          if (dup) fail('DUPLICATE', `${i.module} already has a custom field with key '${key}' (${dup}); pass a different key`);
          if (i.type === 'dropdown' && !i.options?.length) fail('VALIDATION', 'dropdown fields need at least one option');
          if (i.type !== 'dropdown' && i.options?.length) fail('VALIDATION', 'options are only allowed on dropdown fields');
          if (new Set((i.options || []).map((o) => o.toLowerCase())).size !== (i.options || []).length) fail('VALIDATION', 'dropdown options must be unique');
          return {
            key, options: (i.options || []).map((value) => ({ value, retired: false })), helpText: i.helpText ?? '',
            validation: { required: !!i.required }, required: undefined, status: 'active',
          };
        },
      }),
      example: () => ({ module: 'contacts', label: 'Shirt Size', type: 'dropdown', options: ['S', 'M', 'L', 'XL'] }),
    },
    {
      id: 'get_custom_field', name: 'Get field definition', description: 'Fetch one custom field definition: key, type, options (incl. retired), help text, validation rules.',
      ...ops.get('custom_fields', { what: 'custom field' }),
      example: (ctx) => ({ id: ctx.all('custom_fields')[0].id }),
    },
    {
      id: 'list_custom_fields', name: 'List fields for module', description: 'List custom field definitions for one record type (module/table). Archived fields excluded unless status is given.',
      ...ops.search('custom_fields', {
        text: ['label', 'key'],
        filters: { module: z.string().min(1).describe('table name, e.g. contacts'), type: z.enum(TYPES).optional(), status: z.enum(['active', 'archived']).optional() },
        where: (r, i) => i.status || r.status === 'active',
      }),
      example: () => ({ module: 'contacts' }),
    },
    {
      id: 'rename_field_label', name: 'Rename field label', description: 'Change the display label of a custom field. The key (and stored values) stay the same.',
      ...ops.set('custom_fields', 'label', z.string().min(1), { what: 'custom field', guard: isActive }),
      example: (ctx) => ({ id: ctx.all('custom_fields')[0].id, label: 'Date of Birth' }),
    },
    {
      id: 'update_field_help_text', name: 'Update field help text', description: 'Set the help text shown under a custom field (empty string clears it).',
      ...ops.set('custom_fields', 'helpText', z.string(), { what: 'custom field', guard: isActive }),
      example: (ctx) => ({ id: ctx.all('custom_fields')[0].id, helpText: 'Used for birthday campaigns.' }),
    },
    {
      id: 'set_field_validation', name: 'Set field validation rules',
      description: 'Set validation on a custom field: required, min/max (number value or text length), pattern (regex, text only). Merges with existing rules.',
      risk: 'write',
      input: z.object({
        id: id('custom field'), required: z.boolean().optional(), min: z.number().optional(), max: z.number().optional(),
        pattern: z.string().optional().describe('regular expression for text fields'),
      }),
      output: field,
      handler: ({ id: fid, ...rules }, ctx) => {
        const f = ctx.get('custom_fields', fid, 'custom field');
        isActive(f);
        if (!Object.keys(rules).length) fail('VALIDATION', 'provide at least one of required, min, max, pattern');
        if ((rules.min ?? rules.max) !== undefined && !['number', 'text'].includes(f.type))
          fail('VALIDATION', `min/max apply to number (value) and text (length) fields; ${f.key} is ${f.type}`);
        if (rules.pattern !== undefined) {
          if (f.type !== 'text') fail('VALIDATION', `pattern only applies to text fields; ${f.key} is ${f.type}`);
          try {
            new RegExp(rules.pattern);
          } catch {
            fail('VALIDATION', `pattern '${rules.pattern}' is not a valid regular expression`);
          }
        }
        const v = { ...f.validation, ...rules };
        if (v.min != null && v.max != null && v.min > v.max) fail('VALIDATION', `min (${v.min}) cannot exceed max (${v.max})`);
        return ctx.patch(f, { validation: v });
      },
      example: (ctx) => ({ id: byKey(ctx, 'contacts', 'annual_budget'), min: 0, max: 1000000 }),
    },
    {
      id: 'add_dropdown_option', name: 'Add dropdown option', description: 'Add a choice to a dropdown custom field (restores it if it was retired).',
      risk: 'write',
      input: z.object({ id: id('custom field'), value: z.string().min(1) }),
      output: field,
      handler: ({ id: fid, value }, ctx) => {
        const f = ctx.get('custom_fields', fid, 'custom field');
        isDropdown(f);
        const o = f.options.find((x) => x.value.toLowerCase() === value.toLowerCase());
        if (o && !o.retired) fail('DUPLICATE', `option '${o.value}' already exists on ${f.key}`);
        if (o) o.retired = false;
        else f.options.push({ value, retired: false });
        return ctx.patch(f, {});
      },
      example: (ctx) => ({ id: byKey(ctx, 'contacts', 'preferred_location'), value: 'Eastside' }),
    },
    {
      id: 'retire_dropdown_option', name: 'Retire dropdown option',
      description: 'Retire a dropdown choice so it can no longer be selected; records that already have it keep their value.',
      keywords: ['remove option', 'deprecate choice'],
      risk: 'write',
      input: z.object({ id: id('custom field'), value: z.string().min(1) }),
      output: field,
      handler: ({ id: fid, value }, ctx) => {
        const f = ctx.get('custom_fields', fid, 'custom field');
        isDropdown(f);
        const o = f.options.find((x) => x.value.toLowerCase() === value.toLowerCase());
        if (!o) fail('NOT_FOUND', `option '${value}' not on ${f.key}; options: ${f.options.map((x) => x.value).join(', ')}`);
        if (o.retired) fail('INVALID_STATE', `option '${o.value}' is already retired`);
        if (activeOptions(f).length === 1) fail('INVALID_STATE', 'cannot retire the last active option; add another option first');
        o.retired = true;
        return ctx.patch(f, {});
      },
      example: (ctx) => ({ id: byKey(ctx, 'contacts', 'preferred_location'), value: 'Westside' }),
    },
    {
      id: 'set_record_field_value', name: 'Set record field value',
      description: 'Write a custom field value on one record (e.g. a contact\'s birthday). Validates type, dropdown options and validation rules; null clears it.',
      keywords: ['fill custom field', 'update custom property'],
      risk: 'write',
      input: z.object({
        id: id('custom field'), recordId: id('record of the field\'s module'),
        value: z.union([z.string(), z.number(), z.boolean(), z.null()]).describe('value matching the field type; null clears it'),
      }),
      output: z.looseObject({ recordType: z.string(), recordId: z.string(), key: z.string(), value: z.any(), previousValue: z.any() }),
      handler: ({ id: fid, recordId, value }, ctx) => {
        const f = ctx.get('custom_fields', fid, 'custom field');
        isActive(f);
        const rec = ctx.get(f.module, recordId, f.module);
        const v = coerce(f, value);
        const previousValue = rec.customFields?.[f.key] ?? null;
        ctx.patch(rec, { customFields: { ...rec.customFields, [f.key]: v } });
        return { recordType: f.module, recordId, key: f.key, label: f.label, value: v, previousValue };
      },
      example: (ctx) => ({ id: byKey(ctx, 'contacts', 'birthday'), recordId: 'con_002', value: '1990-07-21' }),
    },
    {
      id: 'archive_custom_field', name: 'Archive custom field', description: 'Archive a custom field: hidden and no longer writable; existing record values are kept.',
      keywords: ['delete field', 'remove field'],
      ...ops.transition('custom_fields', { to: 'archived', from: ['active'], risk: 'destructive', what: 'custom field' }),
      example: (ctx) => ({ id: byKey(ctx, 'opportunities', 'competitor') }),
    },
  ],

  seed(ctx, h) {
    const defs = [
      ['contacts', 'birthday', 'Birthday', 'date', [], 'Used for birthday offers.'],
      ['contacts', 'preferred_location', 'Preferred Location', 'dropdown', ['Downtown', 'Uptown', 'Westside', 'Online'], '', { retired: ['Online'] }],
      ['contacts', 'annual_budget', 'Annual Budget', 'number', [], 'Estimated yearly spend in USD.', { validation: { min: 0 } }],
      ['contacts', 'referral_code', 'Referral Code', 'text', [], 'Format ABC-1234.', { validation: { pattern: '^[A-Z]{3}-\\d{4}$' } }],
      ['contacts', 'marketing_consent', 'Marketing Consent', 'checkbox', [], ''],
      ['contacts', 'legacy_crm_id', 'Legacy CRM ID', 'text', [], 'Imported from the old CRM.', { status: 'archived' }],
      ['leads', 'budget_range', 'Budget Range', 'dropdown', ['<$5k', '$5k-$10k', '$10k-$25k', '$25k+'], '', { validation: { required: true } }],
      ['leads', 'purchase_timeline', 'Purchase Timeline', 'dropdown', ['This month', 'This quarter', 'Next quarter', 'Just researching'], ''],
      ['leads', 'decision_maker', 'Decision Maker', 'checkbox', [], 'Is this person able to sign?'],
      ['opportunities', 'contract_length_months', 'Contract Length (months)', 'number', [], '', { validation: { min: 1, max: 60 } }],
      ['opportunities', 'competitor', 'Competitor', 'text', [], 'Main competitor in the deal.'],
      ['companies', 'employee_count', 'Employee Count', 'number', [], '', { validation: { min: 1 } }],
    ];
    for (const [module, key, label, type, opts, helpText, x = {}] of defs)
      ctx.insert('custom_fields', {
        module, key, label, type, options: opts.map((value) => ({ value, retired: (x.retired || []).includes(value) })), helpText,
        validation: { required: false, ...x.validation }, status: x.status || 'active', createdAt: h.daysAgo(h.int(30, 300)),
      });
    // Sample values; direct assignment keeps records' updatedAt unchanged.
    const values = [
      ['con_001', { birthday: '1984-03-14', preferred_location: 'Downtown', annual_budget: 12000, marketing_consent: true, referral_code: 'SJN-1001' }],
      ['con_002', { preferred_location: 'Online', marketing_consent: true }], // retired option kept on record
      ['con_003', { birthday: '1979-11-09', annual_budget: 4500 }],
      ['con_005', { marketing_consent: false, legacy_crm_id: 'OLD-55812' }],
    ];
    for (const [cid, v] of values) {
      const c = ctx.find('contacts', cid);
      if (c) c.customFields = { ...c.customFields, ...v };
    }
    ctx.all('contacts').slice(5, 15).forEach((c, i) => (c.customFields = { ...c.customFields, preferred_location: ['Downtown', 'Uptown', 'Westside'][i % 3] }));
  },
});
