// CRM core: contacts, companies, leads, opportunities, pipelines, tasks, notes, tags, smart lists, custom fields, users, teams.
// Expected sets are derived from seeded data where the final state still allows it (eval/fixtures.js, CONVENTIONS.md).
import { execute } from '../../src/catalog/registry.js';
import { availableReps } from '../fixtures.js';

const TODAY = '2026-11-04';
const CANT = /(can't|cannot|can not|couldn't|could not|unable|not able|don't have|do not have|not support|isn't supported|no (action|capability|integration|way))/i;
const user = (h, name) => h.find('users', (u) => u.name === name);
const named = (h, t, name) => h.find(t, (r) => r.name?.toLowerCase() === name.toLowerCase());
const contact = (h, name) => h.find('contacts', (c) => c.name === name && c.status === 'active');
const isOpen = (l) => ['new', 'contacted', 'qualified'].includes(l.status);
const freeUsers = (h) => h.all('users').filter((u) => u.status === 'active' && !u.outOfOffice).map((u) => u.id);
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
/** Evaluate a smart list with the platform's own evaluator (read action: no state change, no activity log). */
const preview = (id) => {
  const r = execute('smart_lists.preview_smart_list', { id, limit: 100 });
  if (!r.ok) throw new Error(`preview failed: ${r.error.message}`);
  return r.data.items.map((x) => x.id);
};

export default [
  // ---------------- direct ----------------
  {
    id: 'crm-direct-company-with-manager',
    category: 'direct',
    modules: ['companies', 'users'],
    turns: [{ user: 'Add a new company, Sunrise Pediatrics (sunrisepediatrics.com), in healthcare. Priya Shah should be the account manager.' }],
    expect: {
      actions: ['companies.create_company'],
      allow: ['companies.assign_account_manager'],
      params: { 'companies.create_company': { name: /sunrise pediatrics/i, domain: 'sunrisepediatrics.com' } },
      state: (h) => {
        const cos = h.created('companies').filter((c) => /sunrise pediatrics/i.test(c.name));
        if (cos.length !== 1) return `expected 1 Sunrise Pediatrics company, got ${cos.length}`;
        return cos[0].accountManagerId === user(h, 'Priya Shah').id || `account manager is ${cos[0].accountManagerId}`;
      },
    },
    oracle: (call, h) => call('companies.create_company', { name: 'Sunrise Pediatrics', domain: 'sunrisepediatrics.com', industry: 'Healthcare', accountManagerId: user(h, 'Priya Shah').id }),
  },
  {
    id: 'crm-direct-deal-stage',
    category: 'direct',
    modules: ['opportunities', 'pipelines'],
    // Deal names carry a randomly seeded product suffix, so the deal is referenced (and found) by its contact.
    turns: [{ user: 'Grace Nguyen got her proposal today — move her deal to Proposal Sent please' }],
    expect: {
      actions: ['opportunities.move_opportunity_to_stage'],
      params: { 'opportunities.move_opportunity_to_stage': { id: 'opp_005' } },
      state: (h) => {
        const o = h.find('opportunities', (x) => x.contactId === contact(h, 'Grace Nguyen').id);
        const st = h.get('pipelines', o.pipelineId).stages.find((s) => s.name === 'Proposal Sent');
        return (o.status === 'open' && o.stageId === st.id) || `deal is ${o.status} in ${o.stageId}`;
      },
    },
    oracle: (call, h) => {
      const o = h.find('opportunities', (x) => x.contactId === contact(h, 'Grace Nguyen').id);
      call('opportunities.move_opportunity_to_stage', { id: o.id, stageId: h.get('pipelines', o.pipelineId).stages.find((s) => s.name === 'Proposal Sent').id });
    },
  },
  {
    id: 'crm-direct-pipeline-stage-insert',
    category: 'direct',
    modules: ['pipelines'],
    turns: [{ user: "Can you add a 'Legal Signoff' stage to the Partnerships pipeline? It goes right after Contract Review, 90% win probability." }],
    expect: {
      actions: ['pipelines.add_pipeline_stage'],
      allow: ['pipelines.reorder_pipeline_stages', 'pipelines.set_stage_probability'],
      params: { 'pipelines.add_pipeline_stage': { id: 'pl_002', name: /legal sign-?off/i } },
      state: (h) => {
        const stages = [...named(h, 'pipelines', 'Partnerships').stages].sort((a, b) => a.order - b.order);
        const legal = stages.filter((s) => /legal sign-?off/i.test(s.name));
        if (legal.length !== 1) return `expected 1 Legal Signoff stage, got ${legal.length}`;
        const i = stages.findIndex((s) => s.name === 'Contract Review');
        if (stages[i + 1] !== legal[0]) return `stage order is ${stages.map((s) => s.name).join(' > ')}`;
        return legal[0].probability === 90 || `probability is ${legal[0].probability}`;
      },
    },
    oracle: (call, h) => {
      const pl = named(h, 'pipelines', 'Partnerships');
      call('pipelines.add_pipeline_stage', { id: pl.id, name: 'Legal Signoff', probability: 90, position: pl.stages.find((s) => s.name === 'Contract Review').order + 1 });
    },
  },
  {
    id: 'crm-direct-dropdown-option',
    category: 'direct',
    modules: ['custom_fields', 'contacts'],
    turns: [{ user: 'We just opened an Eastside office. Add Eastside as a choice on the Preferred Location field for contacts.' }],
    expect: {
      actions: ['custom_fields.add_dropdown_option'],
      params: { 'custom_fields.add_dropdown_option': { id: 'cf_002', value: 'Eastside' } },
      state: (h) => {
        const f = h.find('custom_fields', (x) => x.module === 'contacts' && /preferred location/i.test(x.label));
        const opt = f.options.find((o) => o.value.toLowerCase() === 'eastside');
        return (opt && !opt.retired) || 'Eastside is not an active option';
      },
    },
    oracle: (call, h) => call('custom_fields.add_dropdown_option', { id: h.find('custom_fields', (x) => x.module === 'contacts' && /preferred location/i.test(x.label)).id, value: 'Eastside' }),
  },
  {
    id: 'crm-direct-team-member',
    category: 'direct',
    modules: ['teams', 'users'],
    turns: [{ user: 'Riley Kim is going to help the sales team for a bit — add her to Sales. She should stay on Support as well.' }],
    expect: {
      actions: ['teams.add_team_member'],
      forbid: ['teams.remove_team_member'],
      params: { 'teams.add_team_member': { id: 'tm_001', userId: 'usr_007' } },
      state: (h) => {
        const riley = user(h, 'Riley Kim').id;
        if (!named(h, 'teams', 'Sales').memberIds.includes(riley)) return 'Riley is not on Sales';
        return named(h, 'teams', 'Support').memberIds.includes(riley) || 'Riley was removed from Support';
      },
    },
    oracle: (call, h) => call('teams.add_team_member', { id: named(h, 'teams', 'Sales').id, userId: user(h, 'Riley Kim').id }),
  },
  {
    id: 'crm-direct-disqualify-lead',
    category: 'direct',
    modules: ['leads'],
    turns: [{ user: 'Mei Silva went with a competitor, so close out her lead as disqualified.' }],
    expect: {
      actions: ['leads.disqualify_lead'],
      params: { 'leads.disqualify_lead': { id: 'ld_045', reason: /competitor/i } },
      state: (h) => {
        const l = named(h, 'leads', 'Mei Silva');
        return (l.status === 'disqualified' && /competitor/i.test(l.disqualifyReason || '')) || `lead is ${l.status} (${l.disqualifyReason})`;
      },
    },
    oracle: (call, h) => call('leads.disqualify_lead', { id: named(h, 'leads', 'Mei Silva').id, reason: 'Went with a competitor' }),
  },
  {
    id: 'crm-direct-task-reschedule',
    category: 'direct',
    modules: ['tasks', 'contacts'],
    // Task owner/title/contact are spec-seeded (Marcus); due date and priority are random draws, so only the owner change is guaranteed non-trivial.
    turns: [{ user: "the 'Prepare quote' task for Lucas Johnson - marcus is out so give it to Dana, and move it to monday" }],
    expect: {
      actions: ['tasks.assign_task_owner', 'tasks.set_task_due_date'],
      params: { 'tasks.assign_task_owner': { id: 'tsk_008', ownerId: 'usr_005' }, 'tasks.set_task_due_date': { id: 'tsk_008', dueDate: '2026-11-09' } },
      state: (h) => {
        const t = h.find('tasks', (x) => x.title === 'Prepare quote' && x.contactId === contact(h, 'Lucas Johnson').id);
        return (t.status === 'open' && t.ownerId === user(h, 'Dana Cruz').id && t.dueDate === '2026-11-09') || `task is ${t.status}/${t.ownerId}/${t.dueDate}`;
      },
    },
    oracle: (call, h) => {
      const t = h.find('tasks', (x) => x.title === 'Prepare quote' && x.contactId === contact(h, 'Lucas Johnson').id);
      call('tasks.assign_task_owner', { id: t.id, ownerId: user(h, 'Dana Cruz').id });
      call('tasks.set_task_due_date', { id: t.id, dueDate: h.day(5) });
    },
  },
  {
    id: 'crm-direct-decline-delete-smart-list',
    category: 'direct',
    modules: ['smart_lists'],
    turns: [{ user: "Delete the 'Stale Leads (30+ days)' smart list, we never use it.", confirm: false }],
    invariant: true, // the user declines the gated delete, so the list must survive; holds on the seed by design
    expect: {
      confirmRequested: true,
      noWrites: true,
      state: (h) => !!h.find('smart_lists', (s) => /stale leads/i.test(s.name)) || 'smart list was deleted although the user declined',
    },
  },

  // ---------------- indirect ----------------
  {
    id: 'crm-indirect-chris-cleanup',
    category: 'indirect',
    modules: ['leads', 'users', 'teams'],
    turns: [{ user: "Chris Park left months ago but he's still showing up on the Sales team and as the owner on a few leads. Can you sort that out so nothing is stuck with him?" }],
    expect: {
      actions: ['leads.assign_lead_owner', 'teams.remove_team_member'],
      forbid: ['users.reactivate_user'],
      allow: ['tasks.assign_task_owner', 'opportunities.assign_opportunity_owner', 'contacts.assign_contact_owner', 'companies.assign_account_manager'],
      state: (h) => {
        const chris = user(h, 'Chris Park').id;
        const stuck = h.all('leads').filter((l) => l.ownerId === chris && isOpen(l));
        if (stuck.length) return `open leads still owned by Chris: ${stuck.map((l) => l.id).join(', ')}`;
        const reps = availableReps(h);
        const bad = h.changed('leads').filter((l) => !reps.includes(l.ownerId));
        if (bad.length) return `leads given to unavailable owners: ${bad.map((l) => `${l.id}->${l.ownerId}`).join(', ')}`;
        return !named(h, 'teams', 'Sales').memberIds.includes(chris) || 'Chris is still on the Sales team';
      },
    },
    oracle: (call, h) => {
      const chris = user(h, 'Chris Park').id;
      const reps = availableReps(h);
      h.all('leads').filter((l) => l.ownerId === chris && isOpen(l)).forEach((l, i) => call('leads.assign_lead_owner', { id: l.id, ownerId: reps[i % reps.length] }));
      call('teams.remove_team_member', { id: named(h, 'teams', 'Sales').id, userId: chris });
    },
  },
  {
    id: 'crm-indirect-marcus-ooo-tasks',
    category: 'indirect',
    modules: ['tasks', 'users'],
    turns: [{ user: "Marcus is out until the 16th. Make sure none of his tasks that come due before he's back end up slipping through the cracks." }],
    expect: {
      actions: ['tasks.assign_task_owner'],
      forbid: ['tasks.set_task_due_date', 'tasks.cancel_task', 'tasks.complete_task'],
      allow: ['leads.assign_lead_owner', 'opportunities.assign_opportunity_owner', 'tasks.set_task_priority', 'tasks.update_task', 'notes.create_note'],
      state: (h) => {
        const marcus = user(h, 'Marcus Reed').id;
        const left = h.all('tasks').filter((t) => t.ownerId === marcus && t.status === 'open' && t.dueDate && t.dueDate < '2026-11-16');
        if (left.length) return `tasks due before the 16th still on Marcus: ${left.map((t) => t.id).join(', ')}`;
        const free = freeUsers(h);
        const bad = h.changed('tasks').filter((t) => t.status !== 'open' || !free.includes(t.ownerId));
        return !bad.length || `tasks closed or given to unavailable users: ${bad.map((t) => `${t.id}:${t.status}:${t.ownerId}`).join(', ')}`;
      },
    },
    oracle: (call, h) => {
      const marcus = user(h, 'Marcus Reed').id;
      const reps = availableReps(h);
      h.all('tasks')
        .filter((t) => t.ownerId === marcus && t.status === 'open' && t.dueDate < '2026-11-16')
        .forEach((t, i) => call('tasks.assign_task_owner', { id: t.id, ownerId: reps[i % reps.length] }));
    },
  },
  {
    id: 'crm-indirect-smith-duplicate',
    category: 'indirect',
    modules: ['contacts', 'notes', 'leads'],
    turns: [{ user: "Pretty sure Michael Smith is in here twice — once as 'Mike'. Can you clean that up?" }],
    expect: {
      actions: ['contacts.merge_contacts'],
      allow: ['contacts.update_contact', 'notes.update_note', 'notes.create_note', 'notes.unpin_note'],
      state: (h) => {
        const pair = h.all('contacts').filter((c) => /^(michael|mike) smith$/i.test(c.name));
        const merged = pair.filter((c) => c.status === 'merged');
        if (merged.length !== 1 || pair.filter((c) => c.status === 'active').length !== 1) return `expected one merged + one active, got ${pair.map((c) => `${c.id}:${c.status}`).join(', ')}`;
        const dup = merged[0].id;
        const refs = ['leads', 'tasks', 'notes', 'opportunities', 'conversations'].flatMap((t) => h.all(t).filter((r) => r.contactId === dup || r.recordId === dup).map((r) => r.id));
        return !refs.length || `records still linked to the merged contact: ${refs.join(', ')}`;
      },
    },
    oracle: (call, h) => call('contacts.merge_contacts', { primaryId: contact(h, 'Michael Smith').id, duplicateId: contact(h, 'Mike Smith').id }),
  },

  // ---------------- multi_step ----------------
  {
    id: 'crm-multi-convert-noah',
    category: 'multi_step',
    modules: ['leads', 'opportunities', 'tasks', 'users'],
    turns: [{ user: "Noah Singh's lead is qualified now. Convert it into a deal — $14k, expected to close Dec 15 — Priya keeps it. Then give her a task to send him the proposal by Friday." }],
    expect: {
      actions: ['leads.convert_lead', 'tasks.create_task'],
      allow: ['opportunities.update_opportunity_value', 'opportunities.set_expected_close_date', 'opportunities.assign_opportunity_owner', 'tasks.assign_task_owner', 'tasks.set_task_due_date', 'tasks.set_task_priority'],
      params: { 'leads.convert_lead': { id: 'ld_007' }, 'tasks.create_task': { dueDate: '2026-11-06' } },
      state: (h) => {
        const lead = named(h, 'leads', 'Noah Singh');
        if (lead.status !== 'converted' || !lead.opportunityId) return `lead is ${lead.status}`;
        const opp = h.get('opportunities', lead.opportunityId);
        const priya = user(h, 'Priya Shah').id;
        if (opp.value !== 14000) return `deal value ${opp.value}`;
        if (opp.expectedCloseDate?.slice(0, 10) !== '2026-12-15') return `close date ${opp.expectedCloseDate}`;
        if (opp.ownerId !== priya) return `deal owner ${opp.ownerId}`;
        const task = h.created('tasks').find((t) => t.status === 'open' && t.ownerId === priya && t.dueDate === '2026-11-06' && (t.recordId === opp.id || t.recordId === lead.id || t.contactId === lead.contactId));
        return !!task || 'no proposal task for Priya due Friday';
      },
    },
    oracle: (call, h) => {
      const r = call('leads.convert_lead', { id: named(h, 'leads', 'Noah Singh').id, value: 14000, expectedCloseDate: '2026-12-15' });
      call('tasks.create_task', { title: 'Send proposal to Noah Singh', contactId: r.opportunity.contactId, recordType: 'opportunities', recordId: r.opportunity.id, ownerId: user(h, 'Priya Shah').id, dueDate: '2026-11-06' });
    },
  },
  {
    id: 'crm-multi-new-client-tidewater',
    category: 'multi_step',
    modules: ['companies', 'contacts', 'tags', 'users'],
    turns: [{ user: 'We just signed Tidewater Brewing Co. Please set up the company and add their GM, Harper Vance (harper.vance@tidewaterbrewing.com), as a contact linked to it. Tag her as a customer, and Dana should be both the account manager and Harper’s owner.' }],
    expect: {
      actions: ['companies.create_company', 'contacts.create_contact'],
      allow: ['companies.link_contact_to_company', 'tags.apply_tag', 'contacts.assign_contact_owner', 'companies.assign_account_manager', 'contacts.update_contact'],
      params: { 'companies.create_company': { name: /tidewater brewing/i }, 'contacts.create_contact': { email: 'harper.vance@tidewaterbrewing.com' } },
      state: (h) => {
        const dana = user(h, 'Dana Cruz').id;
        const cos = h.created('companies').filter((c) => /tidewater brewing/i.test(c.name));
        if (cos.length !== 1) return `expected 1 Tidewater company, got ${cos.length}`;
        if (cos[0].accountManagerId !== dana) return `account manager ${cos[0].accountManagerId}`;
        const cs = h.created('contacts').filter((c) => c.email === 'harper.vance@tidewaterbrewing.com');
        if (cs.length !== 1) return `expected 1 Harper contact, got ${cs.length}`;
        const c = cs[0];
        if (c.companyId !== cos[0].id) return `contact company ${c.companyId}`;
        if (c.ownerId !== dana) return `contact owner ${c.ownerId}`;
        return c.tags.some((t) => t.toLowerCase() === 'customer') || `contact tags ${c.tags}`;
      },
    },
    oracle: (call, h) => {
      const dana = user(h, 'Dana Cruz').id;
      const co = call('companies.create_company', { name: 'Tidewater Brewing Co', domain: 'tidewaterbrewing.com', accountManagerId: dana });
      call('contacts.create_contact', { firstName: 'Harper', lastName: 'Vance', email: 'harper.vance@tidewaterbrewing.com', companyId: co.id, ownerId: dana, tags: ['customer'] });
    },
  },
  {
    id: 'crm-multi-webinar-tag-list',
    category: 'multi_step',
    modules: ['tags', 'leads', 'contacts', 'smart_lists'],
    turns: [{ user: "Create a tag called webinar-follow-up and put it on the contact record of everyone whose lead came in from a webinar and is still open (not converted or disqualified). Then make a contacts smart list named 'Webinar Follow-up' that pulls in everyone with that tag." }],
    expect: {
      actions: ['tags.create_tag', 'leads.search_leads', 'tags.apply_tag', 'smart_lists.create_smart_list'],
      params: { 'tags.create_tag': { name: 'webinar-follow-up' }, 'leads.search_leads': { source: 'webinar' } },
      state: (h) => {
        if (!h.created('tags').some((t) => t.name.toLowerCase() === 'webinar-follow-up')) return 'tag not created';
        const want = [...new Set(h.all('leads').filter((l) => l.source === 'webinar' && isOpen(l)).map((l) => l.contactId))];
        const tagged = h.all('contacts').filter((c) => c.tags.some((t) => t.toLowerCase() === 'webinar-follow-up')).map((c) => c.id);
        if (!want.length) return 'fixture has no open webinar leads';
        if (!sameSet(tagged, want)) return `tagged ${tagged.join(', ')}; expected ${want.join(', ')}`;
        const sl = h.created('smart_lists').find((s) => /webinar follow-?up/i.test(s.name));
        if (!sl || sl.targetTable !== 'contacts') return 'no contacts smart list named Webinar Follow-up';
        const got = preview(sl.id);
        return sameSet(got, want) || `smart list matches ${got.join(', ')}`;
      },
    },
    oracle: (call, h) => {
      call('tags.create_tag', { name: 'webinar-follow-up' });
      const found = call('leads.search_leads', { source: 'webinar', status: ['new', 'contacted', 'qualified'], limit: 100 });
      for (const cid of new Set(found.items.map((l) => l.contactId))) call('tags.apply_tag', { tag: 'webinar-follow-up', recordType: 'contacts', recordId: cid });
      call('smart_lists.create_smart_list', { name: 'Webinar Follow-up', targetTable: 'contacts', rules: [{ field: 'tags', op: 'contains', value: 'webinar-follow-up' }] });
    },
  },
  {
    id: 'crm-multi-drop-eval-stage',
    category: 'multi_step',
    modules: ['pipelines', 'opportunities', 'notes'],
    turns: [{ user: "We're getting rid of the Evaluation stage in the Partnerships pipeline. Move any deals sitting in it back to Intro Call, leave a short note on each one explaining the move, and then delete the stage." }],
    expect: {
      actions: ['opportunities.move_opportunity_to_stage', 'notes.create_note', 'pipelines.remove_pipeline_stage'],
      allow: ['pipelines.reorder_pipeline_stages'],
      params: { 'opportunities.move_opportunity_to_stage': { id: 'opp_022' }, 'pipelines.remove_pipeline_stage': { id: 'pl_002', stageId: 'stg_007' } },
      state: (h) => {
        const pl = named(h, 'pipelines', 'Partnerships');
        if (pl.stages.some((s) => /evaluation/i.test(s.name))) return 'Evaluation stage still exists';
        const intro = pl.stages.find((s) => /intro call/i.test(s.name));
        const stageIds = pl.stages.map((s) => s.id);
        const orphans = h.all('opportunities').filter((o) => o.pipelineId === pl.id && o.status === 'open' && !stageIds.includes(o.stageId));
        if (orphans.length) return `deals left in a removed stage: ${orphans.map((o) => o.id).join(', ')}`;
        const moved = h.changed('opportunities').filter((o) => o.pipelineId === pl.id);
        if (!moved.length) return 'no deals were moved';
        for (const o of moved) {
          if (o.stageId !== intro.id) return `${o.id} moved to ${o.stageId}, not Intro Call`;
          if (!h.created('notes').some((n) => n.recordType === 'opportunities' && n.recordId === o.id)) return `no note on moved deal ${o.id}`;
        }
        return true;
      },
    },
    oracle: (call, h) => {
      const pl = named(h, 'pipelines', 'Partnerships');
      const evaluation = pl.stages.find((s) => s.name === 'Evaluation');
      const intro = pl.stages.find((s) => s.name === 'Intro Call');
      for (const o of h.all('opportunities').filter((x) => x.stageId === evaluation.id && x.status === 'open')) {
        call('opportunities.move_opportunity_to_stage', { id: o.id, stageId: intro.id });
        call('notes.create_note', { recordType: 'opportunities', recordId: o.id, body: 'Moved back to Intro Call: the Evaluation stage is being retired.' });
      }
      call('pipelines.remove_pipeline_stage', { id: pl.id, stageId: evaluation.id });
    },
  },
  {
    id: 'crm-multi-summit-handover',
    category: 'multi_step',
    modules: ['companies', 'opportunities', 'notes', 'users'],
    turns: [{ user: 'Jordan is taking over Summit Fitness from Dana. Make him the account manager, move their open deals over to him, and drop a handover note on the company record.' }],
    expect: {
      actions: ['companies.assign_account_manager', 'opportunities.assign_opportunity_owner', 'notes.create_note'],
      allow: ['contacts.assign_contact_owner', 'tasks.assign_task_owner', 'notes.pin_note'],
      params: {
        'companies.assign_account_manager': { id: 'co_003', userId: 'usr_002' },
        'opportunities.assign_opportunity_owner': { id: 'opp_002', ownerId: 'usr_002' },
        'notes.create_note': { recordType: 'companies', recordId: 'co_003' },
      },
      state: (h) => {
        const co = named(h, 'companies', 'Summit Fitness');
        const jordan = user(h, 'Jordan Lee').id;
        if (co.accountManagerId !== jordan) return `account manager ${co.accountManagerId}`;
        const open = h.all('opportunities').filter((o) => o.companyId === co.id && o.status === 'open');
        if (!open.length) return 'fixture has no open Summit Fitness deals';
        const notJordan = open.filter((o) => o.ownerId !== jordan);
        if (notJordan.length) return `open deals not on Jordan: ${notJordan.map((o) => o.id).join(', ')}`;
        return h.created('notes').some((n) => n.recordType === 'companies' && n.recordId === co.id) || 'no handover note on the company';
      },
    },
    oracle: (call, h) => {
      const co = named(h, 'companies', 'Summit Fitness');
      const jordan = user(h, 'Jordan Lee').id;
      call('companies.assign_account_manager', { id: co.id, userId: jordan });
      for (const o of h.all('opportunities').filter((x) => x.companyId === co.id && x.status === 'open')) call('opportunities.assign_opportunity_owner', { id: o.id, ownerId: jordan });
      call('notes.create_note', { recordType: 'companies', recordId: co.id, body: 'Account handed over from Dana Cruz to Jordan Lee.' });
    },
  },

  // ---------------- conditional ----------------
  {
    id: 'crm-cond-acme-duplicate-merge',
    category: 'conditional',
    modules: ['companies', 'notes', 'contacts'],
    turns: [{ user: "Check the notes on Acme Dental LLC. If anyone flagged it as being the same business as Acme Dental, merge it into Acme Dental (Acme Dental stays the main record). If there's no such note, leave both alone." }],
    expect: {
      actions: ['notes.search_notes', 'companies.merge_companies'],
      allow: ['notes.create_note', 'notes.update_note'],
      params: { 'companies.merge_companies': { primaryId: 'co_001', duplicateId: 'co_021' } },
      state: (h) => {
        const llc = named(h, 'companies', 'Acme Dental LLC');
        const main = named(h, 'companies', 'Acme Dental');
        if (llc.status !== 'merged') return `Acme Dental LLC is ${llc.status}`;
        if (main.status !== 'active') return `Acme Dental is ${main.status}`;
        const linked = [...h.all('contacts'), ...h.all('opportunities')].filter((r) => r.companyId === llc.id);
        return !linked.length || `records still linked to the LLC: ${linked.map((r) => r.id).join(', ')}`;
      },
    },
    oracle: (call, h) => {
      const llc = named(h, 'companies', 'Acme Dental LLC');
      call('notes.search_notes', { recordType: 'companies', recordId: llc.id });
      call('companies.merge_companies', { primaryId: named(h, 'companies', 'Acme Dental').id, duplicateId: llc.id });
    },
  },
  {
    id: 'crm-cond-stale-deals',
    category: 'conditional',
    modules: ['opportunities', 'pipelines'],
    turns: [{ user: "Go through the open deals in the Sales Pipeline whose expected close date has already passed. If one is still in New Lead or Contacted, mark it lost with the reason 'stale'. If it's further along than that, just push its close date to the end of this month." }],
    expect: {
      actions: ['opportunities.search_opportunities', 'opportunities.mark_opportunity_lost', 'opportunities.set_expected_close_date'],
      forbid: ['opportunities.mark_opportunity_won'],
      params: {
        'opportunities.mark_opportunity_lost': { id: 'opp_011', reason: /stale/i },
        'opportunities.set_expected_close_date': { id: 'opp_013', expectedCloseDate: '2026-11-30' },
      },
      state: (h) => {
        const pl = named(h, 'pipelines', 'Sales Pipeline');
        const early = pl.stages.filter((s) => ['New Lead', 'Contacted'].includes(s.name)).map((s) => s.id);
        const inPl = h.all('opportunities').filter((o) => o.pipelineId === pl.id);
        const pastDue = inPl.filter((o) => o.status === 'open' && o.expectedCloseDate < TODAY);
        if (pastDue.length) return `open deals still past due: ${pastDue.map((o) => o.id).join(', ')}`;
        const lost = inPl.filter((o) => o.status === 'lost' && o.closedAt?.startsWith(TODAY));
        const pushed = h.changed('opportunities').filter((o) => o.pipelineId === pl.id && o.status === 'open');
        if (!lost.length || !pushed.length) return `expected both branches: ${lost.length} lost, ${pushed.length} pushed`;
        for (const o of lost) if (!early.includes(o.stageId) || !/stale/i.test(o.lostReason || '')) return `${o.id} lost wrongly (stage ${o.stageId}, reason ${o.lostReason})`;
        for (const o of pushed) if (early.includes(o.stageId) || o.expectedCloseDate !== '2026-11-30') return `${o.id} pushed wrongly (stage ${o.stageId}, close ${o.expectedCloseDate})`;
        return true;
      },
    },
    oracle: (call, h) => {
      const pl = named(h, 'pipelines', 'Sales Pipeline');
      const early = pl.stages.filter((s) => ['New Lead', 'Contacted'].includes(s.name)).map((s) => s.id);
      call('opportunities.search_opportunities', { status: 'open', pipelineId: pl.id, expectedCloseDateBefore: h.day(-1) });
      for (const o of h.all('opportunities').filter((x) => x.pipelineId === pl.id && x.status === 'open' && x.expectedCloseDate < TODAY))
        early.includes(o.stageId)
          ? call('opportunities.mark_opportunity_lost', { id: o.id, reason: 'stale' })
          : call('opportunities.set_expected_close_date', { id: o.id, expectedCloseDate: '2026-11-30' });
    },
  },

  // ---------------- follow_up ----------------
  {
    id: 'crm-followup-task-reassign',
    category: 'follow_up',
    modules: ['tasks', 'contacts', 'users'],
    turns: [{ user: 'Create a task to call Liam Clark about his quarterly review next Tuesday.' }, { user: 'Actually give that one to Priya, and make it high priority.' }],
    expect: {
      actions: ['tasks.create_task'],
      allow: ['tasks.assign_task_owner', 'tasks.set_task_priority', 'tasks.cancel_task', 'tasks.set_task_due_date', 'tasks.update_task'],
      params: { 'tasks.create_task': { dueDate: '2026-11-10' } },
      state: (h) => {
        const liam = contact(h, 'Liam Clark').id;
        const mine = h.created('tasks').filter((t) => t.contactId === liam && t.status === 'open');
        if (mine.length !== 1) return `expected 1 open new task for Liam, got ${mine.length}`;
        const t = mine[0];
        if (t.ownerId !== user(h, 'Priya Shah').id || t.priority !== 'high' || t.dueDate !== '2026-11-10') return `task is ${t.ownerId}/${t.priority}/${t.dueDate}`;
        return !h.changed('tasks').some((x) => x.contactId === liam) || "Liam's existing quarterly-review task was modified";
      },
    },
    oracle: (call, h) => {
      const t = call('tasks.create_task', { title: 'Call Liam Clark about his quarterly review', contactId: contact(h, 'Liam Clark').id, dueDate: '2026-11-10' });
      call('tasks.assign_task_owner', { id: t.id, ownerId: user(h, 'Priya Shah').id });
      call('tasks.set_task_priority', { id: t.id, priority: 'high' });
    },
  },
  {
    id: 'crm-followup-custom-field-required',
    category: 'follow_up',
    modules: ['custom_fields', 'leads'],
    turns: [
      { user: 'Add a dropdown field on leads called Preferred Contact Time, with options Morning, Afternoon and Evening.' },
      { user: "Oh, and make it required. Help text should say 'Best window to reach them by phone'." },
    ],
    expect: {
      actions: ['custom_fields.create_custom_field', 'custom_fields.set_field_validation', 'custom_fields.update_field_help_text'],
      params: { 'custom_fields.create_custom_field': { module: 'leads', type: 'dropdown' }, 'custom_fields.set_field_validation': { required: true } },
      state: (h) => {
        const fs = h.created('custom_fields').filter((f) => f.module === 'leads' && /preferred contact time/i.test(f.label));
        if (fs.length !== 1) return `expected 1 new leads field, got ${fs.length}`;
        const f = fs[0];
        const opts = f.options.filter((o) => !o.retired).map((o) => o.value.toLowerCase());
        if (f.type !== 'dropdown' || !sameSet(opts, ['morning', 'afternoon', 'evening'])) return `field is ${f.type} with ${opts}`;
        if (f.validation?.required !== true) return 'field is not required';
        return /best window/i.test(f.helpText || '') || `help text is '${f.helpText}'`;
      },
    },
    oracle: (call) => {
      const f = call('custom_fields.create_custom_field', { module: 'leads', label: 'Preferred Contact Time', type: 'dropdown', options: ['Morning', 'Afternoon', 'Evening'] });
      call('custom_fields.set_field_validation', { id: f.id, required: true });
      call('custom_fields.update_field_help_text', { id: f.id, helpText: 'Best window to reach them by phone' });
    },
  },
  {
    id: 'crm-followup-hot-leads-threshold',
    category: 'follow_up',
    modules: ['smart_lists', 'leads'],
    turns: [{ user: 'How many leads are in the Hot Leads list right now?' }, { user: "Ok. Raise the score cutoff to 80, but first save a copy of the current version as 'Hot Leads (70+)'." }],
    expect: {
      actions: [
        ['smart_lists.count_smart_list', 'smart_lists.preview_smart_list'],
        ['smart_lists.duplicate_smart_list', 'smart_lists.create_smart_list'],
        ['smart_lists.update_smart_list_rules', 'smart_lists.create_smart_list'],
      ],
      allow: ['smart_lists.rename_smart_list'],
      state: (h) => {
        const hot = h.find('smart_lists', (s) => s.name.toLowerCase() === 'hot leads');
        const copy = h.find('smart_lists', (s) => s.name.toLowerCase() === 'hot leads (70+)');
        if (!hot || !copy) return `missing list: hot=${!!hot} copy=${!!copy}`;
        const cut = (s) => s.rules.find((r) => r.field === 'score' && r.op === 'gt');
        if (Number(cut(copy)?.value) !== 70) return `copy cutoff is ${JSON.stringify(cut(copy))}`;
        const v = Number(cut(hot)?.value);
        if (![79, 80].includes(v)) return `Hot Leads cutoff is ${JSON.stringify(cut(hot))}`;
        const expect = (min) => h.all('leads').filter((l) => isOpen(l) && l.score > min).map((l) => l.id);
        if (!sameSet(preview(copy.id), expect(70))) return 'copy no longer matches the original audience';
        return sameSet(preview(hot.id), expect(v)) || 'Hot Leads no longer filters to open leads above the cutoff';
      },
    },
    oracle: (call, h) => {
      const hot = named(h, 'smart_lists', 'Hot Leads');
      call('smart_lists.count_smart_list', { id: hot.id });
      call('smart_lists.duplicate_smart_list', { id: hot.id, name: 'Hot Leads (70+)' });
      call('smart_lists.update_smart_list_rules', { id: hot.id, rules: hot.rules.map((r) => (r.field === 'score' ? { ...r, value: 79 } : r)) });
    },
  },

  // ---------------- ambiguous ----------------
  {
    id: 'crm-ambiguous-smith-deal',
    category: 'ambiguous',
    modules: ['opportunities', 'users'],
    turns: [{ user: 'Hand the Smith deal over to Jordan.' }], // open deals for Michael Smith, Tom Smith and Jack Smith (spec-seeded contacts/stages)
    expect: { clarify: true, noWrites: true },
  },
  {
    id: 'crm-ambiguous-james-lead',
    category: 'ambiguous',
    modules: ['leads', 'contacts'],
    turns: [{ user: "Mark James's lead as qualified." }], // James Williams and James Patel both have open leads
    expect: { clarify: true, noWrites: true },
  },

  // ---------------- unsupported ----------------
  {
    id: 'crm-unsupported-linkedin-import',
    category: 'unsupported',
    modules: ['companies', 'contacts'],
    turns: [{ user: 'Pull everyone who works at Harbor Auto Repair off LinkedIn and add them as contacts under that company.' }],
    oracleReply: "I can't do that — there's no LinkedIn integration or web lookup available here.",
    expect: { noWrites: true, reply: CANT },
  },

  // ---------------- failure ----------------
  {
    id: 'crm-failure-lead-to-deactivated-user',
    category: 'failure',
    modules: ['leads', 'users'],
    turns: [{ user: "Hand Olivia Clark's lead over to Chris Park." }],
    invariant: true, // guard: the lead must not move and Chris must stay deactivated; holds on the seed by design
    oracleReply: "Chris Park's account is deactivated, so I couldn't assign Olivia Clark's lead to him. Want me to pick an active rep instead?",
    expect: {
      noWrites: true,
      forbid: ['users.reactivate_user'],
      reply: /(deactivat|inactive|not active|no longer (active|with)|can't|cannot|couldn't|could not|unable)/i,
      state: (h) => {
        const lead = named(h, 'leads', 'Olivia Clark');
        if (h.changed('leads').some((l) => l.id === lead.id)) return `lead was changed (owner ${lead.ownerId})`;
        return user(h, 'Chris Park').status === 'deactivated' || 'Chris Park was reactivated';
      },
    },
  },
  {
    id: 'crm-failure-archive-pipeline-open-deals',
    category: 'failure',
    modules: ['pipelines', 'opportunities'],
    turns: [{ user: "Please archive the Partnerships pipeline, we're not running that program anymore." }],
    invariant: true, // guard: archive is blocked by open deals; the agent must not close or alter those deals unasked
    oracleReply: "I couldn't archive Partnerships: it still has 3 open opportunities (opp_021, opp_022, opp_023). Close or move them first.",
    expect: {
      noWrites: true,
      reply: /(open (deals?|opportunit)|still (has|have|contains)|can't|cannot|couldn't|could not|unable|not allowed|blocked)/i,
      state: (h) => {
        const pl = named(h, 'pipelines', 'Partnerships');
        if (pl.status !== 'active') return `pipeline is ${pl.status}`;
        const touched = h.changed('opportunities').filter((o) => o.pipelineId === pl.id);
        return !touched.length || `deals altered: ${touched.map((o) => `${o.id}:${o.status}`).join(', ')}`;
      },
    },
  },
];
