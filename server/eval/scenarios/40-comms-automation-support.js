// Comms, automation and support: conversations, sms, email, templates, campaigns, workflows, triggers, forms, surveys, reviews, listings, tickets.
// Expected sets come from a fresh-seed snapshot taken at load time (every runner resets the store before each scenario),
// so assertions stay correct if the seed changes and can still refer to pre-scenario state.
import { reset, getDb } from '../../src/catalog/registry.js';
import { TOMORROW } from '../fixtures.js';

reset();
const SEED = structuredClone(getDb().tables);
const NOW = Date.parse('2026-11-04T10:00:00Z');
const idOf = (t, pred) => SEED[t].find(typeof pred === 'string' ? (r) => r.name === pred || r.subject === pred : pred).id;
const nameOf = (contactId) => SEED.contacts.find((c) => c.id === contactId)?.name;
const hoursAgo = (iso) => (NOW - Date.parse(iso)) / 36e5;
const firstName = (n) => n.split(' ')[0];

const unanswered = SEED.conversations.filter((c) => c.status === 'open' && c.lastDirection === 'inbound');
const sentEmails = (h, contactId) =>
  h.created('messages').filter((m) => m.channel === 'email' && m.direction === 'outbound' && (!contactId || m.contactId === contactId) && ['sent', 'delivered'].includes(m.status));
const availableStaff = (h, uid) => {
  const u = h.get('users', uid);
  return !!u && u.status === 'active' && !u.outOfOffice;
};

// Records referenced by name in prompts.
const USR = { jordan: idOf('users', 'Jordan Lee'), riley: idOf('users', 'Riley Kim'), marcus: idOf('users', 'Marcus Reed') };
const CON = { sarahChen: idOf('contacts', 'Sarah Chen'), elena: idOf('contacts', 'Elena Smith'), olivia: idOf('contacts', 'Olivia Martin') };
const TPL = { missedCall: idOf('templates', 'Missed Call Text-Back'), apptReminder: idOf('templates', 'Appointment Reminder'), bfTeaser: idOf('templates', 'Black Friday Teaser'), paymentFailed: idOf('templates', 'Payment Failed Notice') };
const CAM = { newsletter: idOf('campaigns', 'November Newsletter'), blackFriday: idOf('campaigns', 'Black Friday SMS') };
const WF = { nurture: idOf('workflows', 'New Lead Nurture'), webinar: idOf('workflows', 'Webinar Follow-up') };
const TRG = { fbLead: idOf('triggers', 'New Facebook Lead'), contactUs: idOf('triggers', 'Contact Us Form Submitted'), vip: idOf('triggers', 'VIP Tag Added'), paymentFailed: idOf('triggers', 'Payment Failed') };
const FRM = { rsvp: idOf('forms', 'Event RSVP') };
const SRV = { csat: idOf('surveys', 'Customer Satisfaction (NPS)') };
const LST = { acme: idOf('listings', 'Acme Dental'), summit: idOf('listings', 'Summit Fitness') };
const TKT = { password: idOf('tickets', 'Cannot reset password') };
const REV = { sofia: idOf('reviews', (r) => r.authorName === 'Sofia M.' && r.platform === 'facebook') };
const olivConv = idOf('conversations', (c) => c.contactId === CON.olivia && c.channel === 'email');

// Read-only answers derived from the seed.
const longestWait = [...unanswered].sort((a, b) => Date.parse(a.lastInboundAt) - Date.parse(b.lastInboundAt))[0];
const longestName = nameOf(longestWait.contactId);
const npsAnswers = SEED.survey_responses.filter((r) => r.surveyId === SRV.csat).map((r) => r.answers.find((a) => a.questionId === SEED.surveys.find((s) => s.id === SRV.csat).questions.find((q) => q.type === 'nps').id)?.answer).filter((v) => typeof v === 'number');
const NPS = Math.round(((npsAnswers.filter((v) => v >= 9).length - npsAnswers.filter((v) => v <= 6).length) / npsAnswers.length) * 100);
const failedSms = SEED.messages.filter((m) => m.channel === 'sms' && m.status === 'failed');
const landlineSms = failedSms.filter((m) => /landline/i.test(m.failureReason || ''));
const otherFailedSms = failedSms.filter((m) => !landlineSms.includes(m));

// Sets for multi-record scenarios.
const staleEmailThreads = unanswered.filter((c) => c.channel === 'email' && hoursAgo(c.lastInboundAt) > 72);
const marcusUnanswered = unanswered.filter((c) => c.ownerId === USR.marcus);
const unassignedTickets = SEED.tickets.filter((t) => !t.ownerId && !['resolved', 'closed'].includes(t.status));
const badFbReviews = SEED.reviews.filter((r) => r.platform === 'facebook' && r.rating <= 2 && !r.responded);
const acmeLiveDirs = Object.entries(SEED.listings.find((l) => l.id === LST.acme).syncs).filter(([, s]) => s.status === 'synced').map(([d]) => d);

const CANT = /(can't|cannot|can not|couldn't|could not|unable|not able|don't have|do not have|not support|isn't supported|no (action|capability|way|integration))/i;

export default [
  // ───────────── direct ─────────────
  {
    id: 'cmm-direct-ticket-priority-owner',
    category: 'direct',
    modules: ['tickets', 'users'],
    turns: [{ user: "The 'cannot reset password' ticket — bump it to high priority and hand it to Riley." }],
    expect: {
      actions: ['tickets.set_ticket_priority', 'tickets.assign_ticket'],
      params: { 'tickets.set_ticket_priority': { id: TKT.password, priority: 'high' }, 'tickets.assign_ticket': { id: TKT.password, ownerId: USR.riley } },
      state: (h) => {
        const t = h.get('tickets', TKT.password);
        return (t.priority === 'high' && t.ownerId === USR.riley) || `ticket is ${t.priority}/${t.ownerId}`;
      },
    },
    oracle: (call) => {
      call('tickets.set_ticket_priority', { id: TKT.password, priority: 'high' });
      call('tickets.assign_ticket', { id: TKT.password, ownerId: USR.riley });
    },
  },
  {
    id: 'cmm-direct-unanswered-count',
    category: 'direct',
    modules: ['conversations'],
    turns: [{ user: "how many convos are still waiting on a reply from us? and who's been waiting longest" }],
    oracleReply: `${unanswered.length} conversations are waiting on us; ${longestName} has been waiting the longest.`,
    expect: {
      actions: [['conversations.list_unanswered_conversations', 'conversations.search_conversations']],
      noWrites: true,
      reply: new RegExp(`^(?=[\\s\\S]*\\b${unanswered.length}\\b)(?=[\\s\\S]*${longestName})`, 'i'),
    },
    oracle: (call) => call('conversations.list_unanswered_conversations', {}),
  },
  {
    id: 'cmm-direct-create-sms-template',
    category: 'direct',
    modules: ['templates'],
    turns: [{ user: "Make a new SMS template called Holiday Hours: \"Hi {{contact.firstName}}, heads up — we're closed Nov 26-27 for Thanksgiving. See you after the holiday! - {{business.name}}\"" }],
    expect: {
      actions: ['templates.create_template'],
      params: { 'templates.create_template': { name: 'Holiday Hours', channel: 'sms' } },
      state: (h) => {
        const t = h.created('templates').filter((x) => /holiday hours/i.test(x.name));
        if (t.length !== 1) return `expected 1 Holiday Hours template, got ${t.length}`;
        return (t[0].channel === 'sms' && /Thanksgiving/.test(t[0].body) && t[0].body.includes('{{contact.firstName}}')) || 'template channel/body wrong';
      },
    },
    oracle: (call) => call('templates.create_template', { name: 'Holiday Hours', channel: 'sms', body: "Hi {{contact.firstName}}, heads up — we're closed Nov 26-27 for Thanksgiving. See you after the holiday! - {{business.name}}" }),
  },
  {
    id: 'cmm-direct-publish-review-reply',
    category: 'direct',
    modules: ['reviews'],
    turns: [{ user: "Post a public reply on Sofia M.'s 1-star Facebook review — apologize for the wait and ask her to give us a call so we can make it right." }],
    expect: {
      actions: ['reviews.publish_review_response'],
      allow: ['reviews.draft_review_response'],
      params: { 'reviews.publish_review_response': { id: REV.sofia } },
      state: (h) => {
        const r = h.get('reviews', REV.sofia);
        return (r.responded && /(sorry|apolog)/i.test(r.responseText || '')) || 'no published apology on the review';
      },
    },
    oracle: (call) => call('reviews.publish_review_response', { id: REV.sofia, text: "Sofia, we're so sorry about the wait. Please give us a call so we can make it right." }),
  },
  {
    id: 'cmm-direct-listing-phone-republish',
    category: 'direct',
    modules: ['listings'],
    turns: [{ user: 'Acme Dental has a new number, 512-555-2000. Update their listing and push the change out to the directories it is already live on.' }],
    expect: {
      actions: ['listings.update_listing_phone', 'listings.publish_listing'],
      params: { 'listings.update_listing_phone': { id: LST.acme, phone: /512\D*555\D*2000/ }, 'listings.publish_listing': { id: LST.acme, directories: acmeLiveDirs } },
      state: (h) => {
        const l = h.get('listings', LST.acme);
        if (l.phone !== '+15125552000') return `phone is ${l.phone}`;
        const stale = acmeLiveDirs.filter((d) => l.syncs[d]?.status !== 'synced' || l.syncs[d].snapshot?.phone !== l.phone);
        return !stale.length || `not republished to ${stale.join(', ')}`;
      },
    },
    oracle: (call) => {
      call('listings.update_listing_phone', { id: LST.acme, phone: '+1 512-555-2000' });
      call('listings.publish_listing', { id: LST.acme, directories: acmeLiveDirs });
    },
  },
  {
    id: 'cmm-direct-nps-score',
    category: 'direct',
    modules: ['surveys'],
    turns: [{ user: "What's our NPS on the customer satisfaction survey right now, and how many people have answered it?" }],
    oracleReply: `NPS is ${NPS} from ${npsAnswers.length} responses.`,
    expect: {
      actions: ['surveys.get_survey_response_summary'],
      noWrites: true,
      reply: new RegExp(`^(?=[\\s\\S]*\\b${NPS}\\b)(?=[\\s\\S]*\\b${npsAnswers.length}\\b)`),
    },
    oracle: (call) => call('surveys.get_survey_response_summary', { id: SRV.csat }),
  },
  {
    id: 'cmm-direct-form-add-phone',
    category: 'direct',
    modules: ['forms'],
    turns: [{ user: 'add a required phone number field to the event rsvp form' }],
    expect: {
      actions: ['forms.add_form_field'],
      params: { 'forms.add_form_field': { id: FRM.rsvp, type: 'phone', required: true } },
      state: (h) => h.get('forms', FRM.rsvp).fields.some((f) => f.type === 'phone' && f.required) || 'no required phone field on Event RSVP',
    },
    oracle: (call) => call('forms.add_form_field', { id: FRM.rsvp, key: 'phone', label: 'Phone number', type: 'phone', required: true }),
  },
  {
    id: 'cmm-direct-schedule-email',
    category: 'direct',
    modules: ['email', 'contacts'],
    turns: [{ user: "Schedule an email to Sarah Chen for tomorrow at 9am. Subject 'Your proposal from Acme' — just say the proposal we discussed is attached and she can reply with any questions." }],
    expect: {
      actions: ['email.schedule_email'],
      allow: ['email.draft_email'],
      params: { 'email.schedule_email': { scheduledAt: TOMORROW } },
      forbid: ['email.send_email'],
      state: (h) => {
        const m = h.created('messages').filter((x) => x.channel === 'email' && x.status === 'scheduled' && x.contactId === CON.sarahChen);
        if (m.length !== 1) return `expected 1 scheduled email to Sarah Chen, got ${m.length}`;
        return (m[0].scheduledAt?.startsWith(TOMORROW) && /proposal/i.test(m[0].subject || '')) || `scheduled ${m[0].scheduledAt} / '${m[0].subject}'`;
      },
    },
    oracle: (call) => call('email.schedule_email', { contactId: CON.sarahChen, subject: 'Your proposal from Acme', body: 'Hi Sarah, the proposal we discussed is attached. Reply with any questions!', scheduledAt: `${TOMORROW}T14:00:00Z` }),
  },
  {
    id: 'cmm-direct-draft-sms-from-template',
    category: 'direct',
    modules: ['sms', 'templates', 'contacts'],
    turns: [{ user: "Draft a text to Elena Smith using our missed-call text-back template. Don't send it yet, I want to look it over." }],
    expect: {
      actions: ['sms.draft_sms'],
      forbid: ['sms.send_sms', 'sms.schedule_sms'],
      state: (h) => {
        const d = h.created('messages').filter((m) => m.channel === 'sms' && m.status === 'draft' && m.contactId === CON.elena);
        if (d.length !== 1) return `expected 1 SMS draft to Elena Smith, got ${d.length}`;
        return d[0].templateId === TPL.missedCall || /missed your call/i.test(d[0].body) || `draft body doesn't use the template: ${d[0].body}`;
      },
    },
    oracle: (call) => call('sms.draft_sms', { contactId: CON.elena, templateId: TPL.missedCall }),
  },
  {
    id: 'cmm-direct-disable-fb-trigger',
    category: 'direct',
    modules: ['triggers'],
    turns: [{ user: 'Turn off the trigger that drops new Facebook leads into the nurture sequence for now.' }],
    expect: {
      actions: ['triggers.disable_trigger'],
      forbid: ['workflows.pause_workflow'],
      params: { 'triggers.disable_trigger': { id: TRG.fbLead } },
      state: (h) => {
        if (h.get('triggers', TRG.fbLead).status !== 'disabled') return 'Facebook lead trigger still enabled';
        return h.get('workflows', WF.nurture).status === 'published' || 'nurture workflow was changed too';
      },
    },
    oracle: (call) => call('triggers.disable_trigger', { id: TRG.fbLead }),
  },

  // ───────────── indirect ─────────────
  {
    id: 'cmm-indirect-drowning-inbox',
    category: 'indirect',
    modules: ['conversations', 'users'],
    turns: [{ user: "I'm drowning in unanswered messages. Marcus is out this week and his threads are just sitting there — can you sort that out?" }],
    expect: {
      actions: ['conversations.assign_conversation_owner'],
      allow: ['conversations.add_internal_comment', 'email.draft_email', 'sms.draft_sms'],
      state: (h) => {
        if (!marcusUnanswered.length) return 'fixture: Marcus has no unanswered threads';
        const stuck = marcusUnanswered.filter((c) => !availableStaff(h, h.get('conversations', c.id).ownerId));
        return !stuck.length || `still owned by an unavailable user: ${stuck.map((c) => c.id).join(', ')}`;
      },
    },
    oracle: (call) => marcusUnanswered.forEach((c, i) => call('conversations.assign_conversation_owner', { id: c.id, ownerId: [USR.jordan, idOf('users', 'Priya Shah')][i % 2] })),
  },
  {
    id: 'cmm-indirect-facebook-reviews',
    category: 'indirect',
    modules: ['reviews'],
    turns: [{ user: 'our facebook reviews are terrible rn, help' }],
    expect: {
      actions: [['reviews.draft_review_response', 'reviews.publish_review_response']],
      allow: ['reviews.create_review_request', 'reviews.send_review_request'],
      state: (h) => {
        if (!badFbReviews.length) return 'fixture: no unanswered negative Facebook reviews';
        const left = badFbReviews.filter((r) => {
          const now = h.get('reviews', r.id);
          return !now.responded && !now.responseDraft;
        });
        return !left.length || `negative Facebook reviews with no response: ${left.map((r) => r.id).join(', ')}`;
      },
    },
    oracle: (call) => {
      call('reviews.search_reviews', { platform: 'facebook', ratingMax: 2, responded: false });
      badFbReviews.forEach((r) => call('reviews.draft_review_response', { id: r.id, text: `Hi ${r.authorName}, we're sorry about your experience. Please contact us so we can make it right.` }));
    },
  },
  {
    id: 'cmm-indirect-support-backlog',
    category: 'indirect',
    modules: ['tickets', 'users'],
    turns: [{ user: "Support is a mess. Tickets are blowing through SLA and half of them don't even have anyone on them." }],
    expect: {
      actions: ['tickets.assign_ticket'],
      allow: ['tickets.set_ticket_priority', 'tickets.add_ticket_note', 'tickets.update_ticket_status'],
      state: (h) => {
        if (!unassignedTickets.length) return 'fixture: no unassigned tickets';
        const bad = unassignedTickets.filter((t) => {
          const owner = h.get('users', h.get('tickets', t.id).ownerId);
          return !owner || !owner.roles.includes('support') || !availableStaff(h, owner.id);
        });
        return !bad.length || `tickets without an available support owner: ${bad.map((t) => t.id).join(', ')}`;
      },
    },
    oracle: (call, h) => {
      const agents = h.all('users').filter((u) => u.roles.includes('support') && u.status === 'active' && !u.outOfOffice).map((u) => u.id);
      unassignedTickets.forEach((t, i) => call('tickets.assign_ticket', { id: t.id, ownerId: agents[i % agents.length] }));
    },
  },

  // ───────────── multi_step ─────────────
  {
    id: 'cmm-multi-stale-email-threads',
    category: 'multi_step',
    modules: ['conversations', 'email', 'users'],
    turns: [{ user: "Pull up every email thread where the customer has been waiting on us for more than 3 days. Hand them all to Jordan and send each person a short apology for the slow reply, saying Jordan will follow up today." }],
    expect: {
      actions: [['conversations.list_unanswered_conversations', 'conversations.search_conversations'], 'conversations.assign_conversation_owner', 'email.send_email'],
      allow: ['conversations.add_internal_comment', 'email.draft_email'],
      params: { 'conversations.assign_conversation_owner': { ownerId: USR.jordan } },
      state: (h) => {
        if (!staleEmailThreads.length) return 'fixture: no stale email threads';
        for (const c of staleEmailThreads) {
          if (h.get('conversations', c.id).ownerId !== USR.jordan) return `${c.id} not assigned to Jordan`;
          if (!sentEmails(h, c.contactId).length) return `no apology email sent to ${nameOf(c.contactId)}`;
        }
        const want = new Set(staleEmailThreads.map((c) => c.contactId));
        const stray = sentEmails(h).filter((m) => !want.has(m.contactId));
        return !stray.length || `emailed contacts outside the >3-day set: ${[...new Set(stray.map((m) => nameOf(m.contactId)))].join(', ')}`;
      },
    },
    oracle: (call) => {
      call('conversations.list_unanswered_conversations', { channel: 'email', minHoursWaiting: 72 });
      for (const c of staleEmailThreads) {
        call('conversations.assign_conversation_owner', { id: c.id, ownerId: USR.jordan });
        call('email.send_email', { contactId: c.contactId, subject: 'Sorry for the slow reply', body: `Hi ${firstName(nameOf(c.contactId))}, sorry for the delay — Jordan will follow up with you today.` });
      }
    },
  },
  {
    id: 'cmm-multi-payment-failed-automation',
    category: 'multi_step',
    modules: ['workflows', 'triggers', 'templates'],
    turns: [{ user: "Set up an automation for failed payments: email the customer our Payment Failed Notice template, wait 2 days, then create a task to 'Call about failed payment'. Hook it up to the existing Payment Failed trigger and turn everything on." }],
    expect: {
      actions: ['workflows.create_workflow', 'workflows.add_workflow_step', 'workflows.publish_workflow', 'triggers.bind_trigger_to_workflow', 'triggers.enable_trigger'],
      allow: ['triggers.update_trigger_conditions', 'triggers.set_trigger_event_type'],
      params: {
        'workflows.add_workflow_step': [{ type: 'send_email', config: { templateId: TPL.paymentFailed } }, { type: 'create_task' }],
        'triggers.enable_trigger': { id: TRG.paymentFailed },
      },
      state: (h) => {
        const t = h.get('triggers', TRG.paymentFailed);
        if (t.status !== 'enabled') return 'Payment Failed trigger not enabled';
        const wf = h.created('workflows').find((w) => w.id === t.workflowId);
        if (!wf) return 'trigger not bound to a newly created workflow';
        if (wf.status !== 'published') return `workflow is ${wf.status}`;
        const types = wf.steps.map((s) => s.type).join(',');
        if (types !== 'send_email,wait,create_task') return `steps are ${types}`;
        const [mail, wait, task] = wf.steps;
        if (mail.config.templateId !== TPL.paymentFailed) return 'email step does not use Payment Failed Notice';
        if ((wait.config.days || 0) * 24 + (wait.config.hours || 0) !== 48) return `wait is ${JSON.stringify(wait.config)}`;
        return /failed payment/i.test(task.config.title || '') || `task title '${task.config.title}'`;
      },
    },
    oracle: (call) => {
      const wf = call('workflows.create_workflow', { name: 'Failed Payment Recovery' });
      call('workflows.add_workflow_step', { id: wf.id, type: 'send_email', config: { templateId: TPL.paymentFailed } });
      call('workflows.add_workflow_step', { id: wf.id, type: 'wait', config: { days: 2 } });
      call('workflows.add_workflow_step', { id: wf.id, type: 'create_task', config: { title: 'Call about failed payment' } });
      call('workflows.publish_workflow', { id: wf.id });
      call('triggers.bind_trigger_to_workflow', { id: TRG.paymentFailed, workflowId: wf.id });
      call('triggers.enable_trigger', { id: TRG.paymentFailed });
    },
  },
  {
    id: 'cmm-multi-black-friday-setup',
    category: 'multi_step',
    modules: ['campaigns', 'templates', 'contacts'],
    turns: [{ user: 'Get the Black Friday SMS campaign ready to go: target everyone tagged customer, use the Black Friday Teaser template as the message, and schedule it for Nov 27 at 9am Eastern.' }],
    expect: {
      actions: ['campaigns.set_campaign_audience', 'campaigns.add_campaign_message_step', 'campaigns.set_campaign_schedule'],
      forbid: ['campaigns.launch_campaign'],
      params: {
        'campaigns.set_campaign_audience': { id: CAM.blackFriday, tags: ['customer'] },
        'campaigns.add_campaign_message_step': { id: CAM.blackFriday, templateId: TPL.bfTeaser },
        'campaigns.set_campaign_schedule': { id: CAM.blackFriday, startAt: '2026-11-27' },
      },
      state: (h) => {
        const c = h.get('campaigns', CAM.blackFriday);
        if (c.status !== 'scheduled') return `campaign is ${c.status}`;
        if (!c.audience?.tags?.map((t) => t.toLowerCase()).includes('customer') || !c.audienceSize) return 'audience is not the customer tag';
        if (c.steps.length !== 1 || c.steps[0].templateId !== TPL.bfTeaser) return `steps: ${JSON.stringify(c.steps.map((s) => s.templateId))}`;
        return c.schedule?.startAt?.startsWith('2026-11-27T14:00') || `starts ${c.schedule?.startAt} (want 2026-11-27 9am ET = 14:00Z)`;
      },
    },
    oracle: (call) => {
      call('campaigns.set_campaign_audience', { id: CAM.blackFriday, tags: ['customer'] });
      call('campaigns.add_campaign_message_step', { id: CAM.blackFriday, templateId: TPL.bfTeaser });
      call('campaigns.set_campaign_schedule', { id: CAM.blackFriday, startAt: '2026-11-27T09:00:00-05:00', timezone: 'America/New_York' });
    },
  },
  {
    id: 'cmm-multi-contact-form-to-nurture',
    category: 'multi_step',
    modules: ['triggers', 'workflows', 'forms'],
    turns: [{ user: 'Whenever someone fills out the Contact Us form I want them dropped straight into the New Lead Nurture workflow. Wire that up and switch it on.' }],
    expect: {
      actions: [['triggers.bind_trigger_to_workflow', 'triggers.create_event_trigger'], 'triggers.enable_trigger'],
      allow: ['triggers.update_trigger_conditions', 'triggers.set_trigger_event_type'],
      state: (h) => {
        const ok = h.all('triggers').some((t) => t.status === 'enabled' && t.eventType === 'form_submitted' && t.workflowId === WF.nurture && /contact us|frm_001/i.test(JSON.stringify(t.conditions)));
        return ok || 'no enabled form_submitted trigger scoped to Contact Us that starts New Lead Nurture';
      },
    },
    oracle: (call) => {
      call('triggers.bind_trigger_to_workflow', { id: TRG.contactUs, workflowId: WF.nurture });
      call('triggers.enable_trigger', { id: TRG.contactUs });
    },
  },
  {
    id: 'cmm-multi-double-charge-ticket',
    category: 'multi_step',
    modules: ['conversations', 'tickets', 'email', 'users'],
    turns: [{ user: "Olivia Martin emailed saying she got charged twice this month. Open a high priority support ticket for her and put Riley on it, email her back that we're looking into it, and leave an internal comment on her conversation so sales knows support has it." }],
    expect: {
      actions: ['tickets.create_ticket', ['tickets.reply_to_ticket', 'email.send_email'], 'conversations.add_internal_comment'],
      allow: ['tickets.assign_ticket', 'tickets.link_ticket_contact', 'tickets.add_ticket_note', 'tickets.update_ticket_status'],
      forbid: ['sms.send_sms'],
      params: { 'tickets.create_ticket': { contactId: CON.olivia, priority: 'high' }, 'conversations.add_internal_comment': { id: olivConv } },
      state: (h) => {
        const t = h.created('tickets').filter((x) => x.contactId === CON.olivia);
        if (t.length !== 1) return `expected 1 ticket for Olivia, got ${t.length}`;
        if (t[0].priority !== 'high' || t[0].ownerId !== USR.riley) return `ticket is ${t[0].priority}/${t[0].ownerId}`;
        if (!sentEmails(h, CON.olivia).length) return 'no email reply sent to Olivia';
        return h.get('conversations', olivConv).comments.length > SEED.conversations.find((c) => c.id === olivConv).comments.length || 'no internal comment on her conversation';
      },
    },
    oracle: (call) => {
      const t = call('tickets.create_ticket', { subject: 'Charged twice this month', contactId: CON.olivia, ownerId: USR.riley, priority: 'high', channel: 'email' });
      call('tickets.reply_to_ticket', { id: t.id, body: "Hi Olivia, sorry about the double charge — we're looking into it now." });
      call('conversations.add_internal_comment', { id: olivConv, body: `Support has this as ticket ${t.id} (Riley).` });
    },
  },

  // ───────────── conditional ─────────────
  {
    id: 'cmm-cond-apple-listing-categories',
    category: 'conditional',
    modules: ['listings'],
    turns: [{ user: "Summit Fitness isn't showing on Apple Maps. Check what's going on with the Apple sync — if it was rejected over categories, set them to Gym and Personal Trainer and resubmit to Apple." }],
    expect: {
      actions: [['listings.get_listing_sync_status', 'listings.get_listing', 'listings.search_listings'], 'listings.set_listing_categories', 'listings.publish_listing'],
      params: { 'listings.set_listing_categories': { id: LST.summit, categories: ['Gym', 'Personal Trainer'] }, 'listings.publish_listing': { id: LST.summit, directories: ['apple'] } },
      state: (h) => {
        const l = h.get('listings', LST.summit);
        const cats = l.categories.map((c) => c.toLowerCase());
        if (!cats.includes('gym') || !cats.includes('personal trainer')) return `categories are ${l.categories.join(', ')}`;
        return l.syncs.apple?.status === 'synced' || `apple is ${l.syncs.apple?.status}`;
      },
    },
    oracle: (call) => {
      call('listings.get_listing_sync_status', { id: LST.summit });
      call('listings.set_listing_categories', { id: LST.summit, categories: ['Gym', 'Personal Trainer'] });
      call('listings.publish_listing', { id: LST.summit, directories: ['apple'] });
    },
  },
  {
    id: 'cmm-cond-failed-sms-landline',
    category: 'conditional',
    modules: ['sms', 'email', 'contacts'],
    turns: [{ user: 'Some of our texts bounced. Any that failed because the number is a landline, send the same message by email instead. For the others just tell me who they were.' }],
    oracleReply: `Emailed ${landlineSms.map((m) => nameOf(m.contactId)).join(', ')}. Other failures: ${otherFailedSms.map((m) => nameOf(m.contactId)).join(', ')}.`,
    expect: {
      actions: [['sms.search_sms_messages', 'sms.get_sms_delivery_status'], 'email.send_email'],
      forbid: ['sms.send_sms'],
      reply: new RegExp(otherFailedSms.map((m) => `(?=[\\s\\S]*${firstName(nameOf(m.contactId))})`).join('')),
      state: (h) => {
        if (!landlineSms.length || !otherFailedSms.length) return 'fixture lacks landline / non-landline failures';
        for (const m of landlineSms) if (!sentEmails(h, m.contactId).length) return `no email sent to ${nameOf(m.contactId)} (landline)`;
        const wrong = otherFailedSms.filter((m) => sentEmails(h, m.contactId).length);
        return !wrong.length || `emailed non-landline failures: ${wrong.map((m) => nameOf(m.contactId)).join(', ')}`;
      },
    },
    oracle: (call) => {
      call('sms.search_sms_messages', { status: 'failed' });
      landlineSms.forEach((m) => call('email.send_email', { contactId: m.contactId, subject: 'Following up', body: m.body }));
    },
  },

  // ───────────── follow_up ─────────────
  {
    id: 'cmm-followup-holiday-survey',
    category: 'follow_up',
    modules: ['surveys'],
    turns: [
      { user: "Create a survey called 'Holiday Event Feedback' with an NPS question: How likely are you to recommend our holiday event to a friend?" },
      { user: 'Also add an optional text question asking what we could do better next year, then publish it.' },
    ],
    expect: {
      actions: ['surveys.create_survey', 'surveys.add_survey_question', 'surveys.publish_survey'],
      params: { 'surveys.add_survey_question': [{ type: 'nps' }, { type: 'text' }] },
      state: (h) => {
        const s = h.created('surveys').filter((x) => /holiday event feedback/i.test(x.name));
        if (s.length !== 1) return `expected 1 Holiday Event Feedback survey, got ${s.length}`;
        const types = s[0].questions.map((q) => q.type).join(',');
        if (types !== 'nps,text') return `questions are ${types}`;
        return s[0].status === 'published' || `survey is ${s[0].status}`;
      },
    },
    oracle: (call) => {
      const s = call('surveys.create_survey', { name: 'Holiday Event Feedback' });
      call('surveys.add_survey_question', { id: s.id, text: 'How likely are you to recommend our holiday event to a friend?', type: 'nps', required: true });
      call('surveys.add_survey_question', { id: s.id, text: 'What could we do better next year?', type: 'text', required: false });
      call('surveys.publish_survey', { id: s.id });
    },
  },
  {
    id: 'cmm-followup-edit-reminder-template',
    category: 'follow_up',
    modules: ['templates', 'sms'],
    turns: [
      { user: 'What does our appointment reminder text say right now?' },
      { user: "Change it so people reply Y to confirm instead of C. Leave everything else as is." },
    ],
    expect: {
      actions: ['templates.update_template_content'],
      params: { 'templates.update_template_content': { id: TPL.apptReminder, body: /Reply Y to confirm/i } },
      state: (h) => {
        const before = SEED.templates.find((t) => t.id === TPL.apptReminder).body;
        const t = h.get('templates', TPL.apptReminder);
        return t.body === before.replace('Reply C to confirm', 'Reply Y to confirm') || `body is now: ${t.body}`;
      },
    },
    oracle: (call) => {
      const t = call('templates.get_template', { id: TPL.apptReminder });
      call('templates.update_template_content', { id: TPL.apptReminder, body: t.body.replace('Reply C to confirm', 'Reply Y to confirm') });
    },
  },
  {
    id: 'cmm-followup-newsletter-declined-launch',
    category: 'follow_up',
    modules: ['campaigns'],
    turns: [
      { user: 'Launch the November Newsletter right now, no point waiting until Friday.', confirm: false },
      { user: "ok hold off on that. move it to monday 9am eastern instead" },
    ],
    expect: {
      actions: ['campaigns.set_campaign_schedule'],
      forbid: ['campaigns.launch_campaign'],
      confirmRequested: true,
      params: { 'campaigns.set_campaign_schedule': { id: CAM.newsletter, startAt: '2026-11-09' } },
      state: (h) => {
        const c = h.get('campaigns', CAM.newsletter);
        if (c.status !== 'scheduled' || c.launchedAt) return `campaign is ${c.status} (launchedAt ${c.launchedAt})`;
        return c.schedule?.startAt?.startsWith('2026-11-09T14:00') || `starts ${c.schedule?.startAt} (want Mon 2026-11-09 9am ET = 14:00Z)`;
      },
    },
    oracle: (call) => call('campaigns.set_campaign_schedule', { id: CAM.newsletter, startAt: '2026-11-09T09:00:00-05:00', timezone: 'America/New_York' }),
  },

  // ───────────── ambiguous ─────────────
  {
    id: 'cmm-ambiguous-reply-michael',
    category: 'ambiguous',
    modules: ['conversations', 'email', 'contacts'],
    turns: [{ user: "Reply to Michael's email and let him know someone will give him a call this afternoon." }],
    expect: { clarify: true, noWrites: true },
  },
  {
    id: 'cmm-ambiguous-texting-automation',
    category: 'ambiguous',
    modules: ['workflows', 'triggers'],
    turns: [{ user: 'Can you turn off the automation that texts people? Customers are complaining.' }],
    expect: { clarify: true, noWrites: true },
  },

  // ───────────── unsupported ─────────────
  {
    id: 'cmm-unsupported-whatsapp-blast',
    category: 'unsupported',
    modules: ['campaigns', 'sms'],
    turns: [{ user: 'Send a WhatsApp broadcast to all our VIP customers about the Black Friday sale.' }],
    oracleReply: "I can't send WhatsApp messages — campaigns only support email, SMS and ads.",
    expect: { noWrites: true, reply: CANT },
  },

  // ───────────── failure ─────────────
  {
    id: 'cmm-failure-launch-empty-campaign',
    category: 'failure',
    modules: ['campaigns'],
    turns: [{ user: 'Launch the Black Friday SMS campaign now.' }],
    invariant: true, // guards against a launch with an invented audience/message; holds on the seed by design
    oracleReply: "The Black Friday SMS campaign can't launch yet: it has no audience and no message step.",
    expect: {
      forbid: ['campaigns.launch_campaign'],
      reply: /(audience|message|step|content)/i,
      state: (h) => h.get('campaigns', CAM.blackFriday).status !== 'active' || 'campaign was launched',
    },
  },
  {
    id: 'cmm-failure-enable-vip-trigger',
    category: 'failure',
    modules: ['triggers', 'workflows'],
    turns: [{ user: 'Switch on the VIP Tag Added trigger.' }],
    invariant: true, // the bound workflow is an invalid draft, so the trigger must stay off
    oracleReply: "I couldn't enable it: its workflow 'Webinar Follow-up' is still a draft and can't be published (it assigns a deactivated user and the email step has no body).",
    expect: {
      forbid: ['triggers.enable_trigger'],
      reply: /(draft|not published|unpublished|publish|deactivated|invalid|error)/i,
      state: (h) => {
        if (h.get('triggers', TRG.vip).status !== 'disabled') return 'VIP trigger was enabled';
        return h.get('workflows', WF.webinar).status !== 'published' || 'Webinar Follow-up was published';
      },
    },
  },
];
