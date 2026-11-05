import { defineModule, ops, z, id, entity, limit, fail, page, round2 } from '../kit.js';

const STATUS = ['active', 'archived', 'merged'];
const company = entity({
  name: z.string(), domain: z.string().nullable().optional(), industry: z.string().nullable().optional(), phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(), accountManagerId: z.string().nullable().optional(), status: z.enum(STATUS),
});
const contactRow = z.looseObject({ id: z.string(), name: z.string() });

function activeUser(ctx, uid) {
  const u = ctx.get('users', uid, 'user');
  if (u.status !== 'active') fail('INVALID_STATE', `user ${uid} (${u.name}) is ${u.status} and cannot manage accounts; pick an active user`);
  return u;
}
const isActive = (co) => {
  if (co.status !== 'active') fail('INVALID_STATE', `company ${co.id} (${co.name}) is ${co.status}${co.mergedInto ? ` into ${co.mergedInto}` : ''}; only active companies can be changed`);
};
const dupCheck = (ctx, { name, domain }, selfId) => {
  for (const c of ctx.all('companies')) {
    if (c.id === selfId || c.status === 'merged') continue;
    if (name && c.name.toLowerCase() === name.toLowerCase()) fail('DUPLICATE', `a company named '${name}' already exists (${c.id})`, { existingId: c.id });
    if (domain && c.domain?.toLowerCase() === domain.toLowerCase()) fail('DUPLICATE', `domain ${domain} already belongs to ${c.name} (${c.id})`, { existingId: c.id });
  }
};
const members = (ctx, coId) => ctx.all('contacts').filter((c) => c.companyId === coId && c.status !== 'merged');

export default defineModule({
  id: 'companies',
  code: 'M02',
  name: 'Companies',
  description: 'Manage business accounts and linked contacts.',
  tables: { companies: { prefix: 'co', schema: company } },
  actions: [
    {
      id: 'create_company', name: 'Create company',
      description: 'Create a business account (organization), not a person. Rejects duplicate names or domains.',
      keywords: ['new account', 'add business', 'new organization'],
      ...ops.create('companies', {
        input: z.object({
          name: z.string().min(1), domain: z.string().optional().describe('website domain, e.g. acme.com'), industry: z.string().optional(),
          phone: z.string().optional(), address: z.string().optional(), accountManagerId: z.string().optional(),
        }),
        check: (i, ctx) => {
          dupCheck(ctx, i);
          if (i.accountManagerId) activeUser(ctx, i.accountManagerId);
        },
        build: (i) => ({
          domain: i.domain ?? null, industry: i.industry ?? null, phone: i.phone ?? null, address: i.address ?? null,
          accountManagerId: i.accountManagerId ?? null, status: 'active',
        }),
      }),
      example: () => ({ name: 'Riverside Veterinary', domain: 'riversidevet.com', industry: 'Healthcare' }),
    },
    {
      id: 'get_company', name: 'Get company details',
      description: 'Fetch one business account with its account manager name, linked contact count, and open deal count/value.',
      risk: 'read',
      input: z.object({ id: id('company') }),
      output: company,
      handler: ({ id: cid }, ctx) => {
        const co = ctx.get('companies', cid, 'company');
        const open = ctx.all('opportunities').filter((o) => o.companyId === cid && o.status === 'open');
        return {
          ...co, accountManagerName: ctx.find('users', co.accountManagerId)?.name ?? null, contactCount: members(ctx, cid).length,
          openOpportunities: open.length, openPipelineValue: round2(open.reduce((a, o) => a + (o.value || 0), 0)),
        };
      },
      example: (ctx) => ({ id: ctx.all('companies')[0].id }),
    },
    {
      id: 'search_companies', name: 'Search companies',
      description: 'Find business accounts by name/domain text, industry, or account manager. Archived/merged excluded unless status is given. For people use contacts.search_contacts.',
      keywords: ['find account', 'lookup business', 'organizations'],
      ...ops.search('companies', {
        text: ['name', 'domain'],
        filters: { industry: z.string().optional(), accountManagerId: z.string().optional(), status: z.enum(STATUS).optional() },
        where: (r, i) => i.status || r.status === 'active',
      }),
      example: () => ({ query: 'acme' }),
    },
    {
      id: 'update_company', name: 'Update company details', description: 'Change name, domain, industry, phone or address of an active company.',
      ...ops.update('companies', {
        what: 'company',
        fields: { name: z.string().min(1), domain: z.string(), industry: z.string(), phone: z.string(), address: z.string() },
        guard: (co, i, ctx) => {
          isActive(co);
          dupCheck(ctx, i, co.id);
        },
      }),
      example: (ctx) => ({ id: ctx.all('companies')[1].id, phone: '+1-555-0199', industry: 'Real Estate' }),
    },
    {
      id: 'archive_company', name: 'Archive company', description: 'Archive (soft-delete) an active company. Linked contacts keep their companyId.',
      keywords: ['delete company', 'remove account'],
      ...ops.transition('companies', { to: 'archived', from: ['active'], risk: 'destructive', what: 'company' }),
      example: (ctx) => ({ id: ctx.all('companies')[5].id }),
    },
    {
      id: 'link_contact_to_company', name: 'Link contact to company',
      description: 'Make a contact a member of a company (sets contact.companyId). If the contact already belongs to another company, pass replaceExisting to move them.',
      keywords: ['add employee', 'associate contact', 'works at'],
      risk: 'write',
      input: z.object({
        id: id('company'), contactId: id('contact'),
        replaceExisting: z.boolean().optional().describe('move the contact if it already belongs to another company'),
      }),
      output: z.looseObject({ company, contact: contactRow, previousCompanyId: z.string().nullable() }),
      handler: ({ id: cid, contactId, replaceExisting }, ctx) => {
        const co = ctx.get('companies', cid, 'company');
        isActive(co);
        const c = ctx.get('contacts', contactId, 'contact');
        if (c.status !== 'active') fail('INVALID_STATE', `contact ${c.id} is ${c.status}`);
        if (c.companyId === co.id) fail('DUPLICATE', `${c.name} is already linked to ${co.name}`);
        if (c.companyId && !replaceExisting)
          fail('CONFLICT', `${c.name} already belongs to ${ctx.find('companies', c.companyId)?.name ?? c.companyId} (${c.companyId}); pass replaceExisting: true to move them`);
        const previousCompanyId = c.companyId ?? null;
        ctx.patch(c, { companyId: co.id });
        return { company: co, contact: c, previousCompanyId };
      },
      example: (ctx) => ({ id: ctx.all('companies')[0].id, contactId: ctx.all('contacts').find((c) => !c.companyId && c.status === 'active').id }),
    },
    {
      id: 'unlink_contact_from_company', name: 'Unlink contact from company', description: 'Remove a contact from a company (clears contact.companyId). The contact itself is kept.',
      risk: 'write',
      input: z.object({ id: id('company'), contactId: id('contact') }),
      output: z.looseObject({ company, contact: contactRow }),
      handler: ({ id: cid, contactId }, ctx) => {
        const co = ctx.get('companies', cid, 'company');
        const c = ctx.get('contacts', contactId, 'contact');
        if (c.companyId !== co.id)
          fail('NOT_FOUND', `${c.name} is not linked to ${co.name}${c.companyId ? `; they belong to ${c.companyId}` : '; they have no company'}`);
        ctx.patch(c, { companyId: null });
        return { company: co, contact: c };
      },
      example: (ctx) => {
        const c = ctx.all('contacts').find((x) => x.companyId);
        return { id: c.companyId, contactId: c.id };
      },
    },
    {
      id: 'assign_account_manager', name: 'Assign account manager',
      description: 'Set the user who manages a company account (account-level owner; for a person use contacts.assign_contact_owner, for a lead leads.assign_lead_owner).',
      ...ops.set('companies', 'accountManagerId', id('user'), {
        param: 'userId', what: 'company',
        guard: (co, i, ctx) => {
          isActive(co);
          activeUser(ctx, i.userId);
        },
      }),
      example: (ctx) => ({ id: ctx.all('companies')[0].id, userId: 'usr_005' }),
    },
    {
      id: 'merge_companies', name: 'Merge duplicate companies',
      description: 'Merge a duplicate company into a primary one: fills blank fields, re-points everything linked to it (contacts, opportunities, listings, notes, tasks…), and marks the duplicate merged.',
      keywords: ['dedupe accounts', 'combine companies'],
      risk: 'destructive',
      input: z.object({ primaryId: id('primary company'), duplicateId: id('duplicate company') }),
      output: z.looseObject({ primary: company, repointed: z.record(z.string(), z.number()) }),
      handler: ({ primaryId, duplicateId }, ctx) => {
        if (primaryId === duplicateId) fail('VALIDATION', 'primaryId and duplicateId must differ');
        const p = ctx.get('companies', primaryId, 'primary company');
        const d = ctx.get('companies', duplicateId, 'duplicate company');
        if (p.status !== 'active' || d.status !== 'active') fail('INVALID_STATE', `both companies must be active (primary ${p.status}, duplicate ${d.status})`);
        for (const k of ['domain', 'industry', 'phone', 'address', 'accountManagerId']) if (!p[k] && d[k]) p[k] = d[k];
        const repointed = {};
        for (const [t, rows] of Object.entries(ctx.db.tables)) {
          if (t === 'activity') continue;
          let n = 0;
          for (const r of rows) {
            const byCompany = r.companyId === duplicateId;
            const byRecord = r.recordType === 'companies' && r.recordId === duplicateId;
            if (byCompany || byRecord) ctx.patch(r, { ...(byCompany ? { companyId: primaryId } : {}), ...(byRecord ? { recordId: primaryId } : {}) }), n++;
          }
          if (n) repointed[t] = n;
        }
        ctx.patch(d, { status: 'merged', mergedInto: primaryId });
        ctx.patch(p, {});
        return { primary: p, repointed };
      },
      example: (ctx) => ({
        primaryId: ctx.all('companies').find((c) => c.name === 'Acme Dental').id,
        duplicateId: ctx.all('companies').find((c) => c.name === 'Acme Dental LLC').id,
      }),
    },
    {
      id: 'list_company_contacts', name: 'List company contacts', description: 'List the people (contacts) linked to a company.',
      keywords: ['employees', 'people at company', 'members'],
      risk: 'read',
      input: z.object({ id: id('company'), limit }),
      output: z.looseObject({ companyId: z.string(), companyName: z.string(), total: z.number(), items: z.array(contactRow) }),
      handler: ({ id: cid, limit: lim }, ctx) => {
        const co = ctx.get('companies', cid, 'company');
        return { companyId: co.id, companyName: co.name, ...page(members(ctx, cid), lim) };
      },
      example: (ctx) => ({ id: ctx.all('companies')[0].id }),
    },
  ],

  seed(ctx, h) {
    const industries = ['Healthcare', 'Real Estate', 'Fitness', 'Marketing', 'Landscaping', 'Legal', 'Design', 'Automotive', 'Healthcare', 'Food & Beverage',
      'Construction', 'Software', 'Beauty & Wellness', 'Insurance', 'Photography', 'Consulting', 'Food & Beverage', 'Logistics', 'Beauty & Wellness', 'Security'];
    const cities = ['Austin, TX', 'Denver, CO', 'Portland, OR', 'Raleigh, NC', 'Tampa, FL'];
    const managers = ['usr_002', 'usr_003', 'usr_005', 'usr_004'];
    const slug = (n) => n.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
    h.companyNames.forEach((name, i) =>
      ctx.insert('companies', {
        name, domain: `${slug(name)}.com`, industry: industries[i], phone: `+1-555-${2000 + i * 13}`,
        address: name === 'Acme Dental' ? null : `${100 + i * 7} Main St, ${cities[i % cities.length]}`,
        accountManagerId: managers[i % managers.length], status: name === 'Ironclad Security' ? 'archived' : 'active',
        createdAt: h.daysAgo(h.int(60, 500)),
      }),
    );
    // Duplicate of Acme Dental (same phone, has the address the original lacks) for merge flows.
    ctx.insert('companies', {
      name: 'Acme Dental LLC', domain: 'acmedentalllc.com', industry: 'Healthcare', phone: '+1-555-2000', address: '12 Oak Ave, Austin, TX',
      accountManagerId: null, status: 'active', createdAt: h.daysAgo(20),
    });
    const cos = ctx.all('companies');
    // Link 42 contacts (2 per company); direct assignment keeps contacts' updatedAt unchanged.
    ctx.all('contacts').slice(0, 42).forEach((c, i) => (c.companyId = cos[i % cos.length].id));
  },
});
