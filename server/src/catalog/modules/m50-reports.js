import { defineModule, ops, z, id, entity, isoDate, fail, matchFilters, toTime, addDays, round2 } from '../kit.js';

const PRESETS = ['last_7_days', 'last_30_days', 'this_month', 'last_month', 'this_quarter'];
const GROUPS = ['none', 'day', 'week', 'month', 'source', 'owner', 'status', 'channel'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const isOpenInvoice = (r) => ['sent', 'partially_paid'].includes(r.status);
const count = (rs) => rs.length;
const sum = (f) => (rs) => rs.reduce((s, r) => s + (Number(r[f]) || 0), 0);
const avg = (f) => (rs) => (rs.length ? sum(f)(rs) / rs.length : null);

// Every metric is computed live from its source table. `date` = field the date range applies to; `dims` = groupBy -> record field.
const METRICS = {
  leads_created: { table: 'leads', date: 'createdAt', unit: 'count', agg: count, dims: { source: 'source', owner: 'ownerId', status: 'status' }, fields: ['source', 'status', 'ownerId', 'campaignId', 'scoreMin', 'scoreMax'] },
  deals_won: { table: 'opportunities', date: 'closedAt', unit: 'count', agg: count, where: (r) => r.status === 'won', dims: { owner: 'ownerId' }, fields: ['pipelineId', 'ownerId', 'companyId', 'currency', 'valueMin', 'valueMax'] },
  pipeline_value: { table: 'opportunities', date: 'createdAt', unit: 'currency', agg: sum('value'), where: (r) => r.status === 'open', dims: { owner: 'ownerId' }, fields: ['pipelineId', 'stageId', 'ownerId', 'companyId', 'currency', 'valueMin', 'valueMax'] },
  revenue_collected: { table: 'payments', date: 'paidAt', unit: 'currency', agg: (rs) => rs.reduce((s, r) => s + (Number(r.amount) || 0) - (Number(r.refundedAmount) || 0), 0), /* net of refunds */ where: (r) => ['succeeded', 'partially_refunded'].includes(r.status), dims: { channel: 'method' }, fields: ['method', 'currency', 'contactId', 'invoiceId', 'amountMin', 'amountMax'] },
  invoices_overdue: { table: 'invoices', date: 'dueDate', unit: 'currency', agg: sum('balance'), where: (r, now) => isOpenInvoice(r) && toTime(r.dueDate, true) < Date.parse(now), dims: { status: 'status' }, fields: ['status', 'contactId', 'currency', 'balanceMin', 'balanceMax'] },
  appointments_booked: { table: 'appointments', date: 'createdAt', unit: 'count', agg: count, dims: { owner: 'hostUserId', status: 'status' }, fields: ['calendarId', 'hostUserId', 'status', 'contactId'] },
  no_show_rate: {
    table: 'appointments', date: 'startAt', unit: 'percent', where: (r, now) => ['completed', 'no_show'].includes(r.status) && Date.parse(r.startAt) <= Date.parse(now),
    agg: (rs) => (rs.length ? (rs.filter((r) => r.status === 'no_show').length / rs.length) * 100 : null), dims: { owner: 'hostUserId' }, fields: ['calendarId', 'hostUserId', 'contactId'],
  },
  tickets_opened: { table: 'tickets', date: 'createdAt', unit: 'count', agg: count, dims: { owner: 'ownerId', status: 'status', channel: 'channel' }, fields: ['status', 'priority', 'ownerId', 'contactId', 'channel'] },
  avg_review_rating: { table: 'reviews', date: 'postedAt', unit: 'stars', agg: avg('rating'), dims: { source: 'platform', channel: 'platform' }, fields: ['platform', 'rating', 'ratingMin', 'ratingMax', 'responded', 'contactId'] },
  messages_sent: { table: 'messages', date: 'sentAt', unit: 'count', agg: count, where: (r) => r.direction === 'outbound' && ['sent', 'delivered'].includes(r.status), dims: { channel: 'channel', status: 'status' }, fields: ['channel', 'purpose', 'status', 'templateId', 'contactId'] },
};
const METRIC_IDS = Object.keys(METRICS);

const dateRange = z.union([
  z.object({ preset: z.enum(PRESETS) }),
  z.object({ from: isoDate('start date YYYY-MM-DD'), to: isoDate('end date YYYY-MM-DD (inclusive)') }),
]).describe('either {preset} or {from, to}');
const filterValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
const filters = z.record(z.string(), filterValue).describe("equality filters on the metric's source fields, e.g. {source:'facebook'}; *Min/*Max for numbers");
const schedule = z.looseObject({ frequency: z.enum(['daily', 'weekly', 'monthly']), recipients: z.array(z.string()), dayOfWeek: z.string().nullable().optional(), nextRunAt: z.string() });
const report = entity({
  name: z.string(), metric: z.enum(METRIC_IDS), filters: z.record(z.string(), z.any()), dateRange: z.looseObject({}),
  groupBy: z.enum(GROUPS), schedule: schedule.nullable(),
});
const exportRow = entity({ reportId: z.string(), format: z.enum(['csv', 'json']), fileName: z.string(), content: z.string(), rowCount: z.number(), total: z.number().nullable() });
const resultRow = z.looseObject({ group: z.string(), value: z.number().nullable(), count: z.number() });
const result = z.looseObject({ metric: z.string(), unit: z.string(), dateRange: z.looseObject({ from: z.string(), to: z.string() }), groupBy: z.string(), rows: z.array(resultRow), total: z.number().nullable() });

const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const round = (n) => (n == null ? null : round2(n));

function resolveRange(ctx, r) {
  const [y, m] = ctx.today.split('-').map(Number);
  const utc = (yy, mm, dd) => ymd(Date.UTC(yy, mm, dd));
  if (r.preset) {
    const q = Math.floor((m - 1) / 3) * 3;
    const ranges = {
      last_7_days: [addDays(ctx.today, -6).slice(0, 10), ctx.today], last_30_days: [addDays(ctx.today, -29).slice(0, 10), ctx.today],
      this_month: [utc(y, m - 1, 1), utc(y, m, 0)], last_month: [utc(y, m - 2, 1), utc(y, m - 1, 0)], this_quarter: [utc(y, q, 1), utc(y, q + 3, 0)],
    };
    const [from, to] = ranges[r.preset];
    return { preset: r.preset, from, to };
  }
  const from = r.from.slice(0, 10), to = r.to.slice(0, 10);
  if (from > to) fail('VALIDATION', `dateRange.from ${from} is after dateRange.to ${to}`);
  return { from, to };
}

function checkSpec(metric, groupBy = 'none', f = {}) {
  const M = METRICS[metric];
  if (!['none', 'day', 'week', 'month'].includes(groupBy) && !M.dims[groupBy])
    fail('VALIDATION', `metric ${metric} cannot be grouped by '${groupBy}'; allowed: none, day, week, month${Object.keys(M.dims).map((d) => ', ' + d).join('')}`);
  const bad = Object.keys(f).filter((k) => !M.fields.includes(k));
  if (bad.length) fail('VALIDATION', `unknown filter field(s) ${bad.join(', ')} for metric ${metric} (table ${M.table}); allowed: ${M.fields.join(', ')}`);
}

function bucket(dateVal, groupBy) {
  const d = new Date(toTime(dateVal));
  if (groupBy === 'day') return ymd(d);
  if (groupBy === 'month') return ymd(d).slice(0, 7);
  return ymd(d.getTime() - ((d.getUTCDay() + 6) % 7) * 864e5); // week starting Monday
}

/** Run a metric over a resolved range. Pure read: never mutates. */
function compute(ctx, { metric, dateRange: dr, groupBy = 'none', filters: f = {} }, range = resolveRange(ctx, dr)) {
  const M = METRICS[metric];
  checkSpec(metric, groupBy, f);
  const lo = toTime(range.from), hi = toTime(range.to, true);
  const rows = ctx.all(M.table).filter((r) => {
    const t = r[M.date] && toTime(r[M.date]);
    return t && t >= lo && t <= hi && (!M.where || M.where(r, ctx.now)) && matchFilters(r, f);
  });
  const groups = new Map();
  if (groupBy !== 'none') {
    for (const r of rows) {
      const key = ['day', 'week', 'month'].includes(groupBy) ? bucket(r[M.date], groupBy) : String(r[M.dims[groupBy]] ?? (groupBy === 'owner' ? 'unassigned' : 'unknown'));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
  }
  const out = [...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([group, rs]) => ({
    group, ...(groupBy === 'owner' && ctx.find('users', group) ? { label: ctx.find('users', group).name } : {}), value: round(M.agg(rs)), count: rs.length,
  }));
  if (groupBy !== 'none' && !['day', 'week', 'month'].includes(groupBy)) out.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  return {
    metric, unit: M.unit, dateRange: range, groupBy, filters: f, rows: out, total: round(M.agg(rows)), recordCount: rows.length,
    ...(ctx.db.tables[M.table] ? {} : { note: `no '${M.table}' data in this workspace yet` }),
  };
}

/** Resolve run/compare input: a saved report (with optional overrides) or an ad-hoc metric. */
function specFrom(i, ctx) {
  const base = i.id ? ctx.get('reports', i.id, 'report') : null;
  return {
    report: base, metric: i.metric || base.metric, dateRange: i.dateRange || base?.dateRange || { preset: 'last_30_days' },
    groupBy: i.groupBy || base?.groupBy || 'none', filters: i.filters || base?.filters || {},
  };
}
const runInput = z.object({
  id: z.string().optional().describe('saved report ID; omit to run an ad-hoc metric'), metric: z.enum(METRIC_IDS).optional().describe('required when no id'),
  dateRange: dateRange.optional().describe('override; default report range or last_30_days'), groupBy: z.enum(GROUPS).optional(), filters: filters.optional(),
}).refine((o) => o.id || o.metric, 'provide a saved report id or a metric');

function nextRun(ctx, frequency, dayOfWeek) {
  for (let i = 0; i <= 31; i++) {
    const d = new Date(Date.parse(`${ctx.today}T08:00:00Z`) + i * 864e5);
    if (d.getTime() <= Date.parse(ctx.now)) continue;
    if (frequency === 'daily' || (frequency === 'weekly' && DAYS[d.getUTCDay()] === dayOfWeek) || (frequency === 'monthly' && d.getUTCDate() === 1)) return d.toISOString();
  }
}

export default defineModule({
  id: 'reports',
  code: 'M50',
  name: 'Reports',
  description: 'Query business metrics and manage saved reports.',
  tables: { reports: { prefix: 'rpt', schema: report }, report_exports: { prefix: 'rexp', schema: exportRow } },
  actions: [
    {
      id: 'create_report', name: 'Create saved report',
      description: `Save a reusable cross-module business report: one metric (${METRIC_IDS.join(', ')}) with filters, date range, and grouping.`,
      keywords: ['new report', 'save report', 'custom report'],
      ...ops.create('reports', {
        input: z.object({
          name: z.string().min(2).max(120), metric: z.enum(METRIC_IDS), dateRange: dateRange.default({ preset: 'last_30_days' }),
          groupBy: z.enum(GROUPS).default('none'), filters: filters.default({}), description: z.string().optional(),
        }),
        check: (i, ctx) => {
          const dup = ctx.all('reports').find((r) => r.name.toLowerCase() === i.name.toLowerCase());
          if (dup) fail('DUPLICATE', `a report named '${i.name}' already exists (${dup.id})`, { existingId: dup.id });
          checkSpec(i.metric, i.groupBy, i.filters);
          if (i.dateRange.from) resolveRange(ctx, i.dateRange);
        },
        build: () => ({ schedule: null }),
      }),
      example: () => ({ name: 'Facebook Leads This Month', metric: 'leads_created', dateRange: { preset: 'this_month' }, groupBy: 'week', filters: { source: 'facebook' } }),
    },
    {
      id: 'get_report', name: 'Get report definition', description: 'Fetch a saved report definition (metric, filters, date range, grouping, schedule) without running it.',
      ...ops.get('reports', { what: 'report' }),
      example: (ctx) => ({ id: ctx.all('reports')[0].id }),
    },
    {
      id: 'list_reports', name: 'List saved reports', description: 'List saved reports, optionally by metric, name text, or whether they have a delivery schedule.',
      ...ops.search('reports', {
        text: ['name', 'description'],
        filters: { metric: z.enum(METRIC_IDS).optional(), schedule: z.boolean().optional().describe('true = only scheduled reports') },
      }),
      example: () => ({}),
    },
    {
      id: 'update_report_filters', name: 'Update report filters',
      description: "Replace a saved report's filters ({} clears them). Keys must be fields of the metric's source table, e.g. leads_created: source, status, ownerId.",
      risk: 'write',
      input: z.object({ id: id('report'), filters }),
      output: report,
      handler: ({ id: rid, filters: f }, ctx) => {
        const r = ctx.get('reports', rid, 'report');
        checkSpec(r.metric, r.groupBy, f);
        return ctx.patch(r, { filters: f });
      },
      example: (ctx) => ({ id: ctx.all('reports').find((r) => r.metric === 'leads_created').id, filters: { source: ['facebook', 'google_ads'] } }),
    },
    {
      id: 'set_report_date_range', name: 'Set report date range',
      description: 'Set the saved date range of a report: a preset (last_7_days, last_30_days, this_month, last_month, this_quarter) or explicit from/to dates.',
      ...ops.set('reports', 'dateRange', dateRange, {
        what: 'report', guard: (r, i, ctx) => resolveRange(ctx, i.dateRange),
      }),
      example: (ctx) => ({ id: ctx.all('reports')[0].id, dateRange: { preset: 'last_month' } }),
    },
    {
      id: 'set_report_grouping', name: 'Set report grouping', description: 'Set how a saved report breaks down its results: none, day, week, month, source, owner, status, or channel (must suit the metric).',
      ...ops.set('reports', 'groupBy', z.enum(GROUPS), { what: 'report', guard: (r, i) => checkSpec(r.metric, i.groupBy, r.filters) }),
      example: (ctx) => ({ id: ctx.all('reports')[0].id, groupBy: 'owner' }),
    },
    {
      id: 'run_report', name: 'Run report',
      description: 'Compute a business metric live across modules (leads, deals, revenue, overdue invoices, appointments, no-shows, tickets, ratings, messages) for a saved report or ad-hoc metric. Returns grouped rows and total. Use this for cross-module KPIs, not campaign- or funnel-specific stats.',
      keywords: ['metrics', 'kpi', 'how many', 'analytics', 'dashboard numbers', 'revenue this month'],
      risk: 'read',
      input: runInput,
      output: result,
      handler: (i, ctx) => {
        const s = specFrom(i, ctx);
        return { ...(s.report ? { reportId: s.report.id, name: s.report.name } : {}), ...compute(ctx, s) };
      },
      example: (ctx) => ({ id: ctx.all('reports')[0].id }),
    },
    {
      id: 'compare_report_periods', name: 'Compare report periods',
      description: 'Compare a saved report or ad-hoc metric for its date range against the immediately preceding period (previous calendar month/quarter for the this_month, last_month and this_quarter presets; otherwise the same number of days): values, delta, and % change (per group when grouped by a dimension).',
      keywords: ['period over period', 'vs last month', 'growth', 'trend'],
      risk: 'read',
      input: runInput,
      output: z.looseObject({ metric: z.string(), current: z.looseObject({ total: z.number().nullable() }), previous: z.looseObject({ total: z.number().nullable() }), delta: z.number().nullable(), pctChange: z.number().nullable() }),
      handler: (i, ctx) => {
        const s = specFrom(i, ctx);
        const cur = resolveRange(ctx, s.dateRange);
        const len = Math.round((toTime(cur.to) - toTime(cur.from)) / 864e5) + 1;
        const months = { this_month: 1, last_month: 1, this_quarter: 3 }[cur.preset]; // calendar presets compare to the previous calendar period
        const [y, m] = cur.from.split('-').map(Number);
        const prev = { from: months ? ymd(Date.UTC(y, m - 1 - months, 1)) : addDays(cur.from, -len).slice(0, 10), to: addDays(cur.from, -1).slice(0, 10) };
        const timeGroup = ['day', 'week', 'month'].includes(s.groupBy);
        const a = compute(ctx, { ...s, groupBy: timeGroup ? 'none' : s.groupBy }, cur);
        const b = compute(ctx, { ...s, groupBy: timeGroup ? 'none' : s.groupBy }, prev);
        const diff = (x, y) => (x == null || y == null ? null : round(x - y));
        const pct = (x, y) => (x == null || !y ? null : round(((x - y) / y) * 100));
        const keys = [...new Set([...a.rows, ...b.rows].map((r) => r.group))];
        const byGroup = keys.map((g) => {
          const x = a.rows.find((r) => r.group === g)?.value ?? (a.unit === 'count' || a.unit === 'currency' ? 0 : null);
          const y = b.rows.find((r) => r.group === g)?.value ?? (b.unit === 'count' || b.unit === 'currency' ? 0 : null);
          return { group: g, current: x, previous: y, delta: diff(x, y), pctChange: pct(x, y) };
        });
        return {
          ...(s.report ? { reportId: s.report.id, name: s.report.name } : {}), metric: s.metric, unit: a.unit,
          current: { ...cur, total: a.total, recordCount: a.recordCount }, previous: { ...prev, total: b.total, recordCount: b.recordCount },
          delta: diff(a.total, b.total), pctChange: pct(a.total, b.total), ...(byGroup.length ? { groupBy: s.groupBy, byGroup } : {}),
        };
      },
      example: (ctx) => ({ metric: 'tickets_opened', dateRange: { preset: 'last_7_days' } }),
    },
    {
      id: 'export_report', name: 'Export report results',
      description: 'Run a saved report now and store the results as a CSV or JSON export file (returns the file content).',
      keywords: ['download report', 'csv', 'export data'],
      risk: 'write',
      input: z.object({ id: id('report'), format: z.enum(['csv', 'json']).default('csv') }),
      output: exportRow,
      handler: ({ id: rid, format }, ctx) => {
        const r = ctx.get('reports', rid, 'report');
        const res = compute(ctx, r);
        const rows = res.rows.length ? res.rows : [{ group: 'all', value: res.total, count: res.recordCount }];
        const esc = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
        const content = format === 'json'
          ? JSON.stringify({ report: r.name, ...res }, null, 2)
          : ['group,label,value,count', ...rows.map((x) => [x.group, x.label, x.value, x.count].map(esc).join(','))].join('\n');
        const slug = r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return ctx.insert('report_exports', {
          reportId: r.id, format, fileName: `${slug}-${ctx.today}.${format}`, content, rowCount: rows.length, total: res.total,
          dateRange: res.dateRange, createdBy: ctx.actorId,
        });
      },
      example: (ctx) => ({ id: ctx.all('reports')[0].id, format: 'csv' }),
    },
    {
      id: 'schedule_report', name: 'Schedule report delivery',
      description: 'Email a saved report to recipients on a recurring schedule (daily, weekly on dayOfWeek, or monthly on the 1st), 08:00 UTC. Replaces any existing schedule.',
      keywords: ['email report', 'recurring report', 'send report weekly'],
      risk: 'external',
      input: z.object({
        id: id('report'), frequency: z.enum(['daily', 'weekly', 'monthly']), recipients: z.array(z.email()).min(1).max(20),
        dayOfWeek: z.enum(DAYS).optional().describe('required for weekly'),
      }),
      output: report,
      handler: ({ id: rid, frequency, recipients, dayOfWeek }, ctx) => {
        const r = ctx.get('reports', rid, 'report');
        if (frequency === 'weekly' && !dayOfWeek) fail('VALIDATION', 'weekly schedules need dayOfWeek (sun..sat)');
        if (frequency !== 'weekly' && dayOfWeek) fail('VALIDATION', `dayOfWeek only applies to weekly schedules, not ${frequency}`);
        const to = [...new Set(recipients.map((e) => e.toLowerCase()))];
        return ctx.patch(r, { schedule: { frequency, recipients: to, dayOfWeek: dayOfWeek ?? null, nextRunAt: nextRun(ctx, frequency, dayOfWeek), createdBy: ctx.actorId } });
      },
      example: (ctx) => ({ id: ctx.all('reports')[1].id, frequency: 'weekly', dayOfWeek: 'mon', recipients: ['alex.morgan@acme.test'] }),
    },
  ],

  seed(ctx) {
    const sched = (frequency, recipients, dayOfWeek = null) => ({ frequency, recipients, dayOfWeek, nextRunAt: nextRun(ctx, frequency, dayOfWeek), createdBy: 'usr_001' });
    const rows = [
      ['Weekly Leads by Source', 'leads_created', { preset: 'last_7_days' }, 'source', {}, sched('weekly', ['alex.morgan@acme.test'], 'mon')],
      ['Monthly Revenue', 'revenue_collected', { preset: 'this_month' }, 'week', {}, sched('monthly', ['alex.morgan@acme.test', 'jamie.fox@acme.test'])],
      ['Overdue Invoices', 'invoices_overdue', { from: '2026-01-01', to: '2026-11-04' }, 'month', {}, null],
      ['Rep Performance', 'deals_won', { preset: 'this_quarter' }, 'owner', {}, null],
      ['Support SLA', 'tickets_opened', { preset: 'last_7_days' }, 'status', { priority: 'urgent' }, sched('daily', ['sam.taylor@acme.test'])],
      ['Appointment No-Shows', 'no_show_rate', { preset: 'last_30_days' }, 'owner', {}, null],
    ];
    for (const [name, metric, dr, groupBy, f, schedule] of rows)
      ctx.insert('reports', { name, metric, dateRange: dr, groupBy, filters: f, schedule, description: null, createdAt: '2026-09-15T14:00:00.000Z' });
  },
});
