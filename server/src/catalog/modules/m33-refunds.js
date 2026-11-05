import { defineModule, ops, z, id, entity, isoDate, fail, addDays, toTime, round2 } from '../kit.js';
import { applyInvoicePayment, allocatedTotal } from './m29-payments.js';

const STATUSES = ['requested', 'approved', 'rejected', 'executed'];
const REASONS = ['requested_by_customer', 'duplicate', 'fraudulent', 'service_not_delivered', 'product_defective', 'other'];
const refund = entity({
  paymentId: z.string(), contactId: z.string(), amount: z.number(), currency: z.string(), reason: z.enum(REASONS), reasonNote: z.string().nullable().optional(),
  status: z.enum(STATUSES), approvedAt: z.string().nullable().optional(), rejectedAt: z.string().nullable().optional(),
  rejectionReason: z.string().nullable().optional(), executedAt: z.string().nullable().optional(), processorRefundId: z.string().nullable().optional(),
});
const CAPTURED = ['succeeded', 'partially_refunded'];

/** What can still be refunded: amount − already refunded − approved-but-not-executed refunds (optionally excluding one request). */
function balanceOf(ctx, p, excludeId) {
  const pendingApproved = round2(ctx.all('refunds').filter((r) => r.paymentId === p.id && r.status === 'approved' && r.id !== excludeId).reduce((s, r) => s + r.amount, 0));
  const requested = round2(ctx.all('refunds').filter((r) => r.paymentId === p.id && r.status === 'requested' && r.id !== excludeId).reduce((s, r) => s + r.amount, 0));
  const refundable = CAPTURED.includes(p.status) ? Math.max(0, round2(p.amount - (p.refundedAmount || 0) - pendingApproved)) : 0;
  return { paymentId: p.id, paymentStatus: p.status, amount: p.amount, currency: p.currency, refundedAmount: p.refundedAmount || 0, pendingApproved, requestedNotApproved: requested, refundable };
}
function capturedPayment(ctx, pid) {
  const p = ctx.get('payments', pid, 'payment');
  if (!CAPTURED.includes(p.status))
    fail('INVALID_STATE', `payment ${pid} is '${p.status}'; refunds need a succeeded payment${p.status === 'refunded' ? ' (it is already fully refunded)' : p.status === 'failed' ? ' (nothing was captured)' : ''}`);
  return p;
}
function withinBalance(ctx, p, amount, excludeId) {
  const b = balanceOf(ctx, p, excludeId);
  if (amount > b.refundable) fail('INSUFFICIENT_BALANCE', `payment ${p.id} has ${b.refundable} ${p.currency} refundable (paid ${p.amount}, refunded ${b.refundedAmount}, approved pending ${b.pendingApproved}); lower the amount`, b);
}
function editable(r, allowed = ['requested']) {
  if (!allowed.includes(r.status)) fail('INVALID_STATE', `refund request ${r.id} is '${r.status}'; this action requires: ${allowed.join(', ')}`);
}
function execution(ctx, r) {
  if (r.status !== 'executed') {
    const next = { requested: 'approve it with approve_refund_request', approved: 'run execute_refund', rejected: 'none (rejected)' }[r.status];
    return { refundId: r.id, status: r.status, executionStatus: 'not_executed', nextStep: next };
  }
  const settled = toTime(r.settlementDate, true) <= toTime(ctx.now);
  return {
    refundId: r.id, status: r.status, executionStatus: settled ? 'settled' : 'processing', executedAt: r.executedAt, processorRefundId: r.processorRefundId,
    expectedSettlementDate: r.settlementDate, amount: r.amount, currency: r.currency, invoiceAdjustments: r.invoiceAdjustments || [],
  };
}
const pick = (ctx, status) => ctx.all('refunds').find((r) => r.status === status);

export default defineModule({
  id: 'refunds',
  code: 'M33',
  name: 'Refunds',
  description: 'Request, approve, and execute refunds of captured payments.',
  tables: { refunds: { prefix: 'rfd', schema: refund } },
  actions: [
    {
      id: 'create_refund_request', name: 'Create refund request',
      description: 'Open a refund request against a succeeded payment (full refundable balance by default, or a partial amount). Needs approval before money moves; does not touch the payment yet.',
      keywords: ['refund customer', 'money back', 'return payment', 'chargeback request'],
      risk: 'write',
      input: z.object({
        paymentId: id('payment'), amount: z.number().positive().optional().describe('default: full refundable balance'),
        reason: z.enum(REASONS).default('requested_by_customer'), note: z.string().optional(),
      }),
      output: refund,
      handler: ({ paymentId, amount, reason, note }, ctx) => {
        const p = capturedPayment(ctx, paymentId);
        const b = balanceOf(ctx, p);
        if (b.refundable <= 0) fail('INSUFFICIENT_BALANCE', `payment ${p.id} has nothing left to refund`, b);
        const amt = round2(amount ?? b.refundable);
        withinBalance(ctx, p, amt);
        return ctx.insert('refunds', {
          paymentId: p.id, contactId: p.contactId, invoiceId: p.invoiceId ?? null, amount: amt, currency: p.currency, reason, reasonNote: note ?? null,
          status: 'requested', requestedBy: ctx.actorId, approvedAt: null, rejectedAt: null, rejectionReason: null, executedAt: null, processorRefundId: null,
        });
      },
      example: (ctx) => ({ paymentId: ctx.all('payments').find((p) => p.status === 'succeeded' && p.allocations.length).id, amount: 25, reason: 'service_not_delivered' }),
    },
    {
      id: 'get_refund_request', name: 'Get refund request', description: 'Fetch one refund request by ID (payment, amount, reason, approval status).',
      ...ops.get('refunds', { what: 'refund request' }),
      example: (ctx) => ({ id: ctx.all('refunds')[0].id }),
    },
    {
      id: 'search_refund_requests', name: 'Search refund requests',
      description: 'Find refund requests by payment, contact, status, reason, amount range or created date range.',
      keywords: ['pending refunds', 'list refunds'],
      ...ops.search('refunds', {
        filters: {
          paymentId: z.string().optional(), contactId: z.string().optional(), status: z.enum(STATUSES).optional(), reason: z.enum(REASONS).optional(),
          amountMin: z.number().optional(), amountMax: z.number().optional(), createdAtAfter: isoDate().optional(), createdAtBefore: isoDate().optional(),
        },
      }),
      example: () => ({ status: 'requested' }),
    },
    {
      id: 'set_refund_reason', name: 'Set refund reason', description: 'Change the reason category (and optional note) of a refund request that is not yet executed or rejected.',
      risk: 'write',
      input: z.object({ id: id('refund request'), reason: z.enum(REASONS), note: z.string().optional() }),
      output: refund,
      handler: ({ id: rid, reason, note }, ctx) => {
        const r = ctx.get('refunds', rid, 'refund request');
        editable(r, ['requested', 'approved']);
        return ctx.patch(r, { reason, ...(note !== undefined ? { reasonNote: note } : {}) });
      },
      example: (ctx) => ({ id: pick(ctx, 'requested').id, reason: 'product_defective', note: 'Tray cracked on arrival' }),
    },
    {
      id: 'set_refund_amount', name: 'Set partial refund amount', description: 'Change the amount of a requested (not yet approved) refund; must not exceed the payment refundable balance.',
      keywords: ['partial refund'],
      risk: 'write',
      input: z.object({ id: id('refund request'), amount: z.number().positive() }),
      output: refund,
      handler: ({ id: rid, amount }, ctx) => {
        const r = ctx.get('refunds', rid, 'refund request');
        editable(r);
        withinBalance(ctx, ctx.get('payments', r.paymentId, 'payment'), round2(amount), r.id);
        return ctx.patch(r, { amount: round2(amount) });
      },
      example: (ctx) => ({ id: pick(ctx, 'requested').id, amount: 10 }),
    },
    {
      id: 'check_refundable_balance', name: 'Check refundable balance',
      description: 'How much of a payment can still be refunded: payment amount minus already refunded minus approved-but-unexecuted refunds.',
      keywords: ['how much can I refund', 'refund limit'],
      risk: 'read',
      input: z.object({ paymentId: id('payment') }),
      output: z.looseObject({ paymentId: z.string(), amount: z.number(), refundedAmount: z.number(), pendingApproved: z.number(), refundable: z.number() }),
      handler: ({ paymentId }, ctx) => balanceOf(ctx, ctx.get('payments', paymentId, 'payment')),
      example: (ctx) => ({ paymentId: (pick(ctx, 'approved') || ctx.all('refunds')[0])?.paymentId ?? ctx.all('payments')[0].id }),
    },
    {
      id: 'approve_refund_request', name: 'Approve refund request', description: 'Approve a requested refund (re-checks the refundable balance). Approval reserves the amount; money moves only on execute_refund.',
      risk: 'write',
      input: z.object({ id: id('refund request') }),
      output: refund,
      handler: ({ id: rid }, ctx) => {
        const r = ctx.get('refunds', rid, 'refund request');
        editable(r);
        withinBalance(ctx, capturedPayment(ctx, r.paymentId), r.amount, r.id);
        return ctx.patch(r, { status: 'approved', approvedAt: ctx.now, approvedBy: ctx.actorId });
      },
      example: (ctx) => ({ id: pick(ctx, 'requested').id }),
    },
    {
      id: 'reject_refund_request', name: 'Reject refund request', description: 'Decline a requested or approved (not yet executed) refund with a reason; frees any reserved refundable balance.',
      keywords: ['deny refund', 'decline refund'],
      risk: 'write',
      input: z.object({ id: id('refund request'), reason: z.string().min(1).describe('why the refund is rejected') }),
      output: refund,
      handler: ({ id: rid, reason }, ctx) => {
        const r = ctx.get('refunds', rid, 'refund request');
        editable(r, ['requested', 'approved']);
        return ctx.patch(r, { status: 'rejected', rejectedAt: ctx.now, rejectedBy: ctx.actorId, rejectionReason: reason });
      },
      example: (ctx) => ({ id: pick(ctx, 'requested').id, reason: 'Service was delivered as agreed' }),
    },
    {
      id: 'execute_refund', name: 'Execute simulated refund',
      description: 'Send an approved refund to the customer via the (simulated) processor: increases the payment refundedAmount/status and, if the payment was applied to invoices, reduces their amountPaid (unallocated money is refunded first).',
      keywords: ['issue refund', 'process refund', 'send money back'],
      risk: 'external',
      input: z.object({ id: id('refund request') }),
      output: refund,
      handler: ({ id: rid }, ctx) => {
        const r = ctx.get('refunds', rid, 'refund request');
        editable(r, ['approved']);
        const p = capturedPayment(ctx, r.paymentId);
        const remaining = round2(p.amount - (p.refundedAmount || 0));
        if (r.amount > remaining) fail('INSUFFICIENT_BALANCE', `payment ${p.id} only has ${remaining} left to refund; reject this request and create a smaller one`);
        // Refund unallocated money first; only the excess reverses invoice payments (latest allocation first).
        let fromAlloc = round2(Math.max(0, r.amount - (remaining - allocatedTotal(p))));
        const invoiceAdjustments = [];
        for (const a of [...p.allocations].reverse()) {
          if (fromAlloc <= 0) break;
          const take = round2(Math.min(a.amount, fromAlloc));
          a.amount = round2(a.amount - take);
          fromAlloc = round2(fromAlloc - take);
          const inv = ctx.find('invoices', a.invoiceId);
          if (inv) applyInvoicePayment(ctx, inv, -take);
          invoiceAdjustments.push({ invoiceId: a.invoiceId, amount: take, invoiceStatus: inv?.status ?? null, invoiceBalance: inv?.balance ?? null });
        }
        p.allocations = p.allocations.filter((a) => a.amount > 0);
        const refundedAmount = round2((p.refundedAmount || 0) + r.amount);
        ctx.patch(p, { refundedAmount, status: refundedAmount >= p.amount ? 'refunded' : 'partially_refunded' });
        return ctx.patch(r, {
          status: 'executed', executedAt: ctx.now, processorRefundId: `re_sim_${r.id.split('_')[1]}`, settlementDate: addDays(ctx.now, 5).slice(0, 10), invoiceAdjustments,
        });
      },
      example: (ctx) => ({ id: pick(ctx, 'approved').id }),
    },
    {
      id: 'get_refund_execution_status', name: 'Get refund execution status',
      description: 'Where an individual refund stands after approval: not_executed, processing (sent to processor, awaiting settlement), or settled — with processor reference and invoice adjustments.',
      keywords: ['refund status', 'has refund gone through', 'when will customer get money'],
      risk: 'read',
      input: z.object({ id: id('refund request') }),
      output: z.looseObject({ refundId: z.string(), status: z.enum(STATUSES), executionStatus: z.enum(['not_executed', 'processing', 'settled']) }),
      handler: ({ id: rid }, ctx) => execution(ctx, ctx.get('refunds', rid, 'refund request')),
      example: (ctx) => ({ id: pick(ctx, 'executed').id }),
    },
  ],

  seed(ctx, h) {
    const pays = ctx.all('payments').filter((p) => p.status === 'succeeded');
    const allocated = pays.filter((p) => p.allocations.length);
    const loose = pays.find((p) => !p.allocations.length && p.amount >= 100) || pays.find((p) => p.amount >= 100);
    if (!loose) return;
    const mk = (p, amount, status, reason, extra = {}) =>
      ctx.insert('refunds', {
        paymentId: p.id, contactId: p.contactId, invoiceId: p.invoiceId ?? null, amount, currency: p.currency, reason, reasonNote: null, status,
        requestedBy: 'usr_011', approvedAt: null, rejectedAt: null, rejectionReason: null, executedAt: null, processorRefundId: null, ...extra,
      });
    // Executed 10 days ago (settled) — the only one that changed a payment; it is on the unallocated payment so no invoice changes.
    const ex = mk(loose, 40, 'executed', 'duplicate', {
      reasonNote: 'Customer paid twice for consultation', createdAt: h.daysAgo(12), approvedAt: h.daysAgo(11), executedAt: h.daysAgo(10),
      processorRefundId: null, settlementDate: h.dateOnly(h.daysAgo(5)), invoiceAdjustments: [],
    });
    ex.processorRefundId = `re_sim_${ex.id.split('_')[1]}`;
    loose.refundedAmount = 40;
    loose.status = 'partially_refunded';
    mk(loose, 50, 'approved', 'requested_by_customer', { createdAt: h.daysAgo(2), approvedAt: h.daysAgo(1), approvedBy: 'usr_011' });
    const a0 = allocated[0] ?? loose, a1 = allocated[1] ?? loose;
    mk(a0, round2(Math.min(75, a0.amount / 2)), 'requested', 'service_not_delivered', { reasonNote: 'Missed two scheduled sessions', createdAt: h.daysAgo(1) });
    mk(a1, round2(a1.amount), 'rejected', 'requested_by_customer', { createdAt: h.daysAgo(20), rejectedAt: h.daysAgo(18), rejectionReason: 'Outside the 14-day refund window' });
  },
});
