import { defineModule, ops, z, id, entity, isoDate, limit, fail, page, textMatch, matchFilters } from '../kit.js';

const contact = entity({
  firstName: z.string(), lastName: z.string().optional(), name: z.string(), email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(), companyId: z.string().nullable().optional(), ownerId: z.string().nullable().optional(),
  tags: z.array(z.string()), source: z.string().nullable().optional(), status: z.enum(['active', 'archived', 'merged']),
  lifecycleStage: z.string().optional(), preferences: z.object({ email: z.boolean(), sms: z.boolean(), call: z.boolean() }).optional(),
});
const STAGES = ['subscriber', 'lead', 'opportunity', 'customer', 'churned'];
const REL_TYPES = ['spouse', 'family', 'colleague', 'assistant', 'referrer', 'partner', 'other'];
const fullName = (c) => [c.firstName, c.lastName].filter(Boolean).join(' ');

function activeUser(ctx, uid) {
  const u = ctx.get('users', uid, 'user');
  if (u.status !== 'active') fail('INVALID_STATE', `user ${uid} (${u.name}) is ${u.status} and cannot own records`);
  return u;
}
const emailTaken = (ctx, email, selfId) => {
  const dup = email && ctx.all('contacts').find((c) => c.id !== selfId && c.email?.toLowerCase() === email.toLowerCase() && c.status !== 'merged');
  if (dup) fail('DUPLICATE', `a contact with email ${email} already exists (${dup.id} ${dup.name})`, { existingId: dup.id });
};
// Merged records are tombstones: new links must go to the record they were merged into.
const notMerged = (rec, what) => {
  if (rec.status === 'merged') fail('INVALID_STATE', `${what} ${rec.id} was merged into ${rec.mergedInto}; use ${rec.mergedInto} instead`);
  return rec;
};

export default defineModule({
  id: 'contacts',
  code: 'M01',
  name: 'Contacts',
  description: 'Manage people and their CRM profiles.',
  tables: { contacts: { prefix: 'con', schema: contact } },
  actions: [
    {
      id: 'create_contact', name: 'Create contact',
      description: 'Create a new person/contact record. Rejects duplicate emails.',
      keywords: ['add person', 'new customer', 'new contact', 'save contact'],
      ...ops.create('contacts', {
        input: z.object({
          firstName: z.string().min(1), lastName: z.string().optional(), email: z.email().optional(), phone: z.string().optional(),
          companyId: z.string().optional(), ownerId: z.string().optional(), source: z.string().optional(),
          tags: z.array(z.string()).optional(), lifecycleStage: z.enum(STAGES).optional(),
        }),
        check: (i, ctx) => {
          emailTaken(ctx, i.email);
          if (i.ownerId) activeUser(ctx, i.ownerId);
          if (i.companyId) notMerged(ctx.get('companies', i.companyId, 'company'), 'company');
        },
        build: (i) => ({
          name: fullName(i), tags: i.tags || [], status: 'active', lifecycleStage: i.lifecycleStage || 'lead',
          email: i.email ?? null, phone: i.phone ?? null, ownerId: i.ownerId ?? null, companyId: i.companyId ?? null,
          preferences: { email: true, sms: true, call: true }, relationships: [],
        }),
      }),
      example: () => ({ firstName: 'Test', lastName: 'Person', email: 'test.person@example.com' }),
    },
    {
      id: 'get_contact', name: 'Get contact details', description: 'Fetch one contact by ID.',
      ...ops.get('contacts', { what: 'contact' }),
      example: (ctx) => ({ id: ctx.all('contacts')[0].id }),
    },
    {
      id: 'search_contacts', name: 'Search contacts',
      description: 'Find contacts by name/email/phone text, tag, owner, company, source, lifecycle stage, or created date range. Archived/merged excluded unless status is given.',
      keywords: ['find people', 'lookup customer', 'list contacts'],
      ...ops.search('contacts', {
        text: ['name', 'email', 'phone'],
        filters: {
          tags: z.string().optional().describe('single tag that must be present'),
          ownerId: z.string().optional(), companyId: z.string().optional(), source: z.string().optional(),
          lifecycleStage: z.enum(STAGES).optional(), status: z.enum(['active', 'archived', 'merged']).optional(),
          createdAtAfter: isoDate().optional(), createdAtBefore: isoDate().optional(),
        },
        where: (r, i) => i.status || r.status === 'active',
      }),
      example: () => ({ query: 'sarah' }),
    },
    {
      id: 'update_contact', name: 'Update contact details', description: 'Change name, email, phone, source, company, or lifecycle stage of a contact.',
      ...ops.update('contacts', {
        what: 'contact',
        fields: {
          firstName: z.string().min(1), lastName: z.string(), email: z.email(), phone: z.string(), source: z.string(),
          companyId: z.string(), lifecycleStage: z.enum(STAGES),
        },
        guard: (rec, i, ctx) => {
          if (rec.status !== 'active') fail('INVALID_STATE', `contact ${rec.id} is ${rec.status}`);
          emailTaken(ctx, i.email, rec.id);
          if (i.companyId) notMerged(ctx.get('companies', i.companyId, 'company'), 'company');
        },
        after: (rec) => (rec.name = fullName(rec)),
      }),
      example: (ctx) => ({ id: ctx.all('contacts')[0].id, phone: '+1-555-0100' }),
    },
    {
      id: 'archive_contact', name: 'Archive contact', description: 'Archive (soft-delete) an active contact.',
      keywords: ['delete contact', 'remove contact'],
      ...ops.transition('contacts', { to: 'archived', from: ['active'], risk: 'destructive', what: 'contact' }),
      example: (ctx) => ({ id: ctx.all('contacts')[5].id }),
    },
    {
      id: 'merge_contacts', name: 'Merge duplicate contacts',
      description: 'Merge a duplicate contact into a primary one: fills blank fields, unions tags, keeps any channel opt-out, re-points all linked records (leads, tasks, conversations, messages, appointments, invoices, payments, notes, opportunities…) and marks the duplicate merged.',
      keywords: ['dedupe', 'duplicate', 'combine contacts'],
      risk: 'destructive',
      input: z.object({ primaryId: id('primary contact'), duplicateId: id('duplicate contact') }),
      output: z.looseObject({ primary: contact, repointed: z.record(z.string(), z.number()) }),
      handler: ({ primaryId, duplicateId }, ctx) => {
        if (primaryId === duplicateId) fail('VALIDATION', 'primaryId and duplicateId must differ');
        const p = ctx.get('contacts', primaryId, 'contact');
        const d = ctx.get('contacts', duplicateId, 'contact');
        if (p.status !== 'active' || d.status !== 'active') fail('INVALID_STATE', 'both contacts must be active');
        for (const k of ['email', 'phone', 'companyId', 'ownerId', 'source', 'lastName']) if (!p[k] && d[k]) p[k] = d[k];
        p.tags = [...new Set([...p.tags, ...d.tags])];
        if (d.customFields) p.customFields = { ...d.customFields, ...p.customFields };
        p.name = fullName(p);
        // An opt-out on either record must survive the merge.
        if (p.preferences || d.preferences)
          p.preferences = Object.fromEntries(['email', 'sms', 'call'].map((k) => [k, p.preferences?.[k] !== false && d.preferences?.[k] !== false]));
        const repointed = {};
        for (const [t, rows] of Object.entries(ctx.db.tables)) {
          if (t === 'activity') continue;
          let n = 0;
          for (const r of rows) {
            const byContact = r.contactId === duplicateId;
            const byRecord = r.recordType === 'contacts' && r.recordId === duplicateId;
            if (byContact || byRecord) ctx.patch(r, { ...(byContact ? { contactId: primaryId } : {}), ...(byRecord ? { recordId: primaryId } : {}) }), n++;
          }
          if (n) repointed[t] = n;
        }
        ctx.patch(d, { status: 'merged', mergedInto: primaryId });
        ctx.patch(p, {});
        return { primary: p, repointed };
      },
      example: (ctx) => {
        const c = ctx.all('contacts').filter((x) => x.status === 'active');
        return { primaryId: c[0].id, duplicateId: c[1].id };
      },
    },
    {
      id: 'assign_contact_owner', name: 'Assign contact owner', description: 'Set the user who owns a contact. Owner must be an active user.',
      ...ops.set('contacts', 'ownerId', id('user'), {
        param: 'ownerId', what: 'contact',
        guard: (r, i, ctx) => {
          if (r.status !== 'active') fail('INVALID_STATE', `contact ${r.id} is ${r.status}`);
          activeUser(ctx, i.ownerId);
        },
      }),
      example: (ctx) => ({ id: ctx.all('contacts')[0].id, ownerId: 'usr_002' }),
    },
    {
      id: 'set_communication_preferences', name: 'Set communication preferences',
      description: 'Opt a contact in/out of email, SMS, or calls (do-not-disturb per channel).',
      keywords: ['dnd', 'do not disturb', 'opt out', 'unsubscribe'],
      risk: 'write',
      input: z.object({ id: id('contact'), email: z.boolean().optional(), sms: z.boolean().optional(), call: z.boolean().optional() }),
      output: contact,
      handler: ({ id: cid, ...prefs }, ctx) => {
        const c = ctx.get('contacts', cid, 'contact');
        if (!Object.keys(prefs).length) fail('VALIDATION', 'provide at least one of email, sms, call');
        return ctx.patch(c, { preferences: { ...c.preferences, ...prefs } });
      },
      example: (ctx) => ({ id: ctx.all('contacts')[0].id, sms: false }),
    },
    {
      id: 'add_contact_relationship', name: 'Add contact relationship', description: 'Link two contacts with a relationship type (spouse, colleague, referrer...).',
      risk: 'write',
      input: z.object({ id: id('contact'), relatedContactId: id('related contact'), type: z.enum(REL_TYPES) }),
      output: contact,
      handler: ({ id: cid, relatedContactId, type }, ctx) => {
        if (cid === relatedContactId) fail('VALIDATION', 'a contact cannot be related to itself');
        const c = notMerged(ctx.get('contacts', cid, 'contact'), 'contact');
        notMerged(ctx.get('contacts', relatedContactId, 'related contact'), 'related contact');
        c.relationships ||= [];
        if (c.relationships.some((r) => r.contactId === relatedContactId && r.type === type)) fail('DUPLICATE', 'relationship already exists');
        c.relationships.push({ contactId: relatedContactId, type });
        return ctx.patch(c, {});
      },
      example: (ctx) => ({ id: ctx.all('contacts')[0].id, relatedContactId: ctx.all('contacts')[2].id, type: 'colleague' }),
    },
    {
      id: 'get_contact_timeline', name: 'View contact activity timeline',
      description: 'Chronological activity for a contact: messages, appointments, tasks, notes, invoices and logged actions.',
      keywords: ['history', 'activity', 'interactions'],
      risk: 'read',
      input: z.object({ id: id('contact'), limit }),
      output: z.looseObject({ contactId: z.string(), total: z.number(), items: z.array(z.looseObject({ at: z.string(), type: z.string(), summary: z.string() })) }),
      handler: ({ id: cid, limit: lim }, ctx) => {
        ctx.get('contacts', cid, 'contact');
        const ev = [];
        for (const m of ctx.all('messages').filter((m) => m.contactId === cid))
          ev.push({ at: m.sentAt || m.scheduledAt || m.createdAt, type: `${m.channel}_${m.direction}`, summary: `${m.status}: ${m.subject || m.body?.slice(0, 60) || ''}`, refId: m.id });
        for (const a of ctx.all('appointments').filter((a) => a.contactId === cid))
          ev.push({ at: a.startAt, type: 'appointment', summary: `${a.title} (${a.status})`, refId: a.id });
        for (const t of ctx.all('tasks').filter((t) => t.contactId === cid))
          ev.push({ at: t.createdAt, type: 'task', summary: `${t.title} (${t.status})`, refId: t.id });
        for (const n of ctx.all('notes').filter((n) => n.contactId === cid || (n.recordId === cid)))
          ev.push({ at: n.createdAt, type: 'note', summary: (n.body || '').slice(0, 80), refId: n.id });
        for (const i of ctx.all('invoices').filter((i) => i.contactId === cid))
          ev.push({ at: i.issueDate || i.createdAt, type: 'invoice', summary: `${i.number} ${i.status} balance ${i.balance}`, refId: i.id });
        for (const a of ctx.all('activity').filter((a) => a.refs?.includes(cid)))
          ev.push({ at: a.at, type: 'action', summary: `${a.summary} by ${a.actorId}`, refId: a.id });
        ev.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
        return { contactId: cid, ...page(ev, lim) };
      },
      example: (ctx) => ({ id: ctx.all('contacts')[0].id }),
    },
  ],

  seed(ctx, h) {
    const users = ctx.all('users').filter((u) => u.roles.includes('sales_rep') && u.status === 'active');
    const sources = ['facebook', 'google_ads', 'website', 'referral', 'webinar', 'walk_in'];
    // Deliberate fixtures: two Sarahs (ambiguity), a duplicate pair (merge), DND contact.
    const fixed = [
      { firstName: 'Sarah', lastName: 'Johnson', email: 'sarah.johnson@example.com', tags: ['vip', 'customer'], lifecycleStage: 'customer' },
      { firstName: 'Sarah', lastName: 'Chen', email: 'sarah.chen@example.com', tags: ['lead'], lifecycleStage: 'lead' },
      { firstName: 'Michael', lastName: 'Smith', email: 'michael.smith@example.com', phone: '+1-555-0142', tags: ['customer'], lifecycleStage: 'customer' },
      { firstName: 'Mike', lastName: 'Smith', email: 'mike.smith@example.com', phone: '+1-555-0142', tags: [], lifecycleStage: 'lead' },
      { firstName: 'Olivia', lastName: 'Martin', email: 'olivia.martin@example.com', tags: ['newsletter'], lifecycleStage: 'subscriber', preferences: { email: true, sms: false, call: false } },
    ];
    const rows = [...fixed];
    for (let i = 0; rows.length < 80 && i < 500; i++) {
      const firstName = h.firstNames[i % 30];
      const lastName = h.lastNames[(i + 7 * Math.floor(i / 30) + 3) % 20];
      if (rows.some((r) => r.firstName === firstName && r.lastName === lastName)) continue;
      rows.push({
        firstName, lastName, email: `${firstName}.${lastName}${i}@example.com`.toLowerCase().replace('ü', 'u'),
        tags: h.chance(0.3) ? ['newsletter'] : [], lifecycleStage: h.pick(['lead', 'lead', 'customer', 'opportunity', 'subscriber']),
      });
    }
    rows.forEach((r, i) => {
      ctx.insert('contacts', {
        firstName: r.firstName, lastName: r.lastName, name: fullName(r), email: r.email, phone: r.phone || `+1-555-${String(1000 + i * 37).slice(-4)}`,
        companyId: null, ownerId: users.length ? users[i % users.length].id : null, tags: r.tags, source: h.pick(sources),
        status: 'active', lifecycleStage: r.lifecycleStage, preferences: r.preferences || { email: true, sms: true, call: true }, relationships: [],
        createdAt: h.daysAgo(i < 5 ? 60 + i : h.int(1, 180)),
      });
    });
  },
});
