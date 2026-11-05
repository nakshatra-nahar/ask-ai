// Ground-truth queries over the seeded data, used by scenario assertions and oracles.
// Expected sets are computed from data, never hardcoded, so they stay correct if the seed changes.
export const LAST_WEEK = ['2026-10-26', '2026-11-01'];
export const THIS_WEEK_START = '2026-11-02';
export const TOMORROW = '2026-11-05';

export const inRange = (iso, [a, b]) => iso.slice(0, 10) >= a && iso.slice(0, 10) <= b;
export const lastWeekLeads = (h) => h.all('leads').filter((l) => inRange(l.createdAt, LAST_WEEK));
export const replied = (h, lead) =>
  h.all('messages').some((m) => m.direction === 'inbound' && m.contactId === lead.contactId && (m.sentAt || m.createdAt) >= lead.createdAt);
export const hasBooked = (h, contactId) =>
  h.all('appointments').some((a) => a.contactId === contactId && ['booked', 'confirmed'].includes(a.status) && a.startAt >= '2026-11-04');
export const availableReps = (h) =>
  h.all('users').filter((u) => u.roles.includes('sales_rep') && u.status === 'active' && !u.outOfOffice).map((u) => u.id);
/** Leads targeted by the brief's complex example. */
export const followUpTargets = (h) => lastWeekLeads(h).filter((l) => !replied(h, l) && !hasBooked(h, l.contactId));
export const isFacebook = (h, l) => l.source === 'facebook' || h.all('campaigns').find((c) => c.id === l.campaignId)?.name?.includes('Facebook');
/** Tasks this scenario created for a lead (linked by record or by contact). */
export const tasksFor = (h, lead) => h.created('tasks').filter((t) => t.recordId === lead.id || t.contactId === lead.contactId);

export const overdueInvoices = (h, minDays) =>
  h.all('invoices').filter((i) => ['sent', 'partially_paid'].includes(i.status) && i.balance > 0 && i.dueDate && (Date.parse('2026-11-04') - Date.parse(i.dueDate)) / 864e5 > minDays);
export const remindedThisWeek = (h, contactId) =>
  h.all('messages').some((m) => m.contactId === contactId && m.purpose === 'invoice_reminder' && ['sent', 'delivered'].includes(m.status) && (m.sentAt || '') >= THIS_WEEK_START);
