import { defineModule, ops, z, id, entity, fail, limit, listOf, page, textMatch } from '../kit.js';

const DIRECTORIES = ['google', 'yelp', 'bing', 'apple', 'facebook'];
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const SYNCED_FIELDS = ['name', 'address', 'phone', 'website', 'hours', 'categories'];
const STATUSES = ['draft', 'published', 'archived'];

const address = z.looseObject({
  street: z.string().optional(), city: z.string().optional(), state: z.string().optional(), postalCode: z.string().optional(), country: z.string().optional(),
});
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24h HH:MM, e.g. 09:00');
const dayHours = z.union([z.literal('closed'), z.object({ open: hhmm, close: hhmm })]);
const listing = entity({
  name: z.string(), address, phone: z.string().nullable(), website: z.string().nullable().optional(),
  hours: z.record(z.string(), z.any()), categories: z.array(z.string()), status: z.enum(STATUSES), companyId: z.string().nullable().optional(),
  syncs: z.record(z.string(), z.looseObject({ status: z.enum(['synced', 'pending', 'failed']), lastSyncedAt: z.string().nullable().optional() })),
});
// Loose E.164: strip separators, require +country code and 8-15 digits.
const phone = z.string().transform((s) => s.replace(/[\s\-().]/g, '')).refine((s) => /^\+[1-9]\d{7,14}$/.test(s), 'phone must be E.164 with country code, e.g. +15125550142');

const snapshot = (l) => structuredClone(Object.fromEntries(SYNCED_FIELDS.map((f) => [f, l[f] ?? null])));
const editable = (l) => {
  if (l.status === 'archived') fail('INVALID_STATE', `listing ${l.id} is archived; archived listings cannot be edited or published`);
};
const missingRequired = (l) => [!l.name && 'name', !(l.address?.street && l.address?.city) && 'address (street, city)', !l.phone && 'phone'].filter(Boolean);

function syncStatus(l) {
  return DIRECTORIES.map((d) => {
    const s = l.syncs?.[d];
    if (!s) return { directory: d, status: 'not_listed', lastSyncedAt: null, mismatchedFields: [] };
    const mismatchedFields = s.snapshot ? SYNCED_FIELDS.filter((f) => JSON.stringify(s.snapshot[f] ?? null) !== JSON.stringify(l[f] ?? null)) : [];
    // A synced directory with local edits since the last sync shows 'pending' until republished.
    const status = s.status === 'synced' && mismatchedFields.length ? 'pending' : s.status;
    return { directory: d, status, lastSyncedAt: s.lastSyncedAt ?? null, mismatchedFields, ...(s.failureReason ? { failureReason: s.failureReason } : {}) };
  });
}

export default defineModule({
  id: 'listings',
  code: 'M46',
  name: 'Business Listings',
  description: 'Manage business profiles in simulated directories.',
  tables: { listings: { prefix: 'lst', schema: listing } },
  actions: [
    {
      id: 'create_listing', name: 'Create business listing',
      description: 'Create a local business profile (name, address, phone, hours, categories) to publish to directories like Google Business Profile or Yelp. Not a website page or funnel.',
      keywords: ['business profile', 'google business', 'local listing', 'add location'],
      ...ops.create('listings', {
        input: z.object({
          name: z.string().min(2).max(100), address: address.optional(), phone: phone.optional(), website: z.url().optional(),
          categories: z.array(z.string().min(1)).max(10).optional(), companyId: z.string().optional(),
        }),
        check: (i, ctx) => {
          if (i.companyId) ctx.get('companies', i.companyId, 'company');
          const dup = ctx.all('listings').find((l) => l.status !== 'archived' && l.name.toLowerCase() === i.name.toLowerCase()
            && (l.address?.city || '').toLowerCase() === (i.address?.city || '').toLowerCase());
          if (dup) fail('DUPLICATE', `listing '${dup.name}' already exists for this city (${dup.id})`, { existingId: dup.id });
        },
        build: (i) => ({
          address: i.address || {}, phone: i.phone ?? null, website: i.website ?? null, categories: [...new Set(i.categories || [])],
          companyId: i.companyId ?? null, hours: {}, status: 'draft', syncs: {},
        }),
      }),
      example: () => ({ name: 'Acme Dental - Eastside', address: { street: '410 E 6th St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' }, phone: '+1 512 555 0199' }),
    },
    {
      id: 'get_listing', name: 'Get listing details', description: 'Fetch one business listing with its profile fields and per-directory sync records.',
      ...ops.get('listings', { what: 'listing' }),
      example: (ctx) => ({ id: ctx.all('listings')[0].id }),
    },
    {
      id: 'search_listings', name: 'Search business listings',
      description: 'Find business listings by name text, city, status, category, or by directory and its sync status (e.g. listings that failed on apple).',
      risk: 'read',
      input: z.object({
        query: z.string().optional().describe('free text over name, phone'), status: z.enum(STATUSES).optional(),
        category: z.string().optional().describe('category the listing must have'), city: z.string().optional(), directory: z.enum(DIRECTORIES).optional(),
        syncStatus: z.enum(['synced', 'pending', 'failed', 'not_listed']).optional().describe('with directory: status on that directory; alone: any directory'),
        limit,
      }),
      output: listOf(listing),
      handler: (i, ctx) => {
        const lc = (s) => (s || '').toLowerCase();
        const rows = ctx.all('listings').filter((l) => {
          if (!textMatch(l, ['name', 'phone'], i.query) || (i.status && l.status !== i.status) || (i.city && lc(l.address?.city) !== lc(i.city))) return false;
          if (i.category && !l.categories.some((c) => lc(c) === lc(i.category))) return false;
          const st = syncStatus(l).filter((s) => !i.directory || s.directory === i.directory);
          if (i.syncStatus) return st.some((s) => s.status === i.syncStatus);
          return !i.directory || st.some((s) => s.status !== 'not_listed');
        });
        return page(rows, i.limit);
      },
      example: () => ({ syncStatus: 'failed' }),
    },
    {
      id: 'update_listing_name', name: 'Update listing name', description: 'Rename a business listing locally (republish to push it to directories).',
      ...ops.set('listings', 'name', z.string().min(2).max(100), { what: 'listing', guard: editable }),
      example: (ctx) => ({ id: ctx.all('listings')[0].id, name: 'Acme Dental Downtown' }),
    },
    {
      id: 'update_listing_address', name: 'Update listing address', description: 'Change street, city, state, postal code, or country of a listing (merged into the current address).',
      risk: 'write',
      input: z.object({ id: id('listing'), street: z.string().min(1).optional(), city: z.string().min(1).optional(), state: z.string().optional(), postalCode: z.string().optional(), country: z.string().length(2).optional().describe('ISO country code, e.g. US') }),
      output: listing,
      handler: ({ id: lid, ...parts }, ctx) => {
        const l = ctx.get('listings', lid, 'listing');
        editable(l);
        if (!Object.keys(parts).length) fail('VALIDATION', 'provide at least one of street, city, state, postalCode, country');
        return ctx.patch(l, { address: { ...l.address, ...parts } });
      },
      example: (ctx) => ({ id: ctx.all('listings')[0].id, street: '200 Congress Ave', postalCode: '78701' }),
    },
    {
      id: 'update_listing_phone', name: 'Update listing phone', description: 'Set the public phone number on a listing; must be E.164 with country code (separators are stripped).',
      ...ops.set('listings', 'phone', phone, { what: 'listing', guard: editable }),
      example: (ctx) => ({ id: ctx.all('listings')[0].id, phone: '+1 (512) 555-0123' }),
    },
    {
      id: 'set_listing_hours', name: 'Set listing business hours',
      description: "Set opening hours per weekday (mon..sun) as {open:'09:00', close:'17:00'} or 'closed'. Days not given keep their current hours.",
      keywords: ['opening hours', 'holiday hours', 'store hours'],
      risk: 'write',
      input: z.object({ id: id('listing'), hours: z.partialRecord(z.enum(DAYS), dayHours).describe('weekday -> hours or "closed"') }),
      output: listing,
      handler: ({ id: lid, hours }, ctx) => {
        const l = ctx.get('listings', lid, 'listing');
        editable(l);
        if (!Object.keys(hours).length) fail('VALIDATION', 'provide hours for at least one weekday (mon..sun)');
        for (const [d, v] of Object.entries(hours))
          if (v !== 'closed' && v.open >= v.close) fail('VALIDATION', `${d}: open ${v.open} must be before close ${v.close}`);
        return ctx.patch(l, { hours: { ...l.hours, ...hours } });
      },
      example: (ctx) => ({ id: ctx.all('listings')[0].id, hours: { sat: { open: '10:00', close: '14:00' }, sun: 'closed' } }),
    },
    {
      id: 'set_listing_categories', name: 'Set listing categories', description: 'Replace the business categories on a listing (1-10, e.g. "Dentist", "Cosmetic Dentist").',
      ...ops.set('listings', 'categories', z.array(z.string().min(1)).min(1).max(10, 'directories accept at most 10 categories'), {
        what: 'listing', guard: editable, map: (v) => [...new Map(v.map((c) => [c.trim().toLowerCase(), c.trim()])).values()],
      }),
      example: (ctx) => ({ id: ctx.all('listings')[0].id, categories: ['Dentist', 'Cosmetic Dentist', 'Teeth Whitening'] }),
    },
    {
      id: 'publish_listing', name: 'Publish listing to simulated directory',
      description: 'Push the current listing profile to one or more directories (google, yelp, bing, apple, facebook). Requires name, address and phone. Apple rejects listings with no categories.',
      keywords: ['sync listing', 'push to google', 'list on yelp'],
      risk: 'external',
      input: z.object({ id: id('listing'), directories: z.array(z.enum(DIRECTORIES)).min(1).describe('directories to publish to') }),
      output: z.looseObject({ listing, results: z.array(z.looseObject({ directory: z.string(), status: z.string() })) }),
      handler: ({ id: lid, directories }, ctx) => {
        const l = ctx.get('listings', lid, 'listing');
        editable(l);
        const missing = missingRequired(l);
        if (missing.length) fail('VALIDATION', `listing ${l.id} is missing ${missing.join(', ')}; update it before publishing`);
        l.syncs ||= {};
        const results = [...new Set(directories)].map((d) => {
          if (d === 'apple' && !l.categories?.length) {
            l.syncs[d] = { ...l.syncs[d], status: 'failed', failureReason: 'Apple Business Connect requires at least one category; call set_listing_categories and republish', attemptedAt: ctx.now };
          } else {
            l.syncs[d] = { status: 'synced', lastSyncedAt: ctx.now, snapshot: snapshot(l) };
          }
          return { directory: d, status: l.syncs[d].status, ...(l.syncs[d].failureReason ? { failureReason: l.syncs[d].failureReason } : {}) };
        });
        ctx.patch(l, results.some((r) => r.status === 'synced') ? { status: 'published' } : {});
        return { listing: l, results };
      },
      example: (ctx) => ({ id: ctx.all('listings')[0].id, directories: ['bing'] }),
    },
    {
      id: 'get_listing_sync_status', name: 'Get listing sync status',
      description: 'Per-directory status (synced / pending / failed / not_listed) with fields edited locally since the last sync. Pending = local changes not yet republished.',
      risk: 'read',
      input: z.object({ id: id('listing') }),
      output: z.looseObject({ listingId: z.string(), directories: z.array(z.looseObject({ directory: z.string(), status: z.string(), mismatchedFields: z.array(z.string()) })) }),
      handler: ({ id: lid }, ctx) => {
        const l = ctx.get('listings', lid, 'listing');
        const directories = syncStatus(l);
        const counts = {};
        for (const d of directories) counts[d.status] = (counts[d.status] || 0) + 1;
        return { listingId: l.id, name: l.name, status: l.status, directories, counts, missingRequiredFields: missingRequired(l) };
      },
      example: (ctx) => ({ id: ctx.all('listings')[1].id }),
    },
  ],

  seed(ctx, h) {
    const companies = ctx.all('companies');
    const cities = [['Austin', 'TX', '787'], ['Denver', 'CO', '802'], ['Portland', 'OR', '972'], ['Raleigh', 'NC', '276']];
    const cats = {
      'Acme Dental': ['Dentist', 'Cosmetic Dentist'], 'BrightPath Realty': ['Real Estate Agency'], 'Summit Fitness': ['Gym', 'Personal Trainer'],
      'Greenleaf Landscaping': ['Landscaper', 'Lawn Care Service'], 'Harbor Auto Repair': ['Auto Repair Shop'], 'Evergreen Clinic': ['Medical Clinic'],
      'Urban Roast Cafe': ['Cafe', 'Coffee Shop'], 'Atlas Roofing': ['Roofing Contractor'], 'Crescent Spa': ['Day Spa', 'Massage Therapist'],
      'Maple Street Bakery': ['Bakery'], 'Sage Wellness': ['Wellness Center'], 'Northstar Legal': ['Law Firm'],
    };
    const weekday = { open: '09:00', close: '17:00' };
    const stdHours = { mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday, sat: 'closed', sun: 'closed' };
    // Fixtures: lst_001 synced on google/yelp/facebook; lst_002 renamed after google sync (pending); lst_003 no categories -> apple failed;
    // lst_004 draft missing phone (cannot publish); lst_005 archived.
    Object.keys(cats).forEach((name, i) => {
      const [city, state, zip] = cities[i % cities.length];
      const l = {
        name: i === 0 ? 'Acme Dental' : name, address: { street: `${100 + i * 17} ${['Main St', 'Oak Ave', 'Pine Rd', 'Elm St'][i % 4]}`, city, state, postalCode: `${zip}${String(10 + i).padStart(2, '0')}`, country: 'US' },
        phone: i === 3 ? null : `+1512555${String(1000 + i * 7).slice(-4)}`, website: `https://${name.toLowerCase().replace(/[^a-z]/g, '')}.test`,
        hours: i === 3 ? {} : structuredClone(stdHours), categories: i === 2 ? [] : cats[name],
        status: i === 4 ? 'archived' : i === 3 || i > 8 ? 'draft' : 'published', companyId: companies.find((c) => c.name === name)?.id ?? null, syncs: {},
        createdAt: h.daysAgo(h.int(60, 300)),
      };
      if (l.status !== 'draft') {
        const at = h.daysAgo(h.int(5, 40));
        const dirs = i === 0 ? ['google', 'yelp', 'facebook'] : i === 1 ? ['google', 'yelp'] : i === 2 ? ['google', 'bing'] : h.sample(['google', 'yelp', 'bing', 'facebook'], 2);
        for (const d of dirs) l.syncs[d] = { status: 'synced', lastSyncedAt: at, snapshot: snapshot(l) };
        if (i === 2) l.syncs.apple = { status: 'failed', failureReason: 'Apple Business Connect requires at least one category', attemptedAt: at };
        if (i === 6) l.syncs.yelp = { status: 'pending', lastSyncedAt: null, note: 'awaiting Yelp owner verification' };
      }
      if (i === 1) l.name = 'BrightPath Realty Group'; // local rename after last sync -> mismatch
      ctx.insert('listings', l);
    });
  },
});
