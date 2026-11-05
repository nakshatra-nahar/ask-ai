import { defineModule, ops, z, id, entity, isoDate, fail } from '../kit.js';

const note = entity({
  body: z.string(), recordType: z.string().nullable(), recordId: z.string().nullable(), contactId: z.string().nullable().optional(),
  pinned: z.boolean(), authorId: z.string().nullable().optional(), revisions: z.array(z.looseObject({ body: z.string(), editedAt: z.string() })),
});
const recordType = z.string().min(1).describe('table name of the record, e.g. contacts, leads, opportunities, companies, tasks, tickets, invoices');
const MAX_PINNED = 3;

// Resolve the polymorphic target; contactId lets contact timelines pick up notes on the contact or its related records.
const target = (ctx, type, rid) => {
  const r = ctx.ref(type, rid);
  return { recordType: type, recordId: rid, contactId: type === 'contacts' ? rid : r.contactId ?? null };
};
const checkPinLimit = (ctx, n) => {
  const pinned = ctx.all('notes').filter((x) => x.pinned && x.id !== n.id && x.recordType === n.recordType && x.recordId === n.recordId);
  if (pinned.length >= MAX_PINNED)
    fail('LIMIT_EXCEEDED', `${n.recordId} already has ${MAX_PINNED} pinned notes (${pinned.map((x) => x.id).join(', ')}); unpin one first`);
};

export default defineModule({
  id: 'notes',
  code: 'M07',
  name: 'Notes',
  description: 'Record internal notes on CRM records.',
  tables: { notes: { prefix: 'nt', schema: note } },
  actions: [
    {
      id: 'create_note', name: 'Create note',
      description: 'Write an internal (never sent) note on any record — contact, lead, opportunity, company, ticket… To message a customer use SMS/email instead.',
      keywords: ['add note', 'log call notes', 'comment on contact', 'internal note'],
      ...ops.create('notes', {
        input: z.object({ recordType, recordId: id('record'), body: z.string().min(1), pinned: z.boolean().optional() }),
        build: (i, ctx) => {
          const t = target(ctx, i.recordType, i.recordId);
          if (i.pinned) checkPinLimit(ctx, t);
          return { ...t, pinned: !!i.pinned, authorId: ctx.actorId, revisions: [] };
        },
      }),
      example: (ctx) => ({ recordType: 'contacts', recordId: ctx.all('contacts')[1].id, body: 'Called — interested in the annual plan, follow up Friday.' }),
    },
    {
      id: 'get_note', name: 'Get note', description: 'Fetch one note by ID.',
      ...ops.get('notes', { what: 'note' }),
      example: (ctx) => ({ id: ctx.all('notes')[0].id }),
    },
    {
      id: 'search_notes', name: 'Search notes',
      description: 'Find internal notes by body text, attached record (recordType/recordId), contact, author, pinned flag or created date. Pinned first, then newest.',
      keywords: ['notes about', 'what did we note'],
      ...ops.search('notes', {
        text: ['body'],
        filters: {
          recordType: z.string().optional(), recordId: z.string().optional(), contactId: z.string().optional().describe('notes on this contact or its related records'),
          authorId: z.string().optional(), pinned: z.boolean().optional(), createdAtAfter: isoDate().optional(), createdAtBefore: isoDate().optional(),
        },
        sort: (a, b) => b.pinned - a.pinned || Date.parse(b.createdAt) - Date.parse(a.createdAt),
      }),
      example: () => ({ contactId: 'con_001' }),
    },
    {
      id: 'update_note', name: 'Update note', description: 'Replace a note\'s body; the previous text is kept in its revision history.',
      keywords: ['edit note'],
      risk: 'write',
      input: z.object({ id: id('note'), body: z.string().min(1) }),
      output: note,
      handler: ({ id: nid, body }, ctx) => {
        const n = ctx.get('notes', nid, 'note');
        if (n.body === body) fail('VALIDATION', 'new body is identical to the current one');
        n.revisions.push({ body: n.body, editedAt: ctx.now, editorId: ctx.actorId });
        return ctx.patch(n, { body });
      },
      example: (ctx) => ({ id: ctx.all('notes')[0].id, body: 'Updated: prefers calls after 2pm.' }),
    },
    {
      id: 'delete_note', name: 'Delete note', description: 'Permanently delete a note and its revision history.',
      keywords: ['remove note'],
      risk: 'destructive',
      input: z.object({ id: id('note') }),
      output: z.looseObject({ deleted: note }),
      handler: ({ id: nid }, ctx) => ({ deleted: ctx.remove('notes', ctx.get('notes', nid, 'note').id) }),
      example: (ctx) => ({ id: ctx.all('notes').at(-1).id }),
    },
    {
      id: 'attach_note', name: 'Attach note to record',
      description: 'Attach a note to a record (or move it from its current record to another). Moving unpins it.',
      keywords: ['move note', 'link note'],
      risk: 'write',
      input: z.object({ id: id('note'), recordType, recordId: id('record') }),
      output: note,
      handler: ({ id: nid, recordType: type, recordId }, ctx) => {
        const n = ctx.get('notes', nid, 'note');
        if (n.recordType === type && n.recordId === recordId) fail('DUPLICATE', `note ${n.id} is already attached to ${type} ${recordId}`);
        const previous = n.recordId ? { recordType: n.recordType, recordId: n.recordId } : null;
        ctx.patch(n, { ...target(ctx, type, recordId), pinned: false });
        return { ...n, previous };
      },
      example: (ctx) => ({ id: ctx.all('notes').find((n) => !n.recordId).id, recordType: 'contacts', recordId: ctx.all('contacts')[2].id }),
    },
    {
      id: 'detach_note', name: 'Detach note from record', description: 'Detach a note from its record, keeping it as a standalone note (also unpins it).',
      risk: 'write',
      input: z.object({ id: id('note') }),
      output: note,
      handler: ({ id: nid }, ctx) => {
        const n = ctx.get('notes', nid, 'note');
        if (!n.recordId) fail('INVALID_STATE', `note ${n.id} is not attached to any record`);
        const previous = { recordType: n.recordType, recordId: n.recordId };
        ctx.patch(n, { recordType: null, recordId: null, contactId: null, pinned: false });
        return { ...n, previous };
      },
      example: (ctx) => ({ id: ctx.all('notes').find((n) => n.recordId).id }),
    },
    {
      id: 'pin_note', name: 'Pin note', description: `Pin a note to the top of its record (max ${MAX_PINNED} pinned per record; note must be attached).`,
      risk: 'write',
      input: z.object({ id: id('note') }),
      output: note,
      handler: ({ id: nid }, ctx) => {
        const n = ctx.get('notes', nid, 'note');
        if (n.pinned) fail('INVALID_STATE', `note ${n.id} is already pinned`);
        if (!n.recordId) fail('INVALID_STATE', `note ${n.id} is standalone; attach it to a record before pinning`);
        checkPinLimit(ctx, n);
        return ctx.patch(n, { pinned: true });
      },
      example: (ctx) => ({ id: ctx.all('notes').find((n) => !n.pinned && n.recordId).id }),
    },
    {
      id: 'unpin_note', name: 'Unpin note', description: 'Unpin a pinned note.',
      ...ops.transition('notes', {
        field: 'pinned', to: false, what: 'note',
        guard: (n) => {
          if (!n.pinned) fail('INVALID_STATE', `note ${n.id} is not pinned`);
        },
      }),
      example: (ctx) => ({ id: ctx.all('notes').find((n) => n.pinned).id }),
    },
    {
      id: 'get_note_revisions', name: 'View note revision history', description: 'Show the edit history of a note: previous bodies, newest first, plus the current text.',
      keywords: ['note history', 'previous version'],
      risk: 'read',
      input: z.object({ id: id('note') }),
      output: z.looseObject({ noteId: z.string(), currentBody: z.string(), revisions: z.array(z.looseObject({ body: z.string(), editedAt: z.string() })) }),
      handler: ({ id: nid }, ctx) => {
        const n = ctx.get('notes', nid, 'note');
        return { noteId: n.id, currentBody: n.body, revisionCount: n.revisions.length, revisions: [...n.revisions].reverse() };
      },
      example: (ctx) => ({ id: ctx.all('notes').find((n) => n.revisions.length).id }),
    },
  ],

  seed(ctx, h) {
    const add = (recordType, recordId, body, extra = {}) => {
      const r = recordType && ctx.find(recordType, recordId);
      if (recordType && !r) return;
      ctx.insert('notes', {
        body, recordType: recordType ?? null, recordId: recordId ?? null,
        contactId: recordType === 'contacts' ? recordId : r?.contactId ?? null,
        pinned: false, authorId: h.pick(['usr_001', 'usr_002', 'usr_003', 'usr_005']), revisions: [], createdAt: h.daysAgo(h.int(1, 40)), ...extra,
      });
    };
    add('contacts', 'con_001', 'VIP — prefers phone calls before 11am. Decision maker for Acme Dental renewals.', { pinned: true, authorId: 'usr_002' });
    add('contacts', 'con_001', 'Renewal discussed; wants a multi-year discount.', {
      revisions: [{ body: 'Renewal discussed.', editedAt: h.daysAgo(5), editorId: 'usr_002' }, { body: 'Renewal discussed; asked about discounts.', editedAt: h.daysAgo(3), editorId: 'usr_002' }],
    });
    add('contacts', 'con_001', 'Sent holiday gift basket.');
    add('contacts', 'con_002', 'Came in through the Facebook lead form; asked about teeth whitening pricing.', { authorId: 'usr_003' });
    add('contacts', 'con_003', 'Possible duplicate of Mike Smith (con_004) — same phone number.', { pinned: true });
    add('contacts', 'con_005', 'Asked not to be texted or called. Email only.', { pinned: true });
    add('companies', ctx.all('companies').find((c) => c.name === 'Acme Dental')?.id, 'Account review scheduled for Q1; 3 locations.');
    add('companies', ctx.all('companies').find((c) => c.name === 'Acme Dental LLC')?.id, 'Looks like the same business as Acme Dental — confirm before merging.');
    const bodies = [
      'Left voicemail, will try again tomorrow.', 'Requested a pricing sheet.', 'Budget approved for next quarter.', 'Wants a demo with their operations manager.',
      'Competitor quote came in lower; emphasize support.', 'Follow up after the holidays.', 'Referred by an existing customer.', 'Asked for case studies.',
    ];
    ctx.all('leads').slice(0, 6).forEach((l, i) => add('leads', l.id, bodies[i % bodies.length]));
    ctx.all('opportunities').slice(0, 6).forEach((o, i) => add('opportunities', o.id, bodies[(i + 3) % bodies.length]));
    ctx.all('contacts').slice(10, 16).forEach((c, i) => add('contacts', c.id, bodies[(i + 5) % bodies.length]));
    add(null, null, 'Q4 pricing talking points: lead with annual plan, 10% off for 2-year terms.', { authorId: 'usr_001' }); // standalone
  },
});
