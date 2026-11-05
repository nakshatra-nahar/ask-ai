import { defineModule, ops, z, id, entity, isoDate, limit, fail, page, matchFilters } from '../kit.js';

const FIELD_TYPES = ['text', 'email', 'phone', 'number', 'textarea', 'select', 'checkbox', 'date'];
const RULES = ['minLength', 'maxLength', 'pattern', 'min', 'max', 'allowedDomains', 'blockedDomains'];
const ns = z.string().nullable().optional();
const field = z.looseObject({ id: z.string(), key: z.string(), label: z.string(), type: z.enum(FIELD_TYPES), required: z.boolean() });
const form = entity({
  name: z.string(), description: ns, status: z.enum(['draft', 'published', 'archived']), fields: z.array(field),
  rules: z.array(z.looseObject({ fieldKey: z.string(), rule: z.enum(RULES) })), submissionCount: z.number(), publishedAt: ns, url: ns,
});
const submission = entity({ formId: z.string(), contactId: ns, data: z.record(z.string(), z.any()), submittedAt: z.string(), contactCreated: z.boolean().optional() });
const rule = z.object({
  fieldKey: z.string().min(1), rule: z.enum(RULES),
  value: z.union([z.string(), z.number(), z.array(z.string())]).describe('number for min/max/minLength/maxLength, regex string for pattern, domain list for allowed/blockedDomains'),
  message: z.string().optional().describe('custom error message'),
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const empty = (v) => v === undefined || v === null || v === '';
/** All field-type and rule violations for a submission (empty array = valid). */
function submissionErrors(f, data) {
  const errs = [];
  const keys = f.fields.map((x) => x.key);
  const unknown = Object.keys(data).filter((k) => !keys.includes(k));
  if (unknown.length) errs.push(`unknown fields ${unknown.join(', ')} (form fields: ${keys.join(', ')})`);
  for (const x of f.fields) {
    const v = data[x.key];
    if (empty(v) || (x.type === 'checkbox' && x.required && v === false)) {
      if (x.required) errs.push(`${x.key}: required`);
      continue;
    }
    const bad = {
      email: () => !EMAIL.test(String(v)), phone: () => String(v).replace(/\D/g, '').length < 7, number: () => Number.isNaN(Number(v)),
      select: () => !(x.options || []).includes(v), checkbox: () => typeof v !== 'boolean', date: () => Number.isNaN(Date.parse(v)),
    }[x.type]?.();
    if (bad) errs.push(`${x.key}: invalid ${x.type}${x.type === 'select' ? ` (choose one of ${x.options.join(', ')})` : ''}`);
  }
  for (const r of f.rules) {
    const v = data[r.fieldKey];
    if (empty(v)) continue;
    const str = String(v);
    const domain = str.split('@')[1]?.toLowerCase();
    const broken = {
      minLength: () => str.length < r.value, maxLength: () => str.length > r.value, pattern: () => !new RegExp(r.value).test(str),
      min: () => Number(v) < r.value, max: () => Number(v) > r.value, allowedDomains: () => !r.value.includes(domain), blockedDomains: () => r.value.includes(domain),
    }[r.rule]();
    if (broken) errs.push(`${r.fieldKey}: ${r.message || `fails ${r.rule} ${JSON.stringify(r.value)}`}`);
  }
  return errs;
}
const notArchived = (f) => {
  if (f.status === 'archived') fail('INVALID_STATE', `form ${f.id} '${f.name}' is archived and cannot be edited`);
};
const pickKey = (data, keys) => keys.map((k) => data[k]).find((v) => !empty(v));
const byName = (ctx, n) => ctx.all('forms').find((f) => f.name === n);
const reorderFields = ops.reorder('forms', 'fields', { param: 'orderedFieldIds', what: 'form' });
const asStr = (v) => (empty(v) ? undefined : String(v)); // contact fields are strings; form values may be numbers
const newContact = (ctx, { firstName, lastName, email, phone }) => ctx.insert('contacts', {
  firstName, lastName, name: [firstName, lastName].filter(Boolean).join(' '), email, phone: asStr(phone) ?? null, companyId: null, ownerId: null, tags: [],
  source: 'form', status: 'active', lifecycleStage: 'lead', preferences: { email: true, sms: true, call: true }, relationships: [],
});

export default defineModule({
  id: 'forms',
  code: 'M18',
  name: 'Forms',
  description: 'Build lead-capture forms and collect submissions.',
  tables: { forms: { prefix: 'frm', schema: form }, form_submissions: { prefix: 'fsub', schema: submission } },
  actions: [
    {
      id: 'create_form', name: 'Create form', description: 'Create an empty draft web form (add fields, then publish). For questionnaires with scoring/branching use surveys.',
      keywords: ['new form', 'lead capture form', 'contact form'],
      ...ops.create('forms', {
        input: z.object({ name: z.string().min(1), description: z.string().optional() }),
        check: (i, ctx) => {
          const d = ctx.all('forms').find((f) => f.name.toLowerCase() === i.name.toLowerCase() && f.status !== 'archived');
          if (d) fail('DUPLICATE', `form '${i.name}' already exists (${d.id})`);
        },
        build: (i) => ({ description: i.description ?? null, status: 'draft', fields: [], rules: [], submissionCount: 0, publishedAt: null, url: null }),
      }),
      example: () => ({ name: 'Quote Request', description: 'Ask for a custom quote' }),
    },
    {
      id: 'get_form', name: 'Get form definition', description: 'Fetch a form with its ordered fields, validation rules, status and public URL.',
      ...ops.get('forms', { what: 'form' }),
      example: (ctx) => ({ id: byName(ctx, 'Contact Us').id }),
    },
    {
      id: 'list_forms', name: 'List forms', description: 'List forms, filterable by status (draft/published/archived) or name text.',
      ...ops.search('forms', { text: ['name', 'description'], filters: { status: z.enum(['draft', 'published', 'archived']).optional() } }),
      example: () => ({ status: 'published' }),
    },
    {
      id: 'add_form_field', name: 'Add form field', description: 'Append a field (text, email, phone, number, textarea, select, checkbox, date) to a form. Keys must be unique snake_case; select fields need options.',
      risk: 'write',
      input: z.object({
        id: id('form'), key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'snake_case key, e.g. first_name'), label: z.string().min(1), type: z.enum(FIELD_TYPES),
        required: z.boolean().default(false), options: z.array(z.string()).optional().describe('choices for select fields'), placeholder: z.string().optional(),
      }),
      output: form,
      handler: ({ id: fid, ...f }, ctx) => {
        const fm = ctx.get('forms', fid, 'form');
        notArchived(fm);
        if (fm.fields.some((x) => x.key === f.key)) fail('DUPLICATE', `form already has a field with key '${f.key}'`);
        if (f.type === 'select' && !f.options?.length) fail('VALIDATION', 'select fields need at least one option');
        const added = { id: ctx.newId('ffl'), ...f };
        fm.fields.push(added);
        ctx.patch(fm, {});
        return { ...fm, added };
      },
      example: (ctx) => ({ id: byName(ctx, 'Event RSVP').id, key: 'guests', label: 'Number of guests', type: 'number' }),
    },
    {
      id: 'update_form_field', name: 'Update form field', description: 'Change a form field\'s label, required flag, options or placeholder (key and type are fixed).',
      ...ops.updateItem('forms', 'fields', { label: z.string().min(1), required: z.boolean(), options: z.array(z.string()).min(1), placeholder: z.string() }, { itemParam: 'fieldId', what: 'form', guard: notArchived }),
      example: (ctx) => {
        const f = byName(ctx, 'Contact Us');
        return { id: f.id, fieldId: f.fields.find((x) => x.key === 'message').id, label: 'How can we help?' };
      },
    },
    {
      id: 'reorder_form_fields', name: 'Reorder form fields', description: 'Set the display order of a form\'s fields by passing all field IDs in the new order.',
      ...reorderFields,
      handler: (i, ctx) => {
        notArchived(ctx.get('forms', i.id, 'form'));
        return reorderFields.handler(i, ctx);
      },
      example: (ctx) => {
        const f = byName(ctx, 'Contact Us');
        return { id: f.id, orderedFieldIds: f.fields.map((x) => x.id).reverse() };
      },
    },
    {
      id: 'set_form_validation_rules', name: 'Set form validation rules',
      description: 'Replace a form\'s extra validation rules (minLength, maxLength, pattern, min, max, allowedDomains, blockedDomains) applied to submissions on top of field types/required.',
      risk: 'write',
      input: z.object({ id: id('form'), rules: z.array(rule) }),
      output: form,
      handler: ({ id: fid, rules }, ctx) => {
        const f = ctx.get('forms', fid, 'form');
        notArchived(f);
        const keys = f.fields.map((x) => x.key);
        for (const r of rules) {
          if (!keys.includes(r.fieldKey)) fail('VALIDATION', `no field '${r.fieldKey}' on this form; fields: ${keys.join(', ')}`);
          if (r.rule.endsWith('Domains') && f.fields.find((x) => x.key === r.fieldKey).type !== 'email') fail('VALIDATION', `${r.rule} only applies to email fields; '${r.fieldKey}' is not an email field`);
          const wants = r.rule.endsWith('Domains') ? 'array' : r.rule === 'pattern' ? 'string' : 'number';
          if ((wants === 'array') !== Array.isArray(r.value) || (wants !== 'array' && typeof r.value !== wants)) fail('VALIDATION', `rule ${r.rule} needs a ${wants} value`);
          if (r.rule === 'pattern') {
            try { new RegExp(r.value); } catch { fail('VALIDATION', `invalid regex pattern '${r.value}'`); }
          }
        }
        return ctx.patch(f, { rules });
      },
      example: (ctx) => ({ id: byName(ctx, 'Free Consultation Request').id, rules: [{ fieldKey: 'budget', rule: 'min', value: 1000, message: 'Minimum budget is $1,000' }] }),
    },
    {
      id: 'publish_form', name: 'Publish form', description: 'Publish a draft form to its public URL so people can submit it. Needs at least one field including an email field (used to match/create the contact).',
      keywords: ['make form live', 'embed form'],
      risk: 'external',
      input: z.object({ id: id('form') }),
      output: form,
      handler: ({ id: fid }, ctx) => {
        const f = ctx.get('forms', fid, 'form');
        if (f.status !== 'draft') fail('INVALID_STATE', `form ${f.id} '${f.name}' is ${f.status}; only drafts can be published`);
        if (!f.fields.some((x) => x.type === 'email')) fail('VALIDATION', `form '${f.name}' needs an email field before publishing (add_form_field type email)`);
        return ctx.patch(f, { status: 'published', publishedAt: ctx.now, url: `https://forms.acme.test/${f.id}` });
      },
      example: (ctx) => ({ id: byName(ctx, 'Event RSVP').id }),
    },
    {
      id: 'submit_form_response', name: 'Submit simulated form response',
      description: 'Simulate someone submitting a published form: validates data against field types, required flags and rules (all errors returned), stores the submission and matches an existing contact by email or creates a new lead contact.',
      keywords: ['test form', 'fill form', 'form entry'],
      risk: 'write',
      input: z.object({ id: id('form'), data: z.record(z.string(), z.any()).describe('field key -> value, e.g. {"email":"a@b.com","first_name":"Ann"}') }),
      output: z.looseObject({ submission, contactId: z.string(), contactCreated: z.boolean() }),
      handler: ({ id: fid, data }, ctx) => {
        const f = ctx.get('forms', fid, 'form');
        if (f.status !== 'published') fail('INVALID_STATE', `form ${f.id} '${f.name}' is ${f.status}; only published forms accept submissions`);
        const errs = submissionErrors(f, data);
        if (errs.length) fail('VALIDATION', `submission rejected: ${errs.join('; ')}`, { errors: errs });
        const email = asStr(f.fields.filter((x) => x.type === 'email').map((x) => data[x.key]).find((v) => !empty(v)));
        if (!email) fail('VALIDATION', `submission rejected: an email is needed to match or create the contact (fields: ${f.fields.filter((x) => x.type === 'email').map((x) => x.key).join(', ')})`);
        let c = ctx.all('contacts').find((x) => x.status === 'active' && x.email?.toLowerCase() === email.toLowerCase());
        const contactCreated = !c;
        if (!c) {
          const full = String(pickKey(data, ['name', 'full_name']) ?? '').split(' ');
          c = newContact(ctx, {
            firstName: asStr(pickKey(data, ['first_name', 'firstName'])) ?? (full[0] || email.split('@')[0]),
            lastName: asStr(pickKey(data, ['last_name', 'lastName'])) ?? (full.slice(1).join(' ') || undefined), email,
            phone: data[f.fields.find((x) => x.type === 'phone')?.key],
          });
        }
        const sub = ctx.insert('form_submissions', { formId: f.id, contactId: c.id, data, submittedAt: ctx.now, contactCreated });
        ctx.patch(f, { submissionCount: f.submissionCount + 1 });
        return { submission: sub, contactId: c.id, contactName: c.name, contactCreated };
      },
      example: (ctx) => ({ id: byName(ctx, 'Contact Us').id, data: { first_name: 'Test', last_name: 'Lead', email: 'test.lead@example.com', message: 'I would like a quote for SEO services.' } }),
    },
    {
      id: 'list_form_submissions', name: 'List form submissions', description: 'List stored form submissions (newest first), filterable by form, contact and submitted date range.',
      keywords: ['form entries', 'form responses', 'who filled the form'],
      risk: 'read',
      input: z.object({ formId: z.string().optional(), contactId: z.string().optional(), submittedAtAfter: isoDate().optional(), submittedAtBefore: isoDate().optional(), limit }),
      output: z.looseObject({ total: z.number(), items: z.array(submission) }),
      handler: ({ limit: lim, ...f }, ctx) => {
        if (f.formId) ctx.get('forms', f.formId, 'form');
        const rows = ctx.all('form_submissions').filter((s) => matchFilters(s, f)).sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
        return page(rows.map((s) => ({ ...s, contactName: ctx.find('contacts', s.contactId)?.name ?? null })), lim);
      },
      example: (ctx) => ({ formId: byName(ctx, 'Contact Us').id }),
    },
  ],

  seed(ctx, h) {
    const fl = (key, label, type, required = false, extra = {}) => ({ id: ctx.newId('ffl'), key, label, type, required, ...extra });
    const forms = [
      ['Contact Us', 'published', 'General website contact form', [fl('first_name', 'First name', 'text', true), fl('last_name', 'Last name', 'text'), fl('email', 'Email', 'email', true), fl('phone', 'Phone', 'phone'), fl('message', 'Message', 'textarea', true)], [{ fieldKey: 'message', rule: 'minLength', value: 10 }]],
      ['Free Consultation Request', 'published', 'Book a free 30-minute strategy call', [fl('full_name', 'Full name', 'text', true), fl('email', 'Work email', 'email', true), fl('phone', 'Phone', 'phone', true), fl('service', 'Service of interest', 'select', true, { options: ['SEO', 'Paid Ads', 'Web Design', 'CRM Setup'] }), fl('budget', 'Monthly budget (USD)', 'number')], [{ fieldKey: 'budget', rule: 'min', value: 500 }]],
      ['Webinar Registration', 'published', 'Register for the monthly growth webinar', [fl('first_name', 'First name', 'text', true), fl('email', 'Email', 'email', true), fl('company', 'Company', 'text')], [{ fieldKey: 'email', rule: 'blockedDomains', value: ['mailinator.com', 'tempmail.com'] }]],
      ['Newsletter Signup', 'published', 'Footer newsletter signup', [fl('email', 'Email', 'email', true)], []],
      ['Partner Application', 'draft', 'Agency partner program (no email field yet)', [fl('company_name', 'Company name', 'text', true), fl('website', 'Website', 'text')], []],
      ['Event RSVP', 'draft', 'RSVP for the client appreciation evening', [fl('first_name', 'First name', 'text', true), fl('email', 'Email', 'email', true), fl('attending', 'I will attend', 'checkbox', true)], []],
      ['Summer Giveaway 2025', 'archived', 'Old giveaway entry form', [fl('email', 'Email', 'email', true)], []],
    ];
    for (const [name, status, description, fields, rules] of forms) {
      const live = status !== 'draft';
      ctx.insert('forms', { name, description, status, fields, rules, submissionCount: 0, publishedAt: live ? h.daysAgo(h.int(60, 200)) : null, url: live ? 'pending' : null, createdAt: h.daysAgo(h.int(200, 300)) });
    }
    ctx.all('forms').forEach((f) => f.url === 'pending' && (f.url = `https://forms.acme.test/${f.id}`));
    const contacts = ctx.all('contacts').filter((c) => c.status === 'active' && c.email).slice(30, 42);
    const msgs = ['Looking for help with our Google reviews.', 'Can you send pricing for a new website?', 'Interested in your CRM setup service.'];
    contacts.forEach((c, k) => {
      const f = ctx.all('forms')[k % 4];
      const data = {
        0: { first_name: c.firstName, last_name: c.lastName, email: c.email, phone: c.phone, message: msgs[k % 3] },
        1: { full_name: c.name, email: c.email, phone: c.phone, service: h.pick(['SEO', 'Paid Ads', 'Web Design', 'CRM Setup']), budget: h.pick([800, 1500, 3000]) },
        2: { first_name: c.firstName, email: c.email, company: h.pick(h.companyNames) },
        3: { email: c.email },
      }[k % 4];
      const at = h.daysAgo(h.int(1, 30));
      ctx.insert('form_submissions', { formId: f.id, contactId: c.id, data, submittedAt: at, contactCreated: false, createdAt: at });
      f.submissionCount++;
    });
  },
});
