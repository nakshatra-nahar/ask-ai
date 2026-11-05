import { defineModule, ops, z, id, entity, fail, round2 } from '../kit.js';

const stage = z.looseObject({ id: z.string(), name: z.string(), probability: z.number(), order: z.number() });
const pipeline = entity({ name: z.string(), status: z.enum(['active', 'archived']), stages: z.array(stage), isDefault: z.boolean() });
const prob = z.number().int().min(0).max(100).describe('win probability percent 0-100');

const activeP = (p) => {
  if (p.status !== 'active') fail('INVALID_STATE', `pipeline ${p.id} (${p.name}) is archived; only active pipelines can be changed`);
};
const findStage = (p, sid) =>
  p.stages.find((s) => s.id === sid) ||
  fail('NOT_FOUND', `stage ${sid} not found on pipeline ${p.id}; stages: ${p.stages.map((s) => `${s.id} ${s.name}`).join(', ')}`);
const dupName = (ctx, name, selfId) => {
  const d = ctx.all('pipelines').find((p) => p.id !== selfId && p.name.toLowerCase() === name.toLowerCase());
  if (d) fail('DUPLICATE', `a pipeline named '${name}' already exists (${d.id})`);
};
const dupStage = (p, name, selfId) => {
  if (p.stages.some((s) => s.id !== selfId && s.name.toLowerCase() === name.toLowerCase()))
    fail('DUPLICATE', `pipeline ${p.name} already has a stage named '${name}'`);
};
const renumber = (p) => p.stages.forEach((s, i) => (s.order = i + 1));
const openIn = (ctx, pid, sid) => ctx.all('opportunities').filter((o) => o.pipelineId === pid && o.status === 'open' && (!sid || o.stageId === sid));
const reorder = ops.reorder('pipelines', 'stages', { what: 'pipeline' });

export default defineModule({
  id: 'pipelines',
  code: 'M05',
  name: 'Pipelines',
  description: 'Configure sales pipelines and their ordered stages.',
  tables: { pipelines: { prefix: 'pl', schema: pipeline } },
  actions: [
    {
      id: 'create_pipeline', name: 'Create pipeline',
      description: 'Create a new sales pipeline with an ordered list of stages. Pipeline configuration only; to create a deal use opportunities.create_opportunity.',
      keywords: ['new pipeline', 'sales process', 'deal stages'],
      ...ops.create('pipelines', {
        input: z.object({
          name: z.string().min(1),
          stages: z.array(z.object({ name: z.string().min(1), probability: prob.optional() })).min(1).describe('stages in order; probability defaults to evenly spaced'),
        }),
        check: (i, ctx) => {
          dupName(ctx, i.name);
          const names = i.stages.map((s) => s.name.toLowerCase());
          if (new Set(names).size !== names.length) fail('VALIDATION', 'stage names must be unique within a pipeline');
        },
        build: (i, ctx) => ({
          status: 'active', isDefault: false,
          stages: i.stages.map((s, k) => ({ id: ctx.newId('stg'), name: s.name, probability: s.probability ?? Math.round(((k + 1) / (i.stages.length + 1)) * 100), order: k + 1 })),
        }),
      }),
      example: () => ({ name: 'Enterprise Deals', stages: [{ name: 'Discovery', probability: 15 }, { name: 'Demo' }, { name: 'Contract', probability: 85 }] }),
    },
    {
      id: 'get_pipeline', name: 'Get pipeline configuration',
      description: 'Fetch one pipeline with its ordered stages (ids, names, win probabilities) plus open-opportunity count and value per stage. Use to find stage IDs.',
      keywords: ['stages', 'pipeline stages', 'stage ids'],
      risk: 'read',
      input: z.object({ id: id('pipeline') }),
      output: pipeline,
      handler: ({ id: pid }, ctx) => {
        const p = ctx.get('pipelines', pid, 'pipeline');
        const open = openIn(ctx, pid);
        return {
          ...p,
          stages: p.stages.map((s) => {
            const o = open.filter((x) => x.stageId === s.id);
            return { ...s, openCount: o.length, openValue: round2(o.reduce((a, x) => a + (x.value || 0), 0)) };
          }),
        };
      },
      example: (ctx) => ({ id: ctx.all('pipelines')[0].id }),
    },
    {
      id: 'list_pipelines', name: 'List pipelines',
      description: 'List sales pipelines (name, default flag, status, stages). Archived pipelines included unless status is given.',
      ...ops.search('pipelines', { text: ['name'], filters: { status: z.enum(['active', 'archived']).optional(), isDefault: z.boolean().optional() } }),
      example: () => ({}),
    },
    {
      id: 'rename_pipeline', name: 'Rename pipeline', description: 'Rename an active pipeline. Names must be unique.',
      ...ops.set('pipelines', 'name', z.string().min(1), {
        what: 'pipeline',
        guard: (p, i, ctx) => {
          activeP(p);
          dupName(ctx, i.name, p.id);
        },
      }),
      example: (ctx) => ({ id: ctx.all('pipelines').find((p) => p.name === 'Partnerships').id, name: 'Partner Channel' }),
    },
    {
      id: 'archive_pipeline', name: 'Archive pipeline',
      description: 'Archive an active pipeline. Not allowed for the default pipeline or while it still has open opportunities.',
      ...ops.transition('pipelines', {
        to: 'archived', from: ['active'], risk: 'destructive', what: 'pipeline',
        guard: (p, i, ctx) => {
          if (p.isDefault) fail('INVALID_STATE', `${p.name} is the default pipeline and cannot be archived`);
          const open = openIn(ctx, p.id);
          if (open.length) fail('CONFLICT', `${p.name} has ${open.length} open opportunities (${open.slice(0, 5).map((o) => o.id).join(', ')}); close or move them first`);
        },
      }),
      example: (ctx) => ({ id: ctx.all('pipelines').find((p) => p.name === 'Referral Program').id }),
    },
    {
      id: 'add_pipeline_stage', name: 'Add pipeline stage', description: 'Add a new stage to a pipeline, at the end or at a 1-based position.',
      risk: 'write',
      input: z.object({
        id: id('pipeline'), name: z.string().min(1), probability: prob.optional(),
        position: z.number().int().min(1).optional().describe('1-based position; default appends at the end'),
      }),
      output: pipeline,
      handler: ({ id: pid, name, probability, position }, ctx) => {
        const p = ctx.get('pipelines', pid, 'pipeline');
        activeP(p);
        dupStage(p, name);
        const added = { id: ctx.newId('stg'), name, probability: probability ?? p.stages.at(-1)?.probability ?? 50, order: 0 };
        p.stages.splice(position ? position - 1 : p.stages.length, 0, added);
        renumber(p);
        return { ...ctx.patch(p, {}), added };
      },
      example: (ctx) => ({ id: ctx.all('pipelines')[0].id, name: 'Demo Scheduled', probability: 50, position: 4 }),
    },
    {
      id: 'rename_pipeline_stage', name: 'Rename pipeline stage', description: 'Rename one stage of a pipeline (stage names unique per pipeline).',
      risk: 'write',
      input: z.object({ id: id('pipeline'), stageId: id('stage'), name: z.string().min(1) }),
      output: pipeline,
      handler: ({ id: pid, stageId, name }, ctx) => {
        const p = ctx.get('pipelines', pid, 'pipeline');
        activeP(p);
        const s = findStage(p, stageId);
        dupStage(p, name, s.id);
        s.name = name;
        return ctx.patch(p, {});
      },
      example: (ctx) => {
        const p = ctx.all('pipelines')[0];
        return { id: p.id, stageId: p.stages[1].id, name: 'First Contact Made' };
      },
    },
    {
      id: 'reorder_pipeline_stages', name: 'Reorder pipeline stages', description: 'Set the order of all stages in a pipeline by passing every stage ID in the new order.',
      ...reorder,
      handler: (i, ctx) => {
        activeP(ctx.get('pipelines', i.id, 'pipeline'));
        const p = reorder.handler(i, ctx);
        renumber(p);
        return p;
      },
      example: (ctx) => {
        const ids = ctx.all('pipelines')[0].stages.map((s) => s.id);
        return { id: ctx.all('pipelines')[0].id, orderedIds: [...ids.slice(0, 3), ids[4], ids[3]] };
      },
    },
    {
      id: 'remove_pipeline_stage', name: 'Remove empty pipeline stage',
      description: 'Delete a stage from a pipeline. Fails with CONFLICT if any open opportunity sits in it; move those first with opportunities.move_opportunity_to_stage.',
      keywords: ['delete stage'],
      risk: 'destructive',
      input: z.object({ id: id('pipeline'), stageId: id('stage') }),
      output: pipeline,
      handler: ({ id: pid, stageId }, ctx) => {
        const p = ctx.get('pipelines', pid, 'pipeline');
        activeP(p);
        const s = findStage(p, stageId);
        const open = openIn(ctx, p.id, s.id);
        if (open.length)
          fail('CONFLICT', `stage '${s.name}' has ${open.length} open opportunities (${open.slice(0, 5).map((o) => o.id).join(', ')}); move them to another stage first`);
        if (p.stages.length === 1) fail('INVALID_STATE', 'a pipeline must keep at least one stage');
        p.stages = p.stages.filter((x) => x !== s);
        renumber(p);
        return { ...ctx.patch(p, {}), removed: s };
      },
      example: (ctx) => {
        const p = ctx.all('pipelines').find((x) => x.name === 'Partnerships');
        return { id: p.id, stageId: p.stages.find((s) => s.name === 'On Hold').id };
      },
    },
    {
      id: 'set_stage_probability', name: 'Set stage win probability', description: 'Set the win probability (0-100%) used for forecasting on one pipeline stage.',
      keywords: ['forecast', 'weighting'],
      risk: 'write',
      input: z.object({ id: id('pipeline'), stageId: id('stage'), probability: prob }),
      output: pipeline,
      handler: ({ id: pid, stageId, probability }, ctx) => {
        const p = ctx.get('pipelines', pid, 'pipeline');
        activeP(p);
        findStage(p, stageId).probability = probability;
        return ctx.patch(p, {});
      },
      example: (ctx) => {
        const p = ctx.all('pipelines')[0];
        return { id: p.id, stageId: p.stages[3].id, probability: 65 };
      },
    },
  ],

  seed(ctx, h) {
    const mk = (name, stages, extra = {}) =>
      ctx.insert('pipelines', {
        name, status: 'active', isDefault: false, createdAt: h.daysAgo(h.int(200, 500)),
        stages: stages.map(([n, p], i) => ({ id: ctx.newId('stg'), name: n, probability: p, order: i + 1 })), ...extra,
      });
    mk('Sales Pipeline', [['New Lead', 10], ['Contacted', 20], ['Qualified', 40], ['Proposal Sent', 60], ['Negotiation', 80]], { isDefault: true });
    mk('Partnerships', [['Intro Call', 20], ['Evaluation', 50], ['Contract Review', 80], ['On Hold', 5]]); // On Hold stays empty
    mk('Referral Program', [['Referred', 30], ['Meeting Booked', 60]]); // no open deals -> archivable
    mk('Legacy Pipeline 2024', [['Open', 25], ['Closing', 75]], { status: 'archived' });
  },
});
