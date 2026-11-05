import { defineModule, ops, z, id, entity, fail } from '../kit.js';

const CHANNELS = ['email', 'sms'];
const VAR_RE = /\{\{\s*([\w.]+)\s*\}\}/g;
const VAR_NAME = /^[A-Za-z_]\w*(\.\w+)*$/;
const template = entity({
  name: z.string(), channel: z.enum(CHANNELS), subject: z.string().nullable().optional(), body: z.string(),
  variables: z.array(z.string()), status: z.enum(['active', 'archived']), version: z.number(),
  versions: z.array(z.looseObject({ version: z.number(), body: z.string() })), category: z.string().nullable().optional(),
});
const vars = z.record(z.string(), z.union([z.string(), z.number()]));

// ---------- rendering helpers (shared with sms/email/campaigns/workflows) ----------
export const extractVars = (...texts) => [...new Set(texts.filter(Boolean).flatMap((t) => [...t.matchAll(VAR_RE)].map((m) => m[1])))];
const money = (n, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(n ?? 0);

/** Flat {'contact.firstName': ...} map from business, sending user, contact and an optional related record; explicit variables win. */
export function renderData(ctx, { contactId, relatedType, relatedId, variables } = {}) {
  const d = { 'business.name': 'Acme' };
  const u = ctx.find('users', ctx.actorId);
  if (u) Object.assign(d, { 'user.name': u.name, 'user.firstName': u.name.split(' ')[0], 'user.email': u.email });
  const c = contactId && ctx.find('contacts', contactId);
  if (c) Object.assign(d, { 'contact.firstName': c.firstName, 'contact.lastName': c.lastName, 'contact.name': c.name, 'contact.email': c.email, 'contact.phone': c.phone });
  const r = relatedType && relatedId && ctx.find(relatedType, relatedId);
  if (r && relatedType === 'invoices')
    Object.assign(d, { 'invoice.number': r.number, 'invoice.total': money(r.total, r.currency), 'invoice.balance': money(r.balance, r.currency), 'invoice.dueDate': r.dueDate, 'invoice.status': r.status });
  if (r && relatedType === 'appointments')
    Object.assign(d, { 'appointment.title': r.title, 'appointment.date': r.startAt?.slice(0, 10), 'appointment.time': r.startAt && `${r.startAt.slice(11, 16)} UTC` });
  Object.assign(d, variables || {});
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v != null && v !== ''));
}

/** Substitute {{vars}} in subject/body; unresolved placeholders stay and are reported in `missing`. */
export function renderParts({ subject, body }, data) {
  const missing = new Set();
  const r = (t) => t?.replace(VAR_RE, (m, k) => (Object.hasOwn(data, k) ? String(data[k]) : (missing.add(k), m))) ?? null;
  return { subject: r(subject), body: r(body), missing: [...missing] };
}

export function activeTemplate(ctx, tid, channel) {
  const t = ctx.get('templates', tid, 'template');
  if (t.status !== 'active') fail('INVALID_STATE', `template ${t.id} '${t.name}' is archived; pick an active template or duplicate this one`);
  if (channel && t.channel !== channel) fail('VALIDATION', `template ${t.id} '${t.name}' is a ${t.channel} template; use a ${channel} template`);
  return t;
}

const SAMPLES = {
  'contact.firstName': 'Jane', 'contact.lastName': 'Doe', 'contact.name': 'Jane Doe', 'contact.email': 'jane.doe@example.com', 'contact.phone': '+1-555-0199',
  'invoice.number': 'INV-1001', 'invoice.balance': '$250.00', 'invoice.total': '$250.00', 'invoice.dueDate': '2026-11-15', 'invoice.status': 'sent',
  'appointment.title': 'Consultation', 'appointment.date': '2026-11-10', 'appointment.time': '15:00 UTC', 'business.name': 'Acme',
  'user.name': 'Alex Morgan', 'user.firstName': 'Alex', 'user.email': 'alex.morgan@acme.test', 'review.link': 'https://reviews.acme.test/r/sample',
};
const checkVars = (t) => {
  const used = extractVars(t.subject, t.body);
  const undeclared = used.filter((v) => !t.variables.includes(v));
  const unused = t.variables.filter((v) => !used.includes(v));
  return { templateId: t.id, valid: !undeclared.length && !unused.length, used, declared: t.variables, undeclared, unused };
};
const uniqueName = (ctx, name, exceptId) => {
  const d = ctx.all('templates').find((t) => t.status === 'active' && t.id !== exceptId && t.name.toLowerCase() === name.toLowerCase());
  if (d) fail('DUPLICATE', `an active template named '${name}' already exists (${d.id}); choose another name or update that template`);
};
const editable = (t) => {
  if (t.status !== 'active') fail('INVALID_STATE', `template ${t.id} '${t.name}' is archived and read-only; duplicate it to get an editable copy`);
};
/** Strip braces/whitespace, dedupe and validate declared variable names. */
const cleanVars = (variables) => {
  const names = [...new Set(variables.map((v) => v.replace(/[{}\s]/g, '')))];
  const bad = names.filter((v) => !VAR_NAME.test(v));
  if (bad.length) fail('VALIDATION', `invalid variable names: ${bad.join(', ')}; use dotted names like contact.firstName`);
  return names;
};
const snap = (t, ctx) => ({ version: t.version, subject: t.subject, body: t.body, variables: [...t.variables], savedAt: t.updatedAt, savedBy: ctx.actorId });
const byName = (ctx, n) => ctx.all('templates').find((t) => t.name === n).id;

export default defineModule({
  id: 'templates',
  code: 'M14',
  name: 'Message Templates',
  description: 'Reusable email and SMS message templates with {{variable}} placeholders and version history.',
  tables: { templates: { prefix: 'tpl', schema: template } },
  actions: [
    {
      id: 'create_template', name: 'Create message template',
      description: 'Create a reusable email or SMS template with {{variable}} placeholders (e.g. {{contact.firstName}}, {{invoice.number}}). Saves content only; sends nothing. Variables are auto-detected unless given.',
      keywords: ['new template', 'canned response', 'saved message', 'snippet'],
      ...ops.create('templates', {
        input: z.object({
          name: z.string().min(1), channel: z.enum(CHANNELS), subject: z.string().min(1).optional().describe('required for email templates'),
          body: z.string().min(1), variables: z.array(z.string()).optional().describe('declared variable names without braces; default = detected from content'),
          category: z.string().optional().describe('e.g. sales, billing, scheduling, onboarding'),
        }),
        check: (i, ctx) => {
          if (i.channel === 'email' && !i.subject) fail('VALIDATION', 'email templates need a subject');
          if (i.variables) cleanVars(i.variables);
          uniqueName(ctx, i.name);
        },
        build: (i) => ({
          subject: i.channel === 'email' ? i.subject : null, variables: i.variables ? cleanVars(i.variables) : extractVars(i.subject, i.body),
          category: i.category ?? null, status: 'active', version: 1, versions: [],
        }),
      }),
      example: () => ({ name: 'Holiday Hours', channel: 'sms', body: 'Hi {{contact.firstName}}, {{business.name}} is closed Nov 26-27. Happy holidays!' }),
    },
    {
      id: 'get_template', name: 'Get template', description: 'Fetch one message template (content, variables, version history) by ID.',
      ...ops.get('templates', { what: 'template' }),
      example: (ctx) => ({ id: byName(ctx, 'Invoice Payment Reminder') }),
    },
    {
      id: 'search_templates', name: 'Search templates',
      description: 'Find message templates by name/subject/body text, channel (email/sms) or category. Archived templates are excluded unless status is given.',
      keywords: ['list templates', 'find template'],
      ...ops.search('templates', {
        text: ['name', 'subject', 'body'],
        filters: { channel: z.enum(CHANNELS).optional(), category: z.string().optional(), status: z.enum(['active', 'archived']).optional() },
        where: (r, i) => i.status || r.status === 'active',
      }),
      example: () => ({ query: 'reminder' }),
    },
    {
      id: 'update_template_content', name: 'Update template content',
      description: 'Change the subject and/or body of an active template. The previous content is saved to version history (restorable). Returns undeclaredVariables if new placeholders are not in the variables list.',
      keywords: ['edit template', 'change wording'],
      risk: 'write',
      input: z.object({ id: id('template'), subject: z.string().min(1).optional(), body: z.string().min(1).optional() }),
      output: template,
      handler: ({ id: tid, subject, body }, ctx) => {
        const t = ctx.get('templates', tid, 'template');
        editable(t);
        if (subject === undefined && body === undefined) fail('VALIDATION', 'provide subject and/or body');
        if (subject && t.channel === 'sms') fail('VALIDATION', 'SMS templates have no subject; update body only');
        t.versions.push(snap(t, ctx));
        ctx.patch(t, { subject: subject ?? t.subject, body: body ?? t.body, version: t.version + 1 });
        return { ...t, undeclaredVariables: checkVars(t).undeclared };
      },
      example: (ctx) => ({ id: byName(ctx, 'Lead Follow-up SMS'), body: 'Hi {{contact.firstName}}, thanks for contacting {{business.name}}! When is a good time to chat?' }),
    },
    {
      id: 'archive_template', name: 'Archive template',
      description: 'Archive an active template so it can no longer be used for sending (it stays readable and can be duplicated).',
      keywords: ['delete template', 'retire template'],
      ...ops.transition('templates', { to: 'archived', from: ['active'], risk: 'destructive', what: 'template' }),
      example: (ctx) => ({ id: byName(ctx, 'Welcome Email') }),
    },
    {
      id: 'duplicate_template', name: 'Duplicate template',
      description: 'Copy a template (active or archived) into a new active template, default name "<name> (Copy)". Version history is not copied.',
      keywords: ['clone template', 'copy template'],
      risk: 'write',
      input: z.object({ id: id('template'), name: z.string().min(1).optional().describe('name for the copy') }),
      output: template,
      handler: ({ id: tid, name }, ctx) => {
        const t = ctx.get('templates', tid, 'template');
        const newName = name ?? `${t.name} (Copy)`;
        uniqueName(ctx, newName);
        return ctx.insert('templates', {
          name: newName, channel: t.channel, subject: t.subject, body: t.body, variables: [...t.variables], category: t.category ?? null,
          status: 'active', version: 1, versions: [], duplicatedFrom: t.id,
        });
      },
      example: (ctx) => ({ id: byName(ctx, 'Review Request') }),
    },
    {
      id: 'define_template_variables', name: 'Define template variables',
      description: 'Replace the declared variable list of a template (names like contact.firstName, without braces). Returns the resulting undeclared/unused variable check.',
      risk: 'write',
      input: z.object({ id: id('template'), variables: z.array(z.string().min(1)).describe('full list of variable names, e.g. ["contact.firstName","review.link"]') }),
      output: template,
      handler: ({ id: tid, variables }, ctx) => {
        const t = ctx.get('templates', tid, 'template');
        editable(t);
        ctx.patch(t, { variables: cleanVars(variables) });
        return { ...t, check: checkVars(t) };
      },
      example: (ctx) => ({ id: byName(ctx, 'Review Request'), variables: ['contact.firstName', 'review.link'] }),
    },
    {
      id: 'validate_template_variables', name: 'Validate template variables',
      description: 'Check a template for {{placeholders}} used in subject/body but not declared (undeclared) and declared variables never used (unused).',
      risk: 'read',
      input: z.object({ id: id('template') }),
      output: z.looseObject({ templateId: z.string(), valid: z.boolean(), undeclared: z.array(z.string()), unused: z.array(z.string()) }),
      handler: ({ id: tid }, ctx) => checkVars(ctx.get('templates', tid, 'template')),
      example: (ctx) => ({ id: byName(ctx, 'Review Request') }),
    },
    {
      id: 'render_template', name: 'Render template with sample data',
      description: 'Preview a template with values filled in: from `data`, a contact (contactId) and/or a related record (e.g. relatedType "invoices"). Variables not supplied are filled with sample values and listed in missingVariables. Sends nothing.',
      keywords: ['preview template', 'test template', 'merge fields'],
      risk: 'read',
      input: z.object({
        id: id('template'), data: vars.optional().describe('explicit values, e.g. {"invoice.number":"INV-1042"}'),
        contactId: z.string().optional(), relatedType: z.string().optional().describe('table of the related record, e.g. invoices, appointments'), relatedId: z.string().optional(),
      }),
      output: z.looseObject({ templateId: z.string(), subject: z.string().nullable(), body: z.string(), missingVariables: z.array(z.string()) }),
      handler: (i, ctx) => {
        const t = ctx.get('templates', i.id, 'template');
        if (i.contactId) ctx.get('contacts', i.contactId, 'contact');
        if (i.relatedType && i.relatedId) ctx.ref(i.relatedType, i.relatedId);
        const data = renderData(ctx, { ...i, variables: i.data });
        const missing = extractVars(t.subject, t.body).filter((v) => !Object.hasOwn(data, v));
        for (const v of missing) data[v] = Object.hasOwn(SAMPLES, v) ? SAMPLES[v] : `[${v}]`;
        const r = renderParts(t, data);
        return { templateId: t.id, name: t.name, channel: t.channel, status: t.status, subject: r.subject, body: r.body, missingVariables: missing };
      },
      example: (ctx) => ({ id: byName(ctx, 'Invoice Payment Reminder'), contactId: 'con_001' }),
    },
    {
      id: 'restore_template_version', name: 'Restore template version',
      description: 'Roll a template back to an earlier saved version number (current content is itself saved to history first).',
      keywords: ['revert template', 'undo template change'],
      risk: 'write',
      input: z.object({ id: id('template'), version: z.number().int().min(1).describe('version number from the template versions[] history') }),
      output: template,
      handler: ({ id: tid, version }, ctx) => {
        const t = ctx.get('templates', tid, 'template');
        editable(t);
        const v = t.versions.find((x) => x.version === version);
        if (!v) fail('NOT_FOUND', `template ${t.id} has no saved version ${version} (current is v${t.version}; saved: ${t.versions.map((x) => x.version).join(', ') || 'none'})`);
        t.versions.push(snap(t, ctx));
        return ctx.patch(t, { subject: v.subject, body: v.body, variables: [...v.variables], version: t.version + 1, restoredFrom: version });
      },
      example: (ctx) => ({ id: byName(ctx, 'Invoice Payment Reminder'), version: 1 }),
    },
  ],

  seed(ctx, h) {
    const rows = [
      {
        name: 'Invoice Payment Reminder', channel: 'email', category: 'billing',
        subject: 'Reminder: invoice {{invoice.number}} is due {{invoice.dueDate}}',
        body: 'Hi {{contact.firstName}},\n\nThis is a friendly reminder that invoice {{invoice.number}} has an outstanding balance of {{invoice.balance}}, due on {{invoice.dueDate}}. You can pay online at any time.\n\nThank you,\n{{business.name}}',
        old: { subject: 'Invoice {{invoice.number}} reminder', body: 'Hi {{contact.firstName}}, invoice {{invoice.number}} ({{invoice.balance}}) is due {{invoice.dueDate}}. Please pay at your earliest convenience.' },
      },
      { name: 'Lead Follow-up SMS', channel: 'sms', category: 'sales', body: "Hi {{contact.firstName}}, it's {{user.firstName}} from {{business.name}}. Thanks for your interest! Is now a good time for a quick call?" },
      {
        name: 'Lead Follow-up Email', channel: 'email', category: 'sales', subject: 'Following up, {{contact.firstName}}',
        body: "Hi {{contact.firstName}},\n\nThanks for reaching out to {{business.name}}. I'd love to learn more about what you need. Would you have 15 minutes this week for a quick call?\n\nBest,\n{{user.name}}",
      },
      { name: 'Appointment Reminder', channel: 'sms', category: 'scheduling', body: 'Reminder: {{contact.firstName}}, your appointment with {{business.name}} is on {{appointment.date}} at {{appointment.time}}. Reply C to confirm or R to reschedule.' },
      {
        name: 'Welcome Email', channel: 'email', category: 'onboarding', subject: 'Welcome to {{business.name}}, {{contact.firstName}}!',
        body: "Hi {{contact.firstName}},\n\nWelcome aboard! We're thrilled to have you. Reply to this email any time if you have questions.\n\nThe {{business.name}} team",
      },
      {
        // Deliberate edge case: {{review.link}} is used but not declared (validate_template_variables flags it).
        name: 'Review Request', channel: 'email', category: 'reputation', subject: 'How did we do, {{contact.firstName}}?',
        body: 'Hi {{contact.firstName}},\n\nThank you for choosing {{business.name}}! Would you take 30 seconds to leave us a review? {{review.link}}\n\nThank you!',
        variables: ['contact.firstName', 'business.name'],
      },
      { name: 'Payment Failed Notice', channel: 'email', category: 'billing', subject: 'Action needed: your payment did not go through', body: 'Hi {{contact.firstName}}, we were unable to process your latest payment. Please update your card to avoid interruption.\n\n{{business.name}}' },
      { name: 'Black Friday Teaser', channel: 'sms', category: 'promotion', body: '{{business.name}} BLACK FRIDAY: 30% off everything this Friday only! Reply STOP to opt out.' },
      { name: 'Missed Call Text-Back', channel: 'sms', category: 'sales', body: 'Hi {{contact.firstName}}, sorry we missed your call! How can we help? - {{business.name}}' },
      { name: 'Summer Promo 2025', channel: 'sms', category: 'promotion', status: 'archived', body: 'Summer sale! 20% off with code SUMMER25 - {{business.name}}' },
    ];
    for (const r of rows) {
      const created = h.daysAgo(h.int(40, 200));
      const versions = r.old ? [{ version: 1, ...r.old, variables: extractVars(r.old.subject, r.old.body), savedAt: created, savedBy: 'usr_008' }] : [];
      ctx.insert('templates', {
        name: r.name, channel: r.channel, subject: r.subject ?? null, body: r.body, variables: r.variables ?? extractVars(r.subject, r.body),
        category: r.category, status: r.status ?? 'active', version: versions.length + 1, versions, createdAt: created,
        updatedAt: r.old ? h.daysAgo(h.int(5, 30)) : created,
      });
    }
  },
});
