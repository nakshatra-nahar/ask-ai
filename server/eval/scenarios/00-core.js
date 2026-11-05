// The assignment brief's own use cases. Assertions derive expected sets from seeded data (eval/fixtures.js).
import { followUpTargets, availableReps, tasksFor, isFacebook, lastWeekLeads, overdueInvoices, remindedThisWeek, TOMORROW, LAST_WEEK } from '../fixtures.js';

const complexPrompt = 'Find leads created last week who have not replied, exclude anyone with a booked appointment, assign the remaining leads to available sales reps, and create follow-up tasks.';

function complexState(h) {
  const targets = followUpTargets(h);
  if (!targets.length) return 'fixture has no target leads';
  const reps = availableReps(h);
  for (const l of targets) {
    if (!reps.includes(l.ownerId)) return `${l.id} owner ${l.ownerId} is not an available rep`;
    if (!tasksFor(h, l).some((t) => t.status === 'open')) return `no follow-up task for ${l.id}`;
  }
  const targetIds = new Set(targets.map((l) => l.id));
  const stray = lastWeekLeads(h).filter((l) => !targetIds.has(l.id) && tasksFor(h, l).length);
  if (stray.length) return `tasks created for excluded leads: ${stray.map((l) => l.id).join(', ')}`;
  return true;
}
async function complexOracle(call, h) {
  const reps = availableReps(h);
  const targets = followUpTargets(h);
  targets.forEach((l, i) => {
    if (!reps.includes(l.ownerId)) call('leads.assign_lead_owner', { id: l.id, ownerId: reps[i % reps.length] });
    call('tasks.create_task', { title: `Follow up with ${l.name}`, contactId: l.contactId, recordType: 'leads', recordId: l.id, ownerId: h.get('leads', l.id).ownerId, dueDate: TOMORROW });
  });
}

export default [
  {
    id: 'core-direct-create-contact',
    category: 'direct',
    modules: ['contacts'],
    turns: [{ user: 'Create a contact named Sarah Lee with email sarah.lee@brightpath.io' }],
    expect: {
      actions: ['contacts.create_contact'],
      params: { 'contacts.create_contact': { firstName: 'Sarah', lastName: 'Lee', email: 'sarah.lee@brightpath.io' } },
      state: (h) => h.created('contacts').filter((c) => c.email === 'sarah.lee@brightpath.io' && c.firstName === 'Sarah').length === 1 || 'contact not created exactly once',
    },
    oracle: (call) => call('contacts.create_contact', { firstName: 'Sarah', lastName: 'Lee', email: 'sarah.lee@brightpath.io' }),
  },
  {
    id: 'core-indirect-follow-up-leads',
    category: 'indirect',
    modules: ['leads', 'tasks'],
    turns: [{ user: 'I keep forgetting to follow up with new leads. Help me stay on top of them.' }],
    expect: {
      // Either concrete follow-up tasks for new leads, or an automation (workflow + trigger) — both achieve the goal.
      actions: [['tasks.create_task', 'workflows.create_workflow']],
      allow: ['leads.assign_lead_owner', 'workflows.add_workflow_step', 'triggers.create_event_trigger', 'triggers.bind_trigger_to_workflow', 'triggers.set_trigger_event_type', 'triggers.enable_trigger', 'workflows.publish_workflow', 'leads.update_lead', 'tasks.set_task_due_date', 'tasks.assign_task_owner', 'tasks.set_task_priority'],
      state: (h) => {
        const newLeads = h.all('leads').filter((l) => l.status === 'new');
        const covered = newLeads.filter((l) => tasksFor(h, l).length);
        if (covered.length >= Math.min(3, newLeads.length)) return true;
        return h.created('workflows').length > 0 || `only ${covered.length} new leads got follow-up tasks and no workflow was created`;
      },
    },
    oracle: (call, h) => h.all('leads').filter((l) => l.status === 'new').forEach((l) => call('tasks.create_task', { title: `Follow up with ${l.name}`, contactId: l.contactId, recordType: 'leads', recordId: l.id })),
  },
  {
    id: 'core-complex-leads-followup',
    category: 'multi_step',
    modules: ['leads', 'conversations', 'appointments', 'users', 'tasks'],
    turns: [{ user: complexPrompt }],
    expect: {
      actions: ['leads.search_leads', ['appointments.search_appointments', 'contacts.get_contact_timeline'], 'tasks.create_task'],
      allow: ['leads.assign_lead_owner', 'tasks.assign_task_owner', 'tasks.set_task_due_date'],
      params: { 'leads.search_leads': { createdAtAfter: LAST_WEEK[0] } },
      state: complexState,
    },
    oracle: async (call, h) => {
      call('leads.search_leads', { createdAtAfter: LAST_WEEK[0], createdAtBefore: LAST_WEEK[1] });
      call('appointments.search_appointments', { upcoming: true });
      await complexOracle(call, h);
    },
  },
  {
    id: 'core-followup-facebook-tomorrow',
    category: 'follow_up',
    modules: ['leads', 'tasks', 'campaigns'],
    turns: [{ user: complexPrompt }, { user: 'Only include leads from the Facebook campaign, and make those tasks due tomorrow.' }],
    expect: {
      actions: ['tasks.create_task', 'tasks.set_task_due_date'],
      allow: ['leads.assign_lead_owner', 'tasks.cancel_task', 'tasks.assign_task_owner', 'tasks.update_task', 'leads.update_lead'],
      state: (h) => {
        const targets = followUpTargets(h);
        const fb = targets.filter((l) => isFacebook(h, l));
        if (!fb.length) return 'fixture has no facebook targets';
        for (const l of fb) if (!tasksFor(h, l).some((t) => t.status === 'open' && t.dueDate === TOMORROW)) return `facebook lead ${l.id} has no open task due tomorrow`;
        for (const l of targets.filter((x) => !isFacebook(h, x)))
          if (tasksFor(h, l).some((t) => t.status === 'open')) return `non-facebook lead ${l.id} still has an open follow-up task`;
        return true;
      },
    },
    oracle: async (call, h) => {
      await complexOracle(call, h);
      for (const l of followUpTargets(h))
        for (const t of tasksFor(h, l))
          isFacebook(h, l) ? call('tasks.set_task_due_date', { id: t.id, dueDate: TOMORROW }) : call('tasks.cancel_task', { id: t.id });
    },
  },
  {
    id: 'core-conditional-invoice-reminders',
    category: 'conditional',
    modules: ['invoices', 'email'],
    turns: [{ user: 'For unpaid invoices overdue by more than 15 days, draft reminders, but skip customers who already received one this week.' }],
    expect: {
      actions: ['invoices.list_overdue_invoices', ['email.draft_email', 'sms.draft_sms']],
      forbid: ['invoices.send_invoice_reminder', 'email.send_email', 'sms.send_sms'],
      allow: ['templates.render_template'],
      state: (h) => {
        const due = overdueInvoices(h, 15);
        const want = due.filter((i) => !remindedThisWeek(h, i.contactId));
        const skip = due.filter((i) => remindedThisWeek(h, i.contactId));
        if (!want.length || !skip.length) return 'fixture lacks eligible/skipped invoices';
        const drafts = h.created('messages').filter((m) => m.status === 'draft');
        for (const i of want) if (!drafts.some((m) => m.contactId === i.contactId || m.relatedId === i.id)) return `no draft reminder for ${i.number}`;
        for (const i of skip) if (drafts.some((m) => m.contactId === i.contactId)) return `drafted reminder for already-reminded ${i.number}`;
        const strays = drafts.filter((m) => !want.some((i) => i.contactId === m.contactId));
        return !strays.length || `drafts to unrelated contacts: ${strays.map((m) => m.contactId).join(', ')}`;
      },
    },
    oracle: (call, h) => {
      call('invoices.list_overdue_invoices', { minDaysOverdue: 16 });
      for (const i of overdueInvoices(h, 15).filter((i) => !remindedThisWeek(h, i.contactId)))
        call('email.draft_email', { contactId: i.contactId, subject: `Reminder: ${i.number}`, body: `Invoice ${i.number} is overdue.`, relatedType: 'invoices', relatedId: i.id, purpose: 'invoice_reminder' });
    },
  },
  {
    id: 'core-ambiguous-sarah-sms',
    category: 'ambiguous',
    modules: ['contacts', 'sms'],
    turns: [{ user: 'Send Sarah a text saying her appointment is confirmed.' }],
    expect: { clarify: true, noWrites: true },
  },
  {
    id: 'core-unsupported-business-cards',
    category: 'unsupported',
    modules: ['users'],
    turns: [{ user: 'Order 200 business cards from Vistaprint for Jordan Lee and charge the company card.' }],
    oracleReply: "I can't do that — there's no printing/ordering capability.",
    expect: { noWrites: true, reply: /(can't|cannot|can not|unable|not able|don't have|do not have|not support|isn't supported|no (action|capability|way))/i },
  },
  {
    id: 'core-failure-sms-opted-out',
    category: 'failure',
    modules: ['sms', 'contacts'],
    turns: [{ user: 'Text Olivia Martin to remind her about tomorrow’s appointment.' }],
    invariant: true, // state check guards against a bad send; it holds on the seed by design
    oracleReply: 'Olivia has opted out of SMS, so I could not text her.',
    expect: {
      reply: /(opt(ed)?[- ]?out|unsubscribed|do not (text|contact)|doesn't accept|not accept|can't|cannot|couldn't|could not|unable|failed)/i,
      state: (h) => !h.created('messages').some((m) => m.contactId === 'con_005' && m.channel === 'sms' && ['sent', 'delivered', 'scheduled'].includes(m.status)) || 'sent SMS to opted-out contact',
    },
  },
];
