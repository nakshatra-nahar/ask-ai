import { defineModule, ops, z, id, entity, limit, fail, page } from '../kit.js';

const tag = entity({ name: z.string(), color: z.string(), status: z.enum(['active']) });
const COLOR = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'hex color like #1e88e5').describe('hex color, e.g. #1e88e5');
const recordType = z.string().min(1).describe('table name of the record, e.g. contacts, opportunities, products');
const tagRef = z.string().min(1).describe('tag name or tag ID');
const tagged = z.looseObject({ recordType: z.string(), recordId: z.string(), tags: z.array(z.string()) });

const lc = (s) => s.toLowerCase();
const has = (r, name) => r.tags.some((x) => lc(x) === lc(name));
const findTag = (ctx, ref) =>
  ctx.all('tags').find((t) => t.id === ref || lc(t.name) === lc(ref)) ||
  fail('NOT_FOUND', `tag '${ref}' does not exist; create it first with tags.create_tag (existing: ${ctx.all('tags').map((t) => t.name).join(', ')})`);
const dupName = (ctx, name, selfId) => {
  const d = ctx.all('tags').find((t) => t.id !== selfId && lc(t.name) === lc(name));
  if (d) fail('DUPLICATE', `tag '${d.name}' already exists (${d.id})`, { existingId: d.id });
};
// Every record in every table that carries a tags array.
const taggedRecords = (ctx) =>
  Object.entries(ctx.db.tables).flatMap(([t, rows]) => (t === 'tags' || t === 'activity' ? [] : rows.filter((r) => Array.isArray(r.tags)).map((r) => [t, r])));
const usage = (ctx, name) => taggedRecords(ctx).filter(([, r]) => has(r, name));
// Smart-list rules, campaign audiences, workflow add_tag steps and tag_added triggers reference tags by name,
// so keep them in step with renames/merges.
const retagRefs = (ctx, from, to) => {
  const same = (v) => typeof v === 'string' && lc(v) === lc(from);
  const hit = (v) => (Array.isArray(v) ? v.some(same) : same(v));
  const swap = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => (same(x) ? to : x)))] : to);
  const n = { smartListRules: 0, campaigns: 0, workflowSteps: 0, triggerConditions: 0 };
  for (const sl of ctx.all('smart_lists'))
    for (const r of sl.rules || []) if (r.field === 'tags' && hit(r.value)) (r.value = swap(r.value)), ctx.patch(sl, {}), n.smartListRules++;
  for (const c of ctx.all('campaigns')) if (hit(c.audience?.tags)) (c.audience.tags = swap(c.audience.tags)), ctx.patch(c, {}), n.campaigns++;
  for (const w of ctx.all('workflows'))
    for (const s of w.steps || []) if (s.type === 'add_tag' && hit(s.config?.tag)) (s.config.tag = swap(s.config.tag)), ctx.patch(w, {}), n.workflowSteps++;
  for (const t of ctx.all('triggers'))
    for (const c of t.conditions || []) if (c.field === 'tag' && hit(c.value)) (c.value = swap(c.value)), ctx.patch(t, {}), n.triggerConditions++;
  return n;
};
const byTable = (hits) => hits.reduce((a, [t]) => ((a[t] = (a[t] || 0) + 1), a), {});

export default defineModule({
  id: 'tags',
  code: 'M08',
  name: 'Tags',
  description: 'Label and organize records with tags.',
  tables: { tags: { prefix: 'tag', schema: tag } },
  actions: [
    {
      id: 'create_tag', name: 'Create tag', description: 'Define a new tag (name + color) so it can be applied to records. Names are case-insensitively unique.',
      keywords: ['new label'],
      ...ops.create('tags', {
        input: z.object({ name: z.string().trim().min(1).max(40), color: COLOR.optional() }),
        check: (i, ctx) => dupName(ctx, i.name),
        build: (i) => ({ color: i.color || '#607d8b', status: 'active' }),
      }),
      example: () => ({ name: 'hot-lead', color: '#e53935' }),
    },
    {
      id: 'list_tags', name: 'List tags', description: 'List defined tags (name, color). For how often each is used, see tags.get_tag_usage.',
      ...ops.search('tags', { text: ['name'] }),
      example: () => ({}),
    },
    {
      id: 'rename_tag', name: 'Rename tag', description: 'Rename a tag everywhere: the tag definition, every record (contacts, etc.) that carries it, and smart-list rules, campaign audiences, workflow add-tag steps and tag-added triggers that reference it.',
      risk: 'write',
      input: z.object({ id: id('tag'), name: z.string().trim().min(1).max(40) }),
      output: tag,
      handler: ({ id: tid, name }, ctx) => {
        const t = ctx.get('tags', tid, 'tag');
        dupName(ctx, name, t.id);
        const hits = usage(ctx, t.name);
        for (const [, r] of hits) ctx.patch(r, { tags: r.tags.map((x) => (lc(x) === lc(t.name) ? name : x)) });
        const previousName = t.name;
        const refs = retagRefs(ctx, previousName, name);
        ctx.patch(t, { name });
        return { ...t, previousName, recordsUpdated: hits.length, smartListRulesUpdated: refs.smartListRules, referencesUpdated: refs };
      },
      example: (ctx) => ({ id: ctx.all('tags').find((t) => t.name === 'newsletter').id, name: 'newsletter-subscriber' }),
    },
    {
      id: 'set_tag_color', name: 'Set tag color', description: 'Change the display color of a tag.',
      ...ops.set('tags', 'color', COLOR, { what: 'tag' }),
      example: (ctx) => ({ id: ctx.all('tags')[0].id, color: '#ff9800' }),
    },
    {
      id: 'delete_tag', name: 'Delete unused tag',
      description: 'Permanently delete a tag definition. Fails with CONFLICT if any record still carries it; remove it from those records or merge it into another tag first.',
      keywords: ['remove tag definition'],
      risk: 'destructive',
      input: z.object({ id: id('tag') }),
      output: z.looseObject({ deleted: tag }),
      handler: ({ id: tid }, ctx) => {
        const t = ctx.get('tags', tid, 'tag');
        const hits = usage(ctx, t.name);
        if (hits.length)
          fail('CONFLICT', `tag '${t.name}' is still used on ${hits.length} records (${JSON.stringify(byTable(hits))}); remove it from them or use tags.merge_tags`);
        return { deleted: ctx.remove('tags', t.id) };
      },
      example: (ctx) => ({ id: ctx.all('tags').find((t) => t.name === 'cold').id }),
    },
    {
      id: 'apply_tag', name: 'Apply tag to record',
      description: 'Add an existing tag to a record (contact, opportunity, …). The tag must already exist (tags.create_tag).',
      keywords: ['tag contact', 'label record', 'add tag'],
      risk: 'write',
      input: z.object({ tag: tagRef, recordType, recordId: id('record') }),
      output: tagged,
      handler: ({ tag: ref, recordType: type, recordId }, ctx) => {
        const t = findTag(ctx, ref);
        const r = ctx.ref(type, recordId);
        if (['tags', 'activity'].includes(type)) fail('VALIDATION', `records in ${type} cannot be tagged`);
        if (r.tags && has(r, t.name)) fail('DUPLICATE', `${recordId} already has tag '${t.name}'`);
        ctx.patch(r, { tags: [...(r.tags || []), t.name] });
        return { recordType: type, recordId, tags: r.tags, tag: t };
      },
      example: () => ({ tag: 'vip', recordType: 'contacts', recordId: 'con_002' }),
    },
    {
      id: 'remove_tag_from_record', name: 'Remove tag from record', description: 'Take a tag off one record. The tag definition is kept.',
      keywords: ['untag'],
      risk: 'write',
      input: z.object({ tag: tagRef, recordType, recordId: id('record') }),
      output: tagged,
      handler: ({ tag: ref, recordType: type, recordId }, ctx) => {
        const name = ctx.all('tags').find((t) => t.id === ref)?.name ?? ref;
        const r = ctx.ref(type, recordId);
        if (!r.tags || !has(r, name)) fail('NOT_FOUND', `${recordId} does not have tag '${name}' (its tags: ${(r.tags || []).join(', ') || 'none'})`);
        ctx.patch(r, { tags: r.tags.filter((x) => lc(x) !== lc(name)) });
        return { recordType: type, recordId, tags: r.tags };
      },
      example: () => ({ tag: 'vip', recordType: 'contacts', recordId: 'con_001' }),
    },
    {
      id: 'list_records_with_tag', name: 'List records with tag', description: 'List every record (any table, or one recordType) that carries a tag.',
      keywords: ['who is tagged', 'tagged contacts'],
      risk: 'read',
      input: z.object({ tag: tagRef, recordType: recordType.optional(), limit }),
      output: z.looseObject({ tag: z.string(), total: z.number(), items: z.array(z.looseObject({ recordType: z.string(), id: z.string() })) }),
      handler: ({ tag: ref, recordType: type, limit: lim }, ctx) => {
        const name = findTag(ctx, ref).name;
        const items = usage(ctx, name)
          .filter(([t]) => !type || t === type)
          .map(([t, r]) => ({ recordType: t, id: r.id, name: r.name ?? r.title ?? r.subject ?? null, status: r.status ?? null }));
        return { tag: name, byTable: byTable(items.map((x) => [x.recordType])), ...page(items, lim) };
      },
      example: () => ({ tag: 'vip' }),
    },
    {
      id: 'merge_tags', name: 'Merge tags',
      description: 'Merge one tag into another: every record (and smart list, campaign audience, workflow, trigger) using the source tag gets the target tag instead, then the source tag is deleted.',
      keywords: ['combine tags', 'dedupe tags'],
      risk: 'destructive',
      input: z.object({ fromTagId: id('source tag (deleted)'), intoTagId: id('target tag (kept)') }),
      output: z.looseObject({ target: tag, recordsUpdated: z.number() }),
      handler: ({ fromTagId, intoTagId }, ctx) => {
        if (fromTagId === intoTagId) fail('VALIDATION', 'fromTagId and intoTagId must differ');
        const s = ctx.get('tags', fromTagId, 'source tag');
        const t = ctx.get('tags', intoTagId, 'target tag');
        const hits = usage(ctx, s.name);
        for (const [, r] of hits) ctx.patch(r, { tags: [...new Set(r.tags.map((x) => (lc(x) === lc(s.name) ? t.name : x)))] });
        const refs = retagRefs(ctx, s.name, t.name);
        ctx.remove('tags', s.id);
        return { target: t, mergedTag: s, recordsUpdated: hits.length, smartListRulesUpdated: refs.smartListRules, referencesUpdated: refs };
      },
      example: (ctx) => ({ fromTagId: ctx.all('tags').find((t) => t.name === 'lead').id, intoTagId: ctx.all('tags').find((t) => t.name === 'prospect').id }),
    },
    {
      id: 'get_tag_usage', name: 'View tag usage counts',
      description: 'How many records carry each tag (total and per table), most used first. Also lists tag names found on records that have no tag definition.',
      keywords: ['tag stats', 'tag report'],
      risk: 'read',
      input: z.object({ recordType: recordType.optional().describe('only count this table') }),
      output: z.looseObject({ total: z.number(), items: z.array(z.looseObject({ id: z.string(), name: z.string(), count: z.number() })) }),
      handler: ({ recordType: type }, ctx) => {
        const recs = taggedRecords(ctx).filter(([t]) => !type || t === type);
        const defs = ctx.all('tags');
        const items = defs
          .map((t) => {
            const hits = recs.filter(([, r]) => has(r, t.name));
            return { id: t.id, name: t.name, color: t.color, count: hits.length, byTable: byTable(hits) };
          })
          .sort((a, b) => b.count - a.count);
        const known = new Set(defs.map((t) => lc(t.name)));
        const undefinedTags = [...new Set(recs.flatMap(([, r]) => r.tags).filter((x) => !known.has(lc(x))))];
        return { total: items.length, items, undefinedTags };
      },
      example: () => ({}),
    },
  ],

  seed(ctx, h) {
    const rows = [
      ['vip', '#d4af37'], ['customer', '#2e7d32'], ['lead', '#1565c0'], ['newsletter', '#6a1b9a'],
      ['prospect', '#0288d1'], ['cold', '#90a4ae'], ['webinar-2025', '#ff7043'], // last three unused at seed time
    ];
    for (const [name, color] of rows) ctx.insert('tags', { name, color, status: 'active', createdAt: h.daysAgo(h.int(90, 400)) });
  },
});
