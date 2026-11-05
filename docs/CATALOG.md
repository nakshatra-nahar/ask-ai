# Action catalog

50 modules · 500 actions. Generated from the registry (`npm run catalog -w server`). Signature notation: `param?` = optional. Risk: read · write · destructive · external (destructive/external require user confirmation).

- [M01 Contacts](#m01-contacts)
- [M02 Companies](#m02-companies)
- [M03 Leads](#m03-leads)
- [M04 Opportunities](#m04-opportunities)
- [M05 Pipelines](#m05-pipelines)
- [M06 Tasks](#m06-tasks)
- [M07 Notes](#m07-notes)
- [M08 Tags](#m08-tags)
- [M09 Smart Lists](#m09-smart-lists)
- [M10 Custom Fields](#m10-custom-fields)
- [M11 Conversations](#m11-conversations)
- [M12 SMS](#m12-sms)
- [M13 Email](#m13-email)
- [M14 Message Templates](#m14-message-templates)
- [M15 Campaigns](#m15-campaigns)
- [M16 Workflows](#m16-workflows)
- [M17 Event Triggers](#m17-event-triggers)
- [M18 Forms](#m18-forms)
- [M19 Surveys](#m19-surveys)
- [M20 Calendars](#m20-calendars)
- [M21 Appointments](#m21-appointments)
- [M22 Availability](#m22-availability)
- [M23 Booking Pages](#m23-booking-pages)
- [M24 Events](#m24-events)
- [M25 Products](#m25-products)
- [M26 Prices](#m26-prices)
- [M27 Quotes](#m27-quotes)
- [M28 Invoices](#m28-invoices)
- [M29 Payments](#m29-payments)
- [M30 Subscriptions](#m30-subscriptions)
- [M31 Coupons](#m31-coupons)
- [M32 Orders](#m32-orders)
- [M33 Refunds](#m33-refunds)
- [M34 Tax Rules](#m34-tax-rules)
- [M35 Websites](#m35-websites)
- [M36 Funnels](#m36-funnels)
- [M37 Landing Pages](#m37-landing-pages)
- [M38 Blogs](#m38-blogs)
- [M39 Media Assets](#m39-media-assets)
- [M40 Courses](#m40-courses)
- [M41 Lessons](#m41-lessons)
- [M42 Enrollments](#m42-enrollments)
- [M43 Communities](#m43-communities)
- [M44 Memberships](#m44-memberships)
- [M45 Reviews](#m45-reviews)
- [M46 Business Listings](#m46-business-listings)
- [M47 Support Tickets](#m47-support-tickets)
- [M48 Users](#m48-users)
- [M49 Teams](#m49-teams)
- [M50 Reports](#m50-reports)

## M01 Contacts

Manage people and their CRM profiles.

| action | risk | signature / description |
|---|---|---|
| Create contact | write | `contacts.create_contact(firstName: string, lastName?: string, email?: string, phone?: string, companyId?: string, ownerId?: string, source?: string, tags?: string[], lifecycleStage?: "subscriber"\|"lead"\|"opportunity"\|"customer"\|"churned")` — Create a new person/contact record. Rejects duplicate emails. |
| Get contact details | read | `contacts.get_contact(id: string)` — Fetch one contact by ID. |
| Search contacts | read | `contacts.search_contacts(tags?: string, ownerId?: string, companyId?: string, source?: string, lifecycleStage?: "subscriber"\|"lead"\|"opportunity"\|"customer"\|"churned", status?: "active"\|"archived"\|"merged", createdAtAfter?: string, createdAtBefore?: string, limit?: integer, query?: string)` — Find contacts by name/email/phone text, tag, owner, company, source, lifecycle stage, or created date range. Archived/merged excluded unless status is given. |
| Update contact details | write | `contacts.update_contact(id: string, firstName?: string, lastName?: string, email?: string, phone?: string, source?: string, companyId?: string, lifecycleStage?: "subscriber"\|"lead"\|"opportunity"\|"customer"\|"churned")` — Change name, email, phone, source, company, or lifecycle stage of a contact. |
| Archive contact | destructive | `contacts.archive_contact(id: string)` — Archive (soft-delete) an active contact. |
| Merge duplicate contacts | destructive | `contacts.merge_contacts(primaryId: string, duplicateId: string)` — Merge a duplicate contact into a primary one: fills blank fields, unions tags, keeps any channel opt-out, re-points all linked records (leads, tasks, conversations, messages, appointments, invoices, payments, notes, opportunities…) and marks the duplicate merged. |
| Assign contact owner | write | `contacts.assign_contact_owner(id: string, ownerId: string)` — Set the user who owns a contact. Owner must be an active user. |
| Set communication preferences | write | `contacts.set_communication_preferences(id: string, email?: boolean, sms?: boolean, call?: boolean)` — Opt a contact in/out of email, SMS, or calls (do-not-disturb per channel). |
| Add contact relationship | write | `contacts.add_contact_relationship(id: string, relatedContactId: string, type: "spouse"\|"family"\|"colleague"\|"assistant"\|"referrer"\|"partner"\|"other")` — Link two contacts with a relationship type (spouse, colleague, referrer...). |
| View contact activity timeline | read | `contacts.get_contact_timeline(id: string, limit?: integer)` — Chronological activity for a contact: messages, appointments, tasks, notes, invoices and logged actions. |

## M02 Companies

Manage business accounts and linked contacts.

| action | risk | signature / description |
|---|---|---|
| Create company | write | `companies.create_company(name: string, domain?: string, industry?: string, phone?: string, address?: string, accountManagerId?: string)` — Create a business account (organization), not a person. Rejects duplicate names or domains. |
| Get company details | read | `companies.get_company(id: string)` — Fetch one business account with its account manager name, linked contact count, and open deal count/value. |
| Search companies | read | `companies.search_companies(industry?: string, accountManagerId?: string, status?: "active"\|"archived"\|"merged", limit?: integer, query?: string)` — Find business accounts by name/domain text, industry, or account manager. Archived/merged excluded unless status is given. For people use contacts.search_contacts. |
| Update company details | write | `companies.update_company(id: string, name?: string, domain?: string, industry?: string, phone?: string, address?: string)` — Change name, domain, industry, phone or address of an active company. |
| Archive company | destructive | `companies.archive_company(id: string)` — Archive (soft-delete) an active company. Linked contacts keep their companyId. |
| Link contact to company | write | `companies.link_contact_to_company(id: string, contactId: string, replaceExisting?: boolean)` — Make a contact a member of a company (sets contact.companyId). If the contact already belongs to another company, pass replaceExisting to move them. |
| Unlink contact from company | write | `companies.unlink_contact_from_company(id: string, contactId: string)` — Remove a contact from a company (clears contact.companyId). The contact itself is kept. |
| Assign account manager | write | `companies.assign_account_manager(id: string, userId: string)` — Set the user who manages a company account (account-level owner; for a person use contacts.assign_contact_owner, for a lead leads.assign_lead_owner). |
| Merge duplicate companies | destructive | `companies.merge_companies(primaryId: string, duplicateId: string)` — Merge a duplicate company into a primary one: fills blank fields, re-points everything linked to it (contacts, opportunities, listings, notes, tasks…), and marks the duplicate merged. |
| List company contacts | read | `companies.list_company_contacts(id: string, limit?: integer)` — List the people (contacts) linked to a company. |

## M03 Leads

Capture, qualify, and route prospective customers.

| action | risk | signature / description |
|---|---|---|
| Create lead | write | `leads.create_lead(contactId?: string, name?: string, email?: string, phone?: string, source: "facebook"\|"google_ads"\|"website"\|"referral"\|"webinar"\|"walk_in", campaignId?: string, ownerId?: string, score?: integer)` — Capture a new sales lead (prospect inquiry) with its source/campaign, linked to an existing contact or with name/email. Rejects a second open lead for the same contact. To add a person to the CRM use contacts.create_contact. |
| Get lead details | read | `leads.get_lead(id: string)` — Fetch one lead by ID (source, campaign, status, score, owner, qualification answers). |
| Search leads | read | `leads.search_leads(query?: string, status?: "new"\|"contacted"\|"qualified"\|"disqualified"\|"converted"\|"new"\|"contacted"\|"qualified"\|"disqualified"\|"converted"[], source?: "facebook"\|"google_ads"\|"website"\|"referral"\|"webinar"\|"walk_in", campaignId?: string, ownerId?: string, contactId?: string, contactIds?: string[], createdAtAfter?: string, createdAtBefore?: string, scoreMin?: number, scoreMax?: number, unassigned?: boolean, limit?: integer)` — Find sales leads (prospects with source/campaign/status/score/owner) — not general contact lookup (contacts.search_contacts). Filter by status, source, campaignId, ownerId, unassigned, contactId(s), score range, created date range, or name/email/phone text. Newest first. |
| Update lead details | write | `leads.update_lead(id: string, name?: string, email?: string, phone?: string, status?: "new"\|"contacted"\|"qualified")` — Edit an open lead's name, email, phone or pipeline status (new/contacted/qualified). Use disqualify_lead / convert_lead to close it. |
| Assign lead owner | write | `leads.assign_lead_owner(id: string, ownerId: string)` — Assign or reassign an open lead to a sales rep. User must be active (not deactivated/invited); out-of-office users are allowed but a warning is returned. |
| Set lead source | write | `leads.set_lead_source(id: string, source: "facebook"\|"google_ads"\|"website"\|"referral"\|"webinar"\|"walk_in", campaignId?: string,null)` — Correct where a lead came from (source channel and optionally the campaign that produced it). |
| Record qualification answers | write | `leads.record_qualification_answers(id: string, answers: object, markQualified?: boolean)` — Save qualification answers (budget, timeline, authority, need…) on an open lead; merges with earlier answers and can mark it qualified. |
| Update lead score | write | `leads.update_lead_score(id: string, score: integer)` — Set the 0-100 lead score of an open lead. |
| Disqualify lead with reason | write | `leads.disqualify_lead(id: string, reason: string)` — Close an open lead as disqualified (not a fit). A reason is required. |
| Convert lead to opportunity | write | `leads.convert_lead(id: string, opportunityName?: string, value?: number, expectedCloseDate?: string)` — Convert an open lead into a deal: creates an opportunity in the default pipeline's first stage, marks the lead converted and links them. Fails if already converted or disqualified. |

## M04 Opportunities

Track individual deals through the sales process.

| action | risk | signature / description |
|---|---|---|
| Create opportunity | write | `opportunities.create_opportunity(name: string, contactId: string, value: number, currency?: string, pipelineId?: string, stageId?: string, ownerId?: string, expectedCloseDate?: string, companyId?: string, leadId?: string)` — Create a deal for a contact in a pipeline stage (defaults: default pipeline, its first stage, contact's company and owner). To turn an existing lead into a deal use leads.convert_lead instead. |
| Get opportunity details | read | `opportunities.get_opportunity(id: string)` — Fetch one deal by ID with its pipeline and stage names, stage win probability, contact name and owner name. |
| Search opportunities | read | `opportunities.search_opportunities(status?: "open"\|"won"\|"lost", pipelineId?: string, stageId?: string, ownerId?: string, contactId?: string, companyId?: string, leadId?: string, valueMin?: number, valueMax?: number, expectedCloseDateAfter?: string, expectedCloseDateBefore?: string, closedAtAfter?: string, closedAtBefore?: string, createdAtAfter?: string, createdAtBefore?: string, limit?: integer, query?: string)` — Find deals by name, status (open/won/lost), pipeline, stage, owner, contact, company, value range, expected close date, close date or created date. Searches deals, not leads (leads.search_leads). |
| Update opportunity value | write | `opportunities.update_opportunity_value(id: string, value: number)` — Change the monetary value of an open deal. |
| Move opportunity to stage | write | `opportunities.move_opportunity_to_stage(id: string, stageId: string)` — Move an open deal to another stage of its own pipeline (stage ID or name). To mark it won/lost use mark_opportunity_won / mark_opportunity_lost. |
| Assign opportunity owner | write | `opportunities.assign_opportunity_owner(id: string, ownerId: string)` — Set the sales rep who owns a deal. Owner must be an active user. |
| Set expected close date | write | `opportunities.set_expected_close_date(id: string, expectedCloseDate: string)` — Set the forecast close date of an open deal (today or later). |
| Mark opportunity won | write | `opportunities.mark_opportunity_won(id: string)` — Close an open deal as won (records closedAt). |
| Mark opportunity lost | write | `opportunities.mark_opportunity_lost(id: string, reason: string)` — Close an open deal as lost. A reason is required. |
| Reopen closed opportunity | write | `opportunities.reopen_opportunity(id: string)` — Reopen a won or lost deal so it is open again (clears closedAt/lostReason). If its stage was removed it goes to the first stage. |

## M05 Pipelines

Configure sales pipelines and their ordered stages.

| action | risk | signature / description |
|---|---|---|
| Create pipeline | write | `pipelines.create_pipeline(name: string, stages: {name: string, probability?: integer}[])` — Create a new sales pipeline with an ordered list of stages. Pipeline configuration only; to create a deal use opportunities.create_opportunity. |
| Get pipeline configuration | read | `pipelines.get_pipeline(id: string)` — Fetch one pipeline with its ordered stages (ids, names, win probabilities) plus open-opportunity count and value per stage. Use to find stage IDs. |
| List pipelines | read | `pipelines.list_pipelines(status?: "active"\|"archived", isDefault?: boolean, limit?: integer, query?: string)` — List sales pipelines (name, default flag, status, stages). Archived pipelines included unless status is given. |
| Rename pipeline | write | `pipelines.rename_pipeline(id: string, name: string)` — Rename an active pipeline. Names must be unique. |
| Archive pipeline | destructive | `pipelines.archive_pipeline(id: string)` — Archive an active pipeline. Not allowed for the default pipeline or while it still has open opportunities. |
| Add pipeline stage | write | `pipelines.add_pipeline_stage(id: string, name: string, probability?: integer, position?: integer)` — Add a new stage to a pipeline, at the end or at a 1-based position. |
| Rename pipeline stage | write | `pipelines.rename_pipeline_stage(id: string, stageId: string, name: string)` — Rename one stage of a pipeline (stage names unique per pipeline). |
| Reorder pipeline stages | write | `pipelines.reorder_pipeline_stages(id: string, orderedIds: string[])` — Set the order of all stages in a pipeline by passing every stage ID in the new order. |
| Remove empty pipeline stage | destructive | `pipelines.remove_pipeline_stage(id: string, stageId: string)` — Delete a stage from a pipeline. Fails with CONFLICT if any open opportunity sits in it; move those first with opportunities.move_opportunity_to_stage. |
| Set stage win probability | write | `pipelines.set_stage_probability(id: string, stageId: string, probability: integer)` — Set the win probability (0-100%) used for forecasting on one pipeline stage. |

## M06 Tasks

Organize work, deadlines, and assignments (to-dos, follow-ups, callbacks).

| action | risk | signature / description |
|---|---|---|
| Create task | write | `tasks.create_task(title: string, description?: string, contactId?: string, recordType?: string, recordId?: string, ownerId?: string, dueDate?: string, priority?: "low"\|"medium"\|"high")` — Create a to-do / follow-up task, optionally linked to a contact or any record (recordType = table name like leads, opportunities, invoices), with owner, due date and priority. |
| Get task details | read | `tasks.get_task(id: string)` — Fetch a task by ID. |
| Search tasks | read | `tasks.search_tasks(status?: "open"\|"completed"\|"cancelled", ownerId?: string, contactId?: string, contactIds?: string[], recordId?: string, priority?: "low"\|"medium"\|"high", dueDateAfter?: string, dueDateBefore?: string, overdue?: boolean, createdAtAfter?: string, limit?: integer, query?: string)` — Find tasks by text, status, owner, contact, linked record, priority, or due date range. overdue=true returns open tasks past due. |
| Update task description | write | `tasks.update_task(id: string, title?: string, description?: string)` — Change the title and/or description of a task. |
| Assign task owner | write | `tasks.assign_task_owner(id: string, ownerId: string)` — Assign a task to an active user. |
| Set task due date | write | `tasks.set_task_due_date(id: string, dueDate: string)` — Set or change the due date of an open task. |
| Set task priority | write | `tasks.set_task_priority(id: string, priority: "low"\|"medium"\|"high")` — Set task priority (low, medium, high). |
| Mark task complete | write | `tasks.complete_task(id: string)` — Mark an open task as completed. |
| Reopen task | write | `tasks.reopen_task(id: string)` — Reopen a completed or cancelled task. |
| Cancel task | write | `tasks.cancel_task(id: string)` — Cancel an open task (can be reopened later). |

## M07 Notes

Record internal notes on CRM records.

| action | risk | signature / description |
|---|---|---|
| Create note | write | `notes.create_note(recordType: string, recordId: string, body: string, pinned?: boolean)` — Write an internal (never sent) note on any record — contact, lead, opportunity, company, ticket… To message a customer use SMS/email instead. |
| Get note | read | `notes.get_note(id: string)` — Fetch one note by ID. |
| Search notes | read | `notes.search_notes(recordType?: string, recordId?: string, contactId?: string, authorId?: string, pinned?: boolean, createdAtAfter?: string, createdAtBefore?: string, limit?: integer, query?: string)` — Find internal notes by body text, attached record (recordType/recordId), contact, author, pinned flag or created date. Pinned first, then newest. |
| Update note | write | `notes.update_note(id: string, body: string)` — Replace a note's body; the previous text is kept in its revision history. |
| Delete note | destructive | `notes.delete_note(id: string)` — Permanently delete a note and its revision history. |
| Attach note to record | write | `notes.attach_note(id: string, recordType: string, recordId: string)` — Attach a note to a record (or move it from its current record to another). Moving unpins it. |
| Detach note from record | write | `notes.detach_note(id: string)` — Detach a note from its record, keeping it as a standalone note (also unpins it). |
| Pin note | write | `notes.pin_note(id: string)` — Pin a note to the top of its record (max 3 pinned per record; note must be attached). |
| Unpin note | write | `notes.unpin_note(id: string)` — Unpin a pinned note. |
| View note revision history | read | `notes.get_note_revisions(id: string)` — Show the edit history of a note: previous bodies, newest first, plus the current text. |

## M08 Tags

Label and organize records with tags.

| action | risk | signature / description |
|---|---|---|
| Create tag | write | `tags.create_tag(name: string, color?: string)` — Define a new tag (name + color) so it can be applied to records. Names are case-insensitively unique. |
| List tags | read | `tags.list_tags(limit?: integer, query?: string)` — List defined tags (name, color). For how often each is used, see tags.get_tag_usage. |
| Rename tag | write | `tags.rename_tag(id: string, name: string)` — Rename a tag everywhere: the tag definition, every record (contacts, etc.) that carries it, and smart-list rules, campaign audiences, workflow add-tag steps and tag-added triggers that reference it. |
| Set tag color | write | `tags.set_tag_color(id: string, color: string)` — Change the display color of a tag. |
| Delete unused tag | destructive | `tags.delete_tag(id: string)` — Permanently delete a tag definition. Fails with CONFLICT if any record still carries it; remove it from those records or merge it into another tag first. |
| Apply tag to record | write | `tags.apply_tag(tag: string, recordType: string, recordId: string)` — Add an existing tag to a record (contact, opportunity, …). The tag must already exist (tags.create_tag). |
| Remove tag from record | write | `tags.remove_tag_from_record(tag: string, recordType: string, recordId: string)` — Take a tag off one record. The tag definition is kept. |
| List records with tag | read | `tags.list_records_with_tag(tag: string, recordType?: string, limit?: integer)` — List every record (any table, or one recordType) that carries a tag. |
| Merge tags | destructive | `tags.merge_tags(fromTagId: string, intoTagId: string)` — Merge one tag into another: every record (and smart list, campaign audience, workflow, trigger) using the source tag gets the target tag instead, then the source tag is deleted. |
| View tag usage counts | read | `tags.get_tag_usage(recordType?: string)` — How many records carry each tag (total and per table), most used first. Also lists tag names found on records that have no tag definition. |

## M09 Smart Lists

Define dynamic audiences using saved filters.

| action | risk | signature / description |
|---|---|---|
| Create smart list | write | `smart_lists.create_smart_list(name: string, targetTable?: "contacts"\|"leads", rules: {field: string, op: "eq"\|"neq"\|"contains"\|"gt"\|"lt"\|"before"\|"after"\|"in"\|"exists", value?: string,number,boolean\|string,number,boolean[]}[])` — Save a dynamic audience: a named set of filter rules over contacts or leads that is re-evaluated live every time it is used (not a static list). |
| Get smart list definition | read | `smart_lists.get_smart_list(id: string)` — Fetch one smart list with its target table and filter rules. |
| List smart lists | read | `smart_lists.list_smart_lists(targetTable?: "contacts"\|"leads", limit?: integer, query?: string)` — List saved smart lists (audiences), optionally by target table or name. |
| Rename smart list | write | `smart_lists.rename_smart_list(id: string, name: string)` — Rename a smart list (names are unique). |
| Update filter rules | write | `smart_lists.update_smart_list_rules(id: string, rules: {field: string, op: "eq"\|"neq"\|"contains"\|"gt"\|"lt"\|"before"\|"after"\|"in"\|"exists", value?: string,number,boolean\|string,number,boolean[]}[])` — Replace the full set of filter rules of a smart list (pass all rules, not just the changed one). |
| Preview matching records | read | `smart_lists.preview_smart_list(id: string, limit?: integer)` — Evaluate a smart list now and return the first matching records (default 10). |
| Count matching records | read | `smart_lists.count_smart_list(id: string)` — Evaluate a smart list now and return how many records match (audience size). |
| Export matching records | read | `smart_lists.export_smart_list(id: string, fields?: string[])` — Evaluate a smart list and return the matching records as CSV text (chosen fields, or sensible defaults). |
| Duplicate smart list | write | `smart_lists.duplicate_smart_list(id: string, name?: string)` — Copy a smart list (same table and rules) under a new name, e.g. to tweak filters without changing the original. |
| Delete smart list | destructive | `smart_lists.delete_smart_list(id: string)` — Permanently delete a smart list definition (records are untouched). Fails if an active or scheduled campaign uses it as its audience. |

## M10 Custom Fields

Define and set extra data fields on CRM records.

| action | risk | signature / description |
|---|---|---|
| Create custom field | write | `custom_fields.create_custom_field(module: string, label: string, type: "text"\|"number"\|"date"\|"dropdown"\|"checkbox", key?: string, options?: string[], helpText?: string, required?: boolean)` — Define a new custom field (text, number, date, dropdown, checkbox) on a record type such as contacts, leads, opportunities or companies. |
| Get field definition | read | `custom_fields.get_custom_field(id: string)` — Fetch one custom field definition: key, type, options (incl. retired), help text, validation rules. |
| List fields for module | read | `custom_fields.list_custom_fields(module: string, type?: "text"\|"number"\|"date"\|"dropdown"\|"checkbox", status?: "active"\|"archived", limit?: integer, query?: string)` — List custom field definitions for one record type (module/table). Archived fields excluded unless status is given. |
| Rename field label | write | `custom_fields.rename_field_label(id: string, label: string)` — Change the display label of a custom field. The key (and stored values) stay the same. |
| Update field help text | write | `custom_fields.update_field_help_text(id: string, helpText: string)` — Set the help text shown under a custom field (empty string clears it). |
| Set field validation rules | write | `custom_fields.set_field_validation(id: string, required?: boolean, min?: number, max?: number, pattern?: string)` — Set validation on a custom field: required, min/max (number value or text length), pattern (regex, text only). Merges with existing rules. |
| Add dropdown option | write | `custom_fields.add_dropdown_option(id: string, value: string)` — Add a choice to a dropdown custom field (restores it if it was retired). |
| Retire dropdown option | write | `custom_fields.retire_dropdown_option(id: string, value: string)` — Retire a dropdown choice so it can no longer be selected; records that already have it keep their value. |
| Set record field value | write | `custom_fields.set_record_field_value(id: string, recordId: string, value: string,number,boolean,null)` — Write a custom field value on one record (e.g. a contact's birthday). Validates type, dropdown options and validation rules; null clears it. |
| Archive custom field | destructive | `custom_fields.archive_custom_field(id: string)` — Archive a custom field: hidden and no longer writable; existing record values are kept. |

## M11 Conversations

Manage conversation threads across channels.

| action | risk | signature / description |
|---|---|---|
| Get conversation | read | `conversations.get_conversation(id: string)` — Fetch one conversation thread (any channel) with its full message history in chronological order, plus internal comments. |
| Search conversations | read | `conversations.search_conversations(contactId?: string, contactIds?: string[], channel?: "sms"\|"email"\|"webchat", status?: "open"\|"closed", unread?: boolean, ownerId?: string, lastDirection?: "inbound"\|"outbound", lastMessageAtAfter?: string, lastMessageAtBefore?: string, hasInboundReply?: boolean, limit?: integer)` — Find inbox conversation threads (one per contact+channel) by contact(s), channel, open/closed, unread, owner, who wrote last, last-message date range, or whether the contact ever replied. Use this for "who replied / who has not replied" questions; to find individual messages use sms.search_sms_messages or email.search_email_messages. |
| Assign conversation owner | write | `conversations.assign_conversation_owner(id: string, ownerId: string)` — Assign a conversation thread to a staff user (must be active) who is responsible for replying. Does not change the contact owner. |
| Mark conversation read | write | `conversations.mark_conversation_read(id: string)` — Clear the unread flag on a conversation (does not reply to the contact). |
| Mark conversation unread | write | `conversations.mark_conversation_unread(id: string)` — Flag a conversation as unread so it resurfaces in the inbox. |
| Close conversation | write | `conversations.close_conversation(id: string)` — Close (resolve) an open conversation and clear its unread flag. A new inbound message reopens it automatically. |
| Reopen conversation | write | `conversations.reopen_conversation(id: string)` — Reopen a closed conversation thread. |
| Add internal comment | write | `conversations.add_internal_comment(id: string, body: string, mentionUserIds?: string[])` — Add a staff-only internal comment to a conversation thread (never sent to the contact). For CRM notes on a record use the notes module instead. |
| Summarize conversation history | read | `conversations.summarize_conversation(id: string)` — Deterministic summary of one conversation: inbound/outbound counts, first/last message dates, last inbound and outbound excerpts, and whether it is awaiting our reply or the contact's. |
| List unanswered conversations | read | `conversations.list_unanswered_conversations(channel?: "sms"\|"email"\|"webchat", ownerId?: string, minHoursWaiting?: number, limit?: integer)` — Open conversations where the contact wrote last and we have not replied yet, longest-waiting first, with hoursWaiting and the last inbound message excerpt. |

## M12 SMS

Draft, send, schedule and track one-to-one SMS text messages.

| action | risk | signature / description |
|---|---|---|
| Draft SMS | write | `sms.draft_sms(contactId?: string, to?: string, body?: string, templateId?: string, variables?: object, relatedType?: string, relatedId?: string, purpose?: string)` — Save an unsent SMS draft to a contact (phone resolved from contactId) or raw number, from body text or an SMS template. Nothing is sent; warns if the contact opted out. |
| Preview SMS segmentation | read | `sms.preview_sms_segmentation(body: string)` — Calculate SMS encoding (GSM-7 vs UCS-2), character count and number of billable segments for a text (160/70 chars single, 153/67 per part when multipart). Lists characters that force UCS-2. |
| Send SMS | external | `sms.send_sms(messageId?: string, contactId?: string, to?: string, body?: string, templateId?: string, variables?: object, relatedType?: string, relatedId?: string, purpose?: string)` — Immediately send one SMS text to a single contact or number (compose new, or send an existing draft via messageId). Logs it on the contact's SMS conversation. Fails if the contact opted out of SMS or has no phone. For email use email.send_email; for bulk sends use campaigns. |
| Schedule SMS | external | `sms.schedule_sms(messageId?: string, contactId?: string, to?: string, body?: string, templateId?: string, variables?: object, relatedType?: string, relatedId?: string, purpose?: string, scheduledAt: string)` — Queue one SMS to be sent at a future time (compose new or schedule an existing draft via messageId). Fails if scheduledAt is not in the future or the contact opted out of SMS. |
| Cancel scheduled SMS | destructive | `sms.cancel_scheduled_sms(id: string)` — Cancel a scheduled (not yet sent) SMS so it is never sent. |
| Get SMS details | read | `sms.get_sms_details(id: string)` — Fetch one SMS message (body, recipient, status, timestamps, template, related record) by message ID. |
| Search SMS messages | read | `sms.search_sms_messages(contactId?: string, contactIds?: string[], conversationId?: string, direction?: "inbound"\|"outbound", status?: "draft"\|"scheduled"\|"sent"\|"delivered"\|"failed"\|"cancelled"\|"received", purpose?: string, sentAtAfter?: string, sentAtBefore?: string, limit?: integer, query?: string)` — Find individual SMS messages (not threads) by contact(s), conversation, direction, status, purpose, sent date range or text, newest first. For reply/thread questions prefer conversations.search_conversations. |
| Get SMS delivery status | read | `sms.get_sms_delivery_status(id: string)` — Delivery state of one SMS: queued/sent/delivered/failed with timestamps, carrier failure reason and segment count. |
| Receive simulated inbound SMS | write | `sms.receive_inbound_sms(from?: string, contactId?: string, body: string)` — Simulate a contact texting in: matches the sender by phone (or contactId), logs the message, marks the SMS conversation unread/awaiting reply (reopening if closed). STOP/UNSUBSCRIBE keywords opt the contact out of SMS. |
| Record SMS opt-out | write | `sms.record_sms_opt_out(contactId: string, reason?: string)` — Record that a contact opted out of SMS (sets preferences.sms=false with reason) and cancels their scheduled texts. Email/call preferences are unchanged. |

## M13 Email

Draft, send, schedule and track one-to-one emails.

| action | risk | signature / description |
|---|---|---|
| Draft email | write | `email.draft_email(contactId?: string, to?: string, subject?: string, body?: string, templateId?: string, variables?: object, relatedType?: string, relatedId?: string, purpose?: string)` — Save an unsent email draft to a contact or address, from subject/body or an email template rendered with contact data, a related record (e.g. relatedType "invoices" for invoice reminders) and variables. Nothing is sent. |
| Preview email | read | `email.preview_email(messageId?: string, contactId?: string, to?: string, subject?: string, body?: string, templateId?: string, variables?: object, relatedType?: string, relatedId?: string, purpose?: string)` — Render the final subject/body of an email (an existing draft by messageId, or a template/compose fields for a contact) without saving or sending. Reports unresolved {{variables}} in missingVariables. |
| Send email | external | `email.send_email(messageId?: string, contactId?: string, to?: string, subject?: string, body?: string, templateId?: string, variables?: object, relatedType?: string, relatedId?: string, purpose?: string)` — Immediately send one email to a single contact or address (compose new, render a template, or send an existing draft via messageId). Logs it on the contact's email conversation; invoice reminders (relatedType "invoices") are recorded on the invoice. Fails if the contact unsubscribed. For SMS use sms.send_sms; for bulk sends use campaigns. |
| Schedule email | external | `email.schedule_email(messageId?: string, contactId?: string, to?: string, subject?: string, body?: string, templateId?: string, variables?: object, relatedType?: string, relatedId?: string, purpose?: string, scheduledAt: string)` — Queue one email to be sent at a future time (compose new or schedule an existing draft via messageId). Fails if scheduledAt is not in the future or the contact unsubscribed. |
| Cancel scheduled email | destructive | `email.cancel_scheduled_email(id: string)` — Cancel a scheduled (not yet sent) email so it is never sent. |
| Get email details | read | `email.get_email_details(id: string)` — Fetch one email message (subject, body, recipient, status, opened/bounced timestamps, template, related record) by message ID. |
| Search email messages | read | `email.search_email_messages(contactId?: string, contactIds?: string[], status?: "draft"\|"scheduled"\|"sent"\|"delivered"\|"failed"\|"cancelled"\|"received", direction?: "inbound"\|"outbound", purpose?: string, relatedId?: string, sentAtAfter?: string, sentAtBefore?: string, limit?: integer, query?: string)` — Find individual email messages (not threads) by contact(s), status, direction, purpose (e.g. invoice_reminder), related record ID, sent date range or subject/body text, newest first. For reply/thread questions prefer conversations.search_conversations. |
| Get email delivery status | read | `email.get_email_delivery_status(id: string)` — Delivery/engagement state of one email: scheduled, delivered, opened, bounced (with reason) or failed, with timestamps. |
| Receive simulated inbound email | write | `email.receive_inbound_email(from?: string, contactId?: string, subject?: string, body: string)` — Simulate a contact emailing in: matches the sender by email address (or contactId), logs the message and marks the email conversation unread/awaiting reply (reopening if closed). |
| Record email unsubscribe | write | `email.record_email_unsubscribe(contactId: string, reason?: string)` — Record that a contact unsubscribed from email (sets preferences.email=false with reason) and cancels their scheduled emails. SMS/call preferences are unchanged. |

## M14 Message Templates

Reusable email and SMS message templates with {{variable}} placeholders and version history.

| action | risk | signature / description |
|---|---|---|
| Create message template | write | `templates.create_template(name: string, channel: "email"\|"sms", subject?: string, body: string, variables?: string[], category?: string)` — Create a reusable email or SMS template with {{variable}} placeholders (e.g. {{contact.firstName}}, {{invoice.number}}). Saves content only; sends nothing. Variables are auto-detected unless given. |
| Get template | read | `templates.get_template(id: string)` — Fetch one message template (content, variables, version history) by ID. |
| Search templates | read | `templates.search_templates(channel?: "email"\|"sms", category?: string, status?: "active"\|"archived", limit?: integer, query?: string)` — Find message templates by name/subject/body text, channel (email/sms) or category. Archived templates are excluded unless status is given. |
| Update template content | write | `templates.update_template_content(id: string, subject?: string, body?: string)` — Change the subject and/or body of an active template. The previous content is saved to version history (restorable). Returns undeclaredVariables if new placeholders are not in the variables list. |
| Archive template | destructive | `templates.archive_template(id: string)` — Archive an active template so it can no longer be used for sending (it stays readable and can be duplicated). |
| Duplicate template | write | `templates.duplicate_template(id: string, name?: string)` — Copy a template (active or archived) into a new active template, default name "<name> (Copy)". Version history is not copied. |
| Define template variables | write | `templates.define_template_variables(id: string, variables: string[])` — Replace the declared variable list of a template (names like contact.firstName, without braces). Returns the resulting undeclared/unused variable check. |
| Validate template variables | read | `templates.validate_template_variables(id: string)` — Check a template for {{placeholders}} used in subject/body but not declared (undeclared) and declared variables never used (unused). |
| Render template with sample data | read | `templates.render_template(id: string, data?: object, contactId?: string, relatedType?: string, relatedId?: string)` — Preview a template with values filled in: from `data`, a contact (contactId) and/or a related record (e.g. relatedType "invoices"). Variables not supplied are filled with sample values and listed in missingVariables. Sends nothing. |
| Restore template version | write | `templates.restore_template_version(id: string, version: integer)` — Roll a template back to an earlier saved version number (current content is itself saved to history first). |

## M15 Campaigns

Plan, launch and measure bulk marketing campaigns (email, SMS, paid ads).

| action | risk | signature / description |
|---|---|---|
| Create campaign | write | `campaigns.create_campaign(name: string, channel: "email"\|"sms"\|"facebook"\|"google"\|"multi", budget?: number, description?: string)` — Create a draft marketing campaign (email, sms, facebook, google or multi-channel) with an optional budget. Nothing is sent until launch. |
| Get campaign details | read | `campaigns.get_campaign(id: string)` — Fetch one campaign: channel, status, audience, message steps, schedule, budget and raw stats. |
| List campaigns | read | `campaigns.list_campaigns(status?: "draft"\|"scheduled"\|"active"\|"paused"\|"completed", channel?: "email"\|"sms"\|"facebook"\|"google"\|"multi", limit?: integer, query?: string)` — List marketing campaigns, filterable by status, channel or name text. |
| Set campaign audience | write | `campaigns.set_campaign_audience(id: string, tags?: string[], contactIds?: string[], smartListId?: string)` — Target a campaign at contacts with any of the given tags, explicit contactIds and/or a smart list. Computes audienceSize = active contacts reachable on the channel (opted-out contacts excluded). Replaces the previous audience. |
| Add campaign message step | write | `campaigns.add_campaign_message_step(id: string, channel?: "email"\|"sms", templateId?: string, subject?: string, body?: string, delayDays?: integer)` — Append an email or SMS message step to a campaign sequence (template or inline content, sent delayDays after the previous step). Not for ad campaigns (facebook/google). |
| Set campaign schedule | write | `campaigns.set_campaign_schedule(id: string, startAt: string, endAt?: string, timezone?: string)` — Set when a campaign starts (future time) and optionally ends. A draft campaign becomes scheduled; launch_campaign starts it immediately instead. |
| Launch campaign | external | `campaigns.launch_campaign(id: string)` — Start a draft or scheduled campaign now (status → active), sending to its whole audience. Email/SMS/multi campaigns need an audience and at least one message step; ad campaigns need an audience and a budget. For a single message use sms.send_sms / email.send_email. |
| Pause campaign | write | `campaigns.pause_campaign(id: string)` — Pause an active campaign (stops further sends / ad delivery until resumed). |
| Resume campaign | external | `campaigns.resume_campaign(id: string)` — Resume a paused campaign (back to active); sending / ad delivery restarts. |
| Get campaign performance | read | `campaigns.get_campaign_performance(id: string)` — Campaign results: raw stats plus delivery/open/click/reply rates (email/SMS) or CTR (ads), spend vs budget, leads attributed (leads with this campaignId), converted leads and cost per lead. |

## M16 Workflows

Build and operate multi-step automations.

| action | risk | signature / description |
|---|---|---|
| Create workflow | write | `workflows.create_workflow(name: string, description?: string)` — Create an empty draft automation workflow (multi-step sequence run per contact). Add steps, validate, then publish. Event triggers that start it are managed in the triggers module. |
| Get workflow definition | read | `workflows.get_workflow(id: string)` — Fetch a workflow definition: status, version and ordered steps with config (run history excluded; see execution history). |
| List workflows | read | `workflows.list_workflows(status?: "draft"\|"published"\|"paused", limit?: integer, query?: string)` — List automation workflows, filterable by status (draft/published/paused) or name text. |
| Add workflow step | write | `workflows.add_workflow_step(id: string, type: "send_email"\|"send_sms"\|"wait"\|"create_task"\|"add_tag"\|"assign_owner"\|"if_else", config: object, position?: integer)` — Insert a step into a draft or paused workflow (published ones must be paused first). Config is validated per type: send_email {templateId \| subject+body}, send_sms {templateId \| body}, wait {days \| hours}, create_task {title, dueInDays?, assigneeId?}, add_tag {tag}, assign_owner {userId \| teamId}, if_else {field, operator, value}. |
| Update workflow step | write | `workflows.update_workflow_step(id: string, stepId: string, type?: "send_email"\|"send_sms"\|"wait"\|"create_task"\|"add_tag"\|"assign_owner"\|"if_else", config?: object)` — Change the type and/or merge new config into an existing step of a draft or paused workflow; the result is re-validated. |
| Remove workflow step | destructive | `workflows.remove_workflow_step(id: string, stepId: string)` — Delete one step from a draft or paused workflow. |
| Validate workflow | read | `workflows.validate_workflow(id: string)` — Check every step of a workflow for missing required config and stale references (archived templates, deactivated users); returns errors (block publishing) and warnings. |
| Publish workflow | external | `workflows.publish_workflow(id: string)` — Make a draft or paused workflow live so it runs for enrolled contacts (sends real messages). Fails with the validation errors unless the workflow validates clean. |
| Pause workflow | write | `workflows.pause_workflow(id: string)` — Pause a published workflow: no new enrollments or step executions until republished. |
| Get workflow execution history | read | `workflows.get_workflow_execution_history(id: string, status?: "completed"\|"running"\|"failed", contactId?: string, limit?: integer)` — Past and in-progress runs of a workflow (per contact): status completed/running/failed, steps executed, error, timestamps, newest first, with counts by status. |

## M17 Event Triggers

Configure which platform events (new lead, form submitted, invoice overdue...) start which workflows.

| action | risk | signature / description |
|---|---|---|
| Create event trigger | write | `triggers.create_event_trigger(name: string, eventType?: "contact_created"\|"lead_created"\|"form_submitted"\|"appointment_booked"\|"appointment_cancelled"\|"invoice_overdue"\|"tag_added"\|"payment_failed"\|"survey_submitted"\|"opportunity_stage_changed", workflowId?: string, conditions?: {field: string, operator: "equals"\|"not_equals"\|"contains"\|"gt"\|"gte"\|"lt"\|"lte"\|"in"\|"exists", value?: any}[], conditionLogic?: "all"\|"any")` — Create a (disabled) trigger that will start a workflow when a platform event happens, optionally with event type, payload conditions and a bound workflow. |
| Get trigger configuration | read | `triggers.get_trigger(id: string)` — Fetch a trigger: event type, conditions, bound workflow (with its status) and enabled state (firing log excluded; see firing history). |
| List event triggers | read | `triggers.list_event_triggers(eventType?: "contact_created"\|"lead_created"\|"form_submitted"\|"appointment_booked"\|"appointment_cancelled"\|"invoice_overdue"\|"tag_added"\|"payment_failed"\|"survey_submitted"\|"opportunity_stage_changed", status?: "enabled"\|"disabled", workflowId?: string, limit?: integer, query?: string)` — List event triggers, filterable by event type, enabled/disabled status, bound workflow or name text. |
| Set trigger event type | write | `triggers.set_trigger_event_type(id: string, eventType: "contact_created"\|"lead_created"\|"form_submitted"\|"appointment_booked"\|"appointment_cancelled"\|"invoice_overdue"\|"tag_added"\|"payment_failed"\|"survey_submitted"\|"opportunity_stage_changed")` — Choose which platform event fires the trigger (e.g. lead_created, invoice_overdue, form_submitted). |
| Update trigger conditions | write | `triggers.update_trigger_conditions(id: string, conditions: {field: string, operator: "equals"\|"not_equals"\|"contains"\|"gt"\|"gte"\|"lt"\|"lte"\|"in"\|"exists", value?: any}[], conditionLogic?: "all"\|"any")` — Replace the payload conditions a trigger event must satisfy (field/operator/value; all or any). An empty list means every event of the type fires. |
| Bind trigger to workflow | write | `triggers.bind_trigger_to_workflow(id: string, workflowId: string)` — Set the workflow a trigger starts when it fires (replaces any previous binding). |
| Enable trigger | write | `triggers.enable_trigger(id: string)` — Turn a trigger on. Requires an event type and a bound workflow that is published. |
| Disable trigger | write | `triggers.disable_trigger(id: string)` — Turn a trigger off so its events no longer start the workflow. |
| Test trigger with sample event | write | `triggers.test_trigger(id: string, samplePayload: object)` — Dry-run a trigger against a sample event payload: evaluates each condition, records a test firing in the history, and reports whether it would start the bound workflow. Does not run the workflow. |
| Get trigger firing history | read | `triggers.get_trigger_firing_history(id: string, matched?: boolean, includeTests?: boolean, limit?: integer)` — Log of a trigger's firings (real events and tests), newest first: event payload, whether conditions matched and whether a workflow run started. |

## M18 Forms

Build lead-capture forms and collect submissions.

| action | risk | signature / description |
|---|---|---|
| Create form | write | `forms.create_form(name: string, description?: string)` — Create an empty draft web form (add fields, then publish). For questionnaires with scoring/branching use surveys. |
| Get form definition | read | `forms.get_form(id: string)` — Fetch a form with its ordered fields, validation rules, status and public URL. |
| List forms | read | `forms.list_forms(status?: "draft"\|"published"\|"archived", limit?: integer, query?: string)` — List forms, filterable by status (draft/published/archived) or name text. |
| Add form field | write | `forms.add_form_field(id: string, key: string, label: string, type: "text"\|"email"\|"phone"\|"number"\|"textarea"\|"select"\|"checkbox"\|"date", required?: boolean, options?: string[], placeholder?: string)` — Append a field (text, email, phone, number, textarea, select, checkbox, date) to a form. Keys must be unique snake_case; select fields need options. |
| Update form field | write | `forms.update_form_field(id: string, fieldId: string, label?: string, required?: boolean, options?: string[], placeholder?: string)` — Change a form field's label, required flag, options or placeholder (key and type are fixed). |
| Reorder form fields | write | `forms.reorder_form_fields(id: string, orderedFieldIds: string[])` — Set the display order of a form's fields by passing all field IDs in the new order. |
| Set form validation rules | write | `forms.set_form_validation_rules(id: string, rules: {fieldKey: string, rule: "minLength"\|"maxLength"\|"pattern"\|"min"\|"max"\|"allowedDomains"\|"blockedDomains", value: string\|number\|string[], message?: string}[])` — Replace a form's extra validation rules (minLength, maxLength, pattern, min, max, allowedDomains, blockedDomains) applied to submissions on top of field types/required. |
| Publish form | external | `forms.publish_form(id: string)` — Publish a draft form to its public URL so people can submit it. Needs at least one field including an email field (used to match/create the contact). |
| Submit simulated form response | write | `forms.submit_form_response(id: string, data: object)` — Simulate someone submitting a published form: validates data against field types, required flags and rules (all errors returned), stores the submission and matches an existing contact by email or creates a new lead contact. |
| List form submissions | read | `forms.list_form_submissions(formId?: string, contactId?: string, submittedAtAfter?: string, submittedAtBefore?: string, limit?: integer)` — List stored form submissions (newest first), filterable by form, contact and submitted date range. |

## M19 Surveys

Run feedback surveys (NPS, ratings, multiple choice) with branching and response analytics.

| action | risk | signature / description |
|---|---|---|
| Create survey | write | `surveys.create_survey(name: string, description?: string)` — Create an empty draft feedback survey (NPS, ratings, multiple choice, yes/no, text). For lead-capture data entry use forms instead. |
| Get survey definition | read | `surveys.get_survey(id: string)` — Fetch a survey with its ordered questions, options and branching rules. |
| List surveys | read | `surveys.list_surveys(status?: "draft"\|"published"\|"closed", limit?: integer, query?: string)` — List surveys, filterable by status (draft/published/closed) or name text, with response counts. |
| Add survey question | write | `surveys.add_survey_question(id: string, text: string, type: "nps"\|"rating"\|"multiple_choice"\|"yes_no"\|"text", required?: boolean, options?: string[], scaleMax?: integer)` — Append a question (nps 0-10, rating 1-scaleMax, multiple_choice with options, yes_no, text) to a draft or published survey. |
| Update survey question | write | `surveys.update_survey_question(id: string, questionId: string, text?: string, required?: boolean, options?: string[], scaleMax?: integer)` — Change a question's text, required flag, options or rating scale (type is fixed). |
| Set question branching rules | write | `surveys.set_question_branching(id: string, questionId: string, rules: {operator: "equals"\|"not_equals"\|"gt"\|"gte"\|"lt"\|"lte"\|"in", value: any, goTo: string}[])` — Replace the skip-logic rules of a question: after it is answered, the first matching rule (operator/value) jumps to a LATER question id or "end"; no match = next question. Text questions cannot branch. |
| Publish survey | external | `surveys.publish_survey(id: string)` — Open a draft survey for responses (shareable link). Needs at least one question. |
| Close survey | write | `surveys.close_survey(id: string)` — Stop accepting responses on a published survey (results stay available). |
| Submit simulated survey response | write | `surveys.submit_survey_response(id: string, contactId?: string, answers: object)` — Simulate a respondent answering a published survey: answers keyed by question id are validated per type, branching is followed (answers to skipped questions are ignored), and the response is stored. |
| Get survey response summary | read | `surveys.get_survey_response_summary(id: string)` — Aggregate results of a survey: response count and per-question stats (NPS score with promoters/passives/detractors, rating averages and distribution, choice counts, yes/no counts, recent text answers). |

## M20 Calendars

Configure calendars used for appointment booking.

| action | risk | signature / description |
|---|---|---|
| Create calendar | write | `calendars.create_calendar(name: string, description?: string, timezone?: string, hostUserIds?: string[], durationMin?: integer, bufferMin?: integer, visibility?: "public"\|"private"\|"team")` — Create a bookable calendar (meeting type such as "Discovery Call") with hosts, default duration, buffer, timezone and visibility. Defines what can be booked; to book an actual meeting use Create appointment. |
| Get calendar settings | read | `calendars.get_calendar_settings(id: string)` — Settings of one calendar (timezone, hosts with status/out-of-office, duration, buffer, visibility) plus its count of upcoming booked appointments. For a person's working hours use Get weekly working hours. |
| List calendars | read | `calendars.list_calendars(hostUserIds?: string, visibility?: "public"\|"private"\|"team", status?: "active"\|"archived", limit?: integer, query?: string)` — List booking calendars (meeting types), filterable by name text, host, visibility or status. Archived calendars are excluded unless status is given. |
| Update calendar details | write | `calendars.update_calendar_details(id: string, name?: string, description?: string)` — Rename a calendar or change its description. Timezone, hosts, duration, buffer and visibility have their own actions. |
| Set calendar timezone | write | `calendars.set_calendar_timezone(id: string, timezone: string)` — Set the IANA timezone a calendar displays booking times in (e.g. America/Chicago). Not a user's personal timezone. |
| Assign calendar host | write | `calendars.assign_calendar_host(id: string, userId: string)` — Add an active user as a host who can be booked on this calendar. To change who runs one specific meeting use Assign appointment host. |
| Set appointment duration | write | `calendars.set_appointment_duration(id: string, durationMin: integer)` — Set the default meeting length (5-480 minutes) for new bookings on a calendar. Existing appointments keep their times. |
| Set booking buffer | write | `calendars.set_booking_buffer(id: string, bufferMin: integer)` — Set the buffer minutes kept free around each appointment on a calendar (applied when finding available slots). Per-user booking notice/horizon are availability settings instead. |
| Set calendar visibility | write | `calendars.set_calendar_visibility(id: string, visibility: "public"\|"private"\|"team")` — Who can see/book the calendar: public (anyone with the link), private (internal only), or team (team members only). |
| Archive calendar | destructive | `calendars.archive_calendar(id: string, force?: boolean)` — Archive a calendar so it can no longer be booked; published booking pages linked to it are unpublished. Fails with CONFLICT if it has upcoming booked/confirmed appointments unless force=true, which also cancels them. |

## M21 Appointments

Manage booked meetings and their outcomes.

| action | risk | signature / description |
|---|---|---|
| Create appointment | write | `appointments.create_appointment(calendarId: string, contactId: string, startAt: string, endAt?: string, hostUserId?: string, title?: string, notes?: string)` — Book a 1:1 meeting with a contact on a calendar at a specific time. Host must be an active calendar host with no overlapping booked/confirmed appointment or time block (CONFLICT lists the clash); as a staff booking it is NOT limited by working hours, minimum notice, booking horizon or calendar buffer (use Find available slots / Check scheduling conflicts first when those matter). endAt defaults to start + calendar duration; host defaults to the first free host. For group sessions use Register attendee (events). |
| Get appointment details | read | `appointments.get_appointment(id: string)` — Fetch one booked meeting by ID: time, host, contact, calendar, attendees, status and outcome. |
| Search appointments | read | `appointments.search_appointments(contactId?: string, contactIds?: string[], calendarId?: string, hostUserId?: string, status?: "booked"\|"confirmed"\|"cancelled"\|"completed"\|"no_show"\|"booked"\|"confirmed"\|"cancelled"\|"completed"\|"no_show"[], startAtAfter?: string, startAtBefore?: string, upcoming?: boolean, limit?: integer)` — Find booked meetings by contact(s), calendar, host, status, start-time range, or upcoming=true (future booked/confirmed). Sorted by start time. Use to check whether contacts/leads already have a meeting. |
| Reschedule appointment | write | `appointments.reschedule_appointment(id: string, startAt: string, endAt?: string)` — Move a booked/confirmed meeting to a new future time (keeps its length unless endAt given). Checks the calendar is active and the host is still an active host and free (like Create appointment, working hours/notice/buffer are not enforced); a confirmed meeting returns to booked for reconfirmation. |
| Cancel appointment | destructive | `appointments.cancel_appointment(id: string, reason?: string)` — Cancel a booked/confirmed meeting (frees the host's time). Reason optional. For event seats use Cancel attendee registration. |
| Assign appointment host | write | `appointments.assign_appointment_host(id: string, hostUserId: string)` — Hand one booked/confirmed meeting to a different host. New host must be an active host of the meeting's calendar and free at that time. To add a host to a whole calendar use Assign calendar host. |
| Add appointment attendee | write | `appointments.add_appointment_attendee(id: string, contactId?: string, name?: string, email?: string)` — Invite an extra guest (existing contact or name/email) to a booked meeting, beyond its primary contact. |
| Remove appointment attendee | write | `appointments.remove_appointment_attendee(id: string, attendeeId: string)` — Remove an extra guest (by attendee ID) from a booked meeting. The primary contact cannot be removed; cancel or reassign instead. |
| Mark attendee no-show | write | `appointments.mark_no_show(id: string, outcome?: string)` — Record that the contact did not show up to a booked/confirmed meeting. Only allowed after the start time has passed. |
| Mark appointment completed | write | `appointments.mark_completed(id: string, outcome?: string)` — Record that a booked/confirmed meeting took place, with optional outcome notes. Only allowed after the start time has passed. |

## M22 Availability

Manage bookable time and scheduling constraints.

| action | risk | signature / description |
|---|---|---|
| Set weekly working hours | write | `availability.set_weekly_hours(userId: string, weeklyHours: {sun?: {start: string, end: string}[], mon?: {start: string, end: string}[], tue?: {start: string, end: string}[], wed?: {start: string, end: string}[], thu?: {start: string, end: string}[], fri?: {start: string, end: string}[], sat?: {start: string, end: string}[]})` — Set a user's recurring weekly bookable hours per weekday (only the days given are replaced; [] = day off). Working hours are evaluated as UTC in this system; all times are UTC. |
| Get weekly working hours | read | `availability.get_weekly_hours(userId: string)` — A user's availability profile: weekly hours, date overrides, time blocks (out of office etc.), minimum notice and booking horizon. Working hours are evaluated as UTC in this system; all times are UTC. To get actual open times use Find available slots. |
| Add date-specific availability | write | `availability.add_date_override(userId: string, date: string, slots?: {start: string, end: string}[], unavailable?: boolean)` — Override one date for a user: custom hours (slots) or unavailable=true (day off). Replaces any existing override for that date; the weekly schedule is untouched. |
| Remove date-specific availability | write | `availability.remove_date_override(userId: string, date: string)` — Delete a user's override for one date so that date follows the weekly schedule again. |
| Block time range | write | `availability.block_time(userId: string, startAt: string, endAt: string, reason?: string)` — Make a user unbookable for a datetime range (out of office, personal time). Existing appointments in the range are NOT cancelled; they are returned as overlappingAppointments to reschedule or reassign. |
| Remove time block | write | `availability.remove_time_block(blockId: string)` — Delete a time block (by block ID, e.g. blk_001) so that time becomes bookable again. |
| Set minimum booking notice | write | `availability.set_min_notice(userId: string, minNoticeHours: integer)` — Minimum hours ahead a user can be booked (e.g. 24 = no same-day bookings). Per user; calendar buffers are separate. |
| Set maximum booking horizon | write | `availability.set_max_horizon(userId: string, maxHorizonDays: integer)` — How many days into the future a user can be booked (1-365). |
| Find available slots | read | `availability.find_available_slots(userId?: string, calendarId?: string, startDate: string, endDate?: string, durationMin?: integer, limit?: integer)` — Open bookable times for a user, or for all active hosts of a calendar (uses its duration and buffer), over a date range of up to 14 days. Subtracts time blocks and booked/confirmed appointments and respects date overrides, minimum notice and booking horizon. Working hours are evaluated as UTC in this system; all times are UTC. |
| Check scheduling conflicts | read | `availability.check_scheduling_conflicts(userId: string, startAt: string, endAt: string)` — Check whether a user is free for a specific time range: lists overlapping booked/confirmed appointments and time blocks, and flags outside working hours, inside minimum notice, or beyond the booking horizon. Working hours are evaluated as UTC in this system; all times are UTC. |

## M23 Booking Pages

Configure the public booking experience.

| action | risk | signature / description |
|---|---|---|
| Create booking page | write | `booking_pages.create_booking_page(name: string, slug?: string, title?: string, description?: string, calendarId?: string)` — Create a draft public scheduling page (URL slug, title, intake form) where visitors self-book; optionally linked to a calendar. Not a website/funnel landing page and not a calendar itself. |
| Get booking page | read | `booking_pages.get_booking_page(id: string)` — Fetch one booking page: slug, public URL, linked calendar, intake fields, confirmation message, redirect and publish status. |
| List booking pages | read | `booking_pages.list_booking_pages(status?: "draft"\|"published"\|"unpublished", calendarId?: string, limit?: integer, query?: string)` — List public booking pages, filterable by status (draft/published/unpublished), linked calendar, or name/slug text. |
| Update booking page content | write | `booking_pages.update_booking_page_content(id: string, name?: string, title?: string, description?: string, slug?: string)` — Edit a booking page's name, visitor-facing title, description or URL slug. Changes to a published page go live immediately. |
| Link calendar to booking page | write | `booking_pages.link_calendar_to_booking_page(id: string, calendarId: string)` — Choose which active calendar a booking page books into (determines hosts, duration and availability shown). Replaces any previously linked calendar. |
| Set booking intake fields | write | `booking_pages.set_booking_intake_fields(id: string, fields: {key: string, label: string, type: "text"\|"email"\|"phone"\|"textarea"\|"select"\|"checkbox", required?: boolean, options?: string[]}[])` — Replace the questions visitors answer when booking (full list). Keys must be unique and a required email field is mandatory. |
| Set booking confirmation message | write | `booking_pages.set_booking_confirmation_message(id: string, message: string)` — Set the thank-you text shown on the booking page after a visitor books (ignored when a redirect URL is set). Not an email/SMS confirmation. |
| Set booking redirect URL | write | `booking_pages.set_booking_redirect_url(id: string, url: string)` — Send visitors to this https URL after they book (instead of showing the confirmation message). |
| Publish booking page | external | `booking_pages.publish_booking_page(id: string)` — Make a draft/unpublished booking page live at its public URL so anyone can self-book. Requires a linked active calendar with at least one active host. |
| Unpublish booking page | external | `booking_pages.unpublish_booking_page(id: string)` — Take a published booking page offline (public URL stops accepting bookings). Existing appointments are kept. Can be re-published later. |

## M24 Events

Manage group sessions and registrations.

| action | risk | signature / description |
|---|---|---|
| Create event | write | `events.create_event(name: string, type: "webinar"\|"workshop"\|"meetup"\|"class", startAt: string, endAt: string, capacity: integer, description?: string, location?: string, hostUserId?: string)` — Create a group session (webinar, workshop, meetup, class) with a capacity that contacts register for. For a 1:1 meeting use Create appointment. |
| Get event details | read | `events.get_event(id: string)` — One event with seat counts (registered, seats left, waitlist) and attendee names/statuses. |
| Search events | read | `events.search_events(type?: "webinar"\|"workshop"\|"meetup"\|"class", status?: "scheduled"\|"completed"\|"cancelled", hostUserId?: string, startAtAfter?: string, startAtBefore?: string, limit?: integer, query?: string)` — Find group events by name text, type, status, host or start date range (startAtAfter/startAtBefore). |
| Update event details | write | `events.update_event(id: string, name?: string, description?: string, location?: string, hostUserId?: string, startAt?: string, endAt?: string)` — Change a scheduled event's name, description, location, host or times. Capacity has its own action. |
| Set event capacity | write | `events.set_event_capacity(id: string, capacity: integer)` — Change the maximum number of registered attendees. Cannot go below the current registration count. Raising it does not auto-promote the waitlist. |
| Register attendee | write | `events.register_attendee(id: string, contactId: string)` — Register a contact for a group event (takes a seat). Fails LIMIT_EXCEEDED when the event is full (use Add attendee to waitlist) and DUPLICATE if already registered. Not for 1:1 appointments. |
| Cancel attendee registration | destructive | `events.cancel_registration(id: string, contactId: string, reason?: string)` — Cancel a contact's event registration, freeing a seat. Does not auto-promote anyone; use Promote waitlisted attendee next. For 1:1 meetings use Cancel appointment. |
| Add attendee to waitlist | write | `events.add_to_waitlist(id: string, contactId: string)` — Put a contact on a full event's waitlist (first come, first served). Only when the event is full; otherwise register directly. |
| Promote waitlisted attendee | write | `events.promote_waitlisted(id: string, contactId?: string)` — Move a contact (default: first in line) from the waitlist into a free seat. Fails LIMIT_EXCEEDED if no seat is free. |
| Check in attendee | write | `events.check_in_attendee(id: string, contactId: string)` — Mark a registered contact as attended/checked in. Only on or after the event day; cancelled registrations cannot check in. |

## M25 Products

Manage the catalog of products and services, their variants, SKUs and inventory.

| action | risk | signature / description |
|---|---|---|
| Create product | write | `products.create_product(name: string, description?: string, type?: "physical"\|"digital"\|"service", sku?: string, taxCategory?: "general"\|"digital"\|"services"\|"food"\|"exempt", trackInventory?: boolean, quantity?: integer)` — Add a product or service to the catalog (physical, digital, or service). Prices are added separately with prices.create_price. |
| Get product details | read | `products.get_product(id: string)` — Fetch one catalog product by ID, including variants, SKU, inventory and default price ID. |
| Search products | read | `products.search_products(status?: "active"\|"archived", type?: "physical"\|"digital"\|"service", taxCategory?: "general"\|"digital"\|"services"\|"food"\|"exempt", limit?: integer, query?: string)` — Find catalog products by name/description/SKU text, type, or tax category. Archived products excluded unless status is given. |
| Update product details | write | `products.update_product(id: string, name?: string, description?: string, type?: "physical"\|"digital"\|"service")` — Change a product name, description, or type. SKU, variants, inventory, prices and tax category have their own actions. |
| Archive product | destructive | `products.archive_product(id: string)` — Archive (retire) a catalog product so it can no longer be added to orders, quotes or subscriptions. Blocked while submitted orders still reserve it. |
| Add product variant | write | `products.add_product_variant(id: string, name: string, sku?: string, options?: object, price?: number, quantity?: integer)` — Add a variant (e.g. size or color) to a product with its own SKU, optional price override, and stock. Once a product has variants, stock is tracked per variant. |
| Update product variant | write | `products.update_product_variant(id: string, variantId: string, name?: string, options?: object, price?: number\|null, status?: "active"\|"archived")` — Rename a variant, change its options or price override, or archive/reactivate it. Use set_product_sku for SKUs and set_inventory_quantity for stock. |
| Set product SKU | write | `products.set_product_sku(id: string, variantId?: string, sku: string)` — Set the SKU of a product or (with variantId) one of its variants. SKUs must be unique across all products and variants. |
| Set inventory quantity | write | `products.set_inventory_quantity(id: string, variantId?: string, quantity: integer, tracked?: boolean)` — Set on-hand stock for a product, or for a variant (required when the product has variants). Cannot go below units reserved by submitted orders. |
| Get inventory availability | read | `products.get_inventory_availability(id: string, variantId?: string)` — Sellable stock for a product or variant: on-hand quantity minus units reserved by submitted-but-unfulfilled orders. Lists every variant when variantId is omitted. |

## M26 Prices

Define what products cost: amounts, currencies, one-time vs recurring billing, trials and default prices.

| action | risk | signature / description |
|---|---|---|
| Create product price | write | `prices.create_price(productId: string, amount: number, label?: string, currency?: string, interval?: "one_time"\|"month"\|"year", trialDays?: integer)` — Add a price point to a catalog product: amount, currency, and billing interval (one_time, month, year). The first price of a product becomes its default. |
| Get price details | read | `prices.get_price(id: string)` — Fetch one price by ID (amount, currency, interval, trial days, status). |
| List product prices | read | `prices.list_product_prices(productId: string, status?: "active"\|"archived", interval?: "one_time"\|"month"\|"year", currency?: string, limit?: integer)` — List the prices of one product, filterable by status, interval and currency; also returns which price is the default. |
| Update price label | write | `prices.update_price_label(id: string, label: string)` — Rename the customer-facing label of a price (e.g. "Pro — Monthly"). |
| Set price amount | write | `prices.set_price_amount(id: string, amount: number)` — Change the amount of an active price. Existing subscriptions on a recurring price are billed the new amount from their next invoice. |
| Set price currency | write | `prices.set_price_currency(id: string, currency: string)` — Change the ISO 4217 currency of an active price. Blocked when live subscriptions use the price. |
| Set billing interval | write | `prices.set_billing_interval(id: string, interval: "one_time"\|"month"\|"year")` — Switch a price between one_time, month and year billing. Switching to one_time clears the trial. Blocked when live subscriptions use the price. |
| Set trial period | write | `prices.set_trial_period(id: string, trialDays: integer)` — Set the free-trial length (days) new subscriptions get on a recurring price. 0 removes the trial. Does not change existing subscriptions (use subscriptions.set_subscription_trial_end). |
| Set default product price | write | `prices.set_default_price(productId: string, priceId: string)` — Choose which active price is the product default (used when a product is added to orders or quotes without an explicit price). |
| Archive price | destructive | `prices.archive_price(id: string)` — Archive a price so it can no longer be used for new orders, quotes or subscriptions (existing subscriptions keep billing). If it is the product default, another active price is promoted; archiving the only active price is blocked. |

## M27 Quotes

Prepare proposed purchases for customer acceptance.

| action | risk | signature / description |
|---|---|---|
| Create quote | write | `quotes.create_quote(contactId: string, title?: string, expiresAt?: string, currency?: string, lineItems?: {productId?: string, priceId?: string, description?: string, quantity?: number, unitPrice?: number}[], notes?: string)` — Draft a quote/estimate/proposal for a contact, optionally with initial line items. Not a bill: convert it to an invoice once accepted. |
| Get quote details | read | `quotes.get_quote(id: string)` — Fetch one quote by ID with line items, discount, totals, status, expiry and linked invoice. |
| Search quotes | read | `quotes.search_quotes(contactId?: string, status?: "draft"\|"sent"\|"accepted"\|"declined"\|"expired", totalMin?: number, totalMax?: number, expiresAtBefore?: string, expiresAtAfter?: string, createdAtAfter?: string, createdAtBefore?: string, limit?: integer, query?: string)` — Find quotes by number/title text, contact, status, total range, expiry or created date range. |
| Add quote line item | write | `quotes.add_quote_line_item(id: string, productId?: string, priceId?: string, description?: string, quantity?: number, unitPrice?: number)` — Add a line to a draft quote: a catalog product (price filled from its default or priceId) or a custom description + unitPrice. |
| Update quote line item | write | `quotes.update_quote_line_item(id: string, itemId: string, description?: string, quantity?: number, unitPrice?: number)` — Change the description, quantity or unit price of a line on a draft quote. |
| Set quote expiry | write | `quotes.set_quote_expiry(id: string, expiresAt: string)` — Set the date a draft/sent quote stops being acceptable. Extending an expired quote re-opens it as sent. |
| Apply quote discount | write | `quotes.apply_quote_discount(id: string, type: "percent"\|"amount", value: number)` — Apply a whole-quote discount to a draft quote, as a percent or a fixed amount (replaces any previous quote discount). For coupon codes on orders use orders.apply_coupon_to_order. |
| Send quote for acceptance | external | `quotes.send_quote(id: string, email?: string)` — Email a draft quote to the contact for acceptance (draft → sent). Requires line items and a contact email; sets a 30-day expiry if none. |
| Record quote acceptance | write | `quotes.record_quote_acceptance(id: string, acceptedBy?: string)` — Record that the customer accepted a sent quote (sent → accepted). Fails if the quote has passed its expiry date. |
| Convert accepted quote to invoice | write | `quotes.convert_quote_to_invoice(id: string, dueDate?: string)` — Create a draft invoice from an accepted quote (copies lines, discount and totals; next INV- number) and link it on the quote. Send it with the invoices module. |

## M28 Invoices

Issue invoices and track outstanding balances.

| action | risk | signature / description |
|---|---|---|
| Create invoice | write | `invoices.create_invoice(contactId: string, dueDate?: string, currency?: string, lineItems?: {description: string, quantity?: number, unitPrice: number, productId?: string}[], notes?: string)` — Create a draft invoice for a contact, optionally with line items. Not sent until issued. |
| Get invoice details | read | `invoices.get_invoice(id: string)` — Fetch an invoice by ID (includes daysOverdue). |
| Search invoices | read | `invoices.search_invoices(query?: string, status?: "draft"\|"sent"\|"partially_paid"\|"paid"\|"void", contactId?: string, dueDateAfter?: string, dueDateBefore?: string, issueDateAfter?: string, issueDateBefore?: string, totalMin?: number, totalMax?: number, limit?: integer)` — Find invoices by status, contact, due/issue date range, amount range, or number. Use list_overdue_invoices for overdue-specific queries. |
| Add invoice line item | write | `invoices.add_invoice_line_item(id: string, description: string, quantity?: number, unitPrice: number, productId?: string)` — Add a line item to a draft invoice; totals are recalculated. |
| Update draft invoice | write | `invoices.update_draft_invoice(id: string, notes?: string, currency?: string, discount?: number, contactId?: string)` — Change notes, currency, discount, or contact on a draft invoice. |
| Set invoice due date | write | `invoices.set_invoice_due_date(id: string, dueDate: string)` — Change the due date of a draft or unpaid invoice. |
| Issue invoice | external | `invoices.issue_invoice(id: string)` — Finalize a draft invoice (status sent) and email it to the customer. Requires at least one line item and a due date. Result.delivery says whether the email went out (no email / unsubscribed => issued but not emailed). |
| Send invoice reminder | external | `invoices.send_invoice_reminder(id: string, channel?: "email"\|"sms", message?: string)` — Immediately send a payment reminder for an unpaid invoice to the customer by email or SMS and record it on the invoice. (To prepare a reminder without sending, draft an email instead.) |
| Void unpaid invoice | destructive | `invoices.void_invoice(id: string)` — Void a draft or sent invoice that has no payments applied. |
| List overdue invoices | read | `invoices.list_overdue_invoices(minDaysOverdue?: integer, contactId?: string, notRemindedSince?: string, limit?: integer)` — Unpaid issued invoices past their due date, with daysOverdue, balance, contact and lastReminderAt. Filter by minimum days overdue, contact, or exclude invoices reminded since a date. |

## M29 Payments

Track payment attempts and invoice settlement.

| action | risk | signature / description |
|---|---|---|
| Create payment request | external | `payments.create_payment_request(invoiceId?: string, contactId?: string, amount?: number, description?: string, channel?: "email"\|"sms", expiresInDays?: integer)` — Send the customer a pay-now link for an invoice balance (or part of it) or a custom amount. This collects money; to just nudge about an unpaid invoice use invoices.send_invoice_reminder. |
| Get payment request | read | `payments.get_payment_request(id: string)` — Fetch one payment request (pay link) by ID with its status (open/paid/cancelled/expired) and resulting payment. |
| Cancel unpaid payment request | destructive | `payments.cancel_payment_request(id: string, reason?: string)` — Cancel an open (unpaid) payment request so its pay link stops working. |
| Record simulated payment | external | `payments.record_payment(invoiceId?: string, paymentRequestId?: string, contactId?: string, amount?: number, currency?: string, method?: "card"\|"ach"\|"bank_transfer"\|"cash"\|"check", cardNumber?: string, reference?: string)` — Charge/record a payment (simulated processor). Card numbers ending 0002 decline (card_declined), 9995 insufficient_funds, 0069 expired_card; others succeed. With invoiceId (or a paymentRequestId) a successful payment is auto-allocated to the invoice. |
| Get payment details | read | `payments.get_payment(id: string)` — Fetch one payment by ID: amount, status, method, invoice allocations, unallocated amount and refunded amount. |
| Search payments | read | `payments.search_payments(contactId?: string, invoiceId?: string, status?: "pending"\|"succeeded"\|"failed"\|"refunded"\|"partially_refunded", method?: "card"\|"ach"\|"bank_transfer"\|"cash"\|"check", amountMin?: number, amountMax?: number, paidAtAfter?: string, paidAtBefore?: string, limit?: integer)` — Find payment attempts by contact, invoice (including allocations), status, method, amount range or payment date range. |
| Allocate payment to invoice | write | `payments.allocate_payment(id: string, invoiceId: string, amount?: number)` — Apply part of a payment's unallocated amount to an open invoice of the same contact; updates the invoice amountPaid, balance and status. |
| Remove payment allocation | write | `payments.remove_payment_allocation(id: string, invoiceId: string)` — Un-apply a payment from an invoice: the allocated amount returns to the payment as unallocated and the invoice amountPaid/balance/status are reversed. Money is not refunded (use refunds for that). |
| Generate payment receipt | write | `payments.generate_payment_receipt(id: string)` — Issue (or re-fetch) the receipt for a successful payment: receipt number and printable text. Failed or pending payments have no receipt. |
| Get payment failure details | read | `payments.get_payment_failure(id: string)` — Explain why a failed payment attempt failed: decline code, message, whether a retry may work, recommended next step, and other failed attempts by the same customer. |

## M30 Subscriptions

Manage recurring billing plans for customers: trials, plan changes, quantity, pause/resume and cancellation.

| action | risk | signature / description |
|---|---|---|
| Create subscription | write | `subscriptions.create_subscription(contactId: string, priceId: string, quantity?: integer, trialDays?: integer, couponCode?: string)` — Start a recurring subscription for a contact on a recurring (monthly/yearly) price. Trial defaults to the price's trial days; an optional coupon code is validated and redeemed. |
| Get subscription details | read | `subscriptions.get_subscription(id: string)` — Fetch one subscription by ID: plan price, quantity, status, trial end, current period and cancellation flags. |
| Search subscriptions | read | `subscriptions.search_subscriptions(contactId?: string, productId?: string, priceId?: string, status?: "trialing"\|"active"\|"past_due"\|"paused"\|"cancelled", cancelAtPeriodEnd?: boolean, currentPeriodEndAfter?: string, currentPeriodEndBefore?: string, limit?: integer)` — Find subscriptions by contact, product, price, status, scheduled cancellation, or renewal (currentPeriodEnd) date range. |
| Change subscription plan | write | `subscriptions.change_subscription_plan(id: string, priceId: string, prorate?: boolean)` — Move a subscription to another recurring price (upgrade/downgrade, monthly↔yearly). Returns the prorated amount for the rest of the current period (positive = charge, negative = credit). |
| Update subscription quantity | write | `subscriptions.update_subscription_quantity(id: string, quantity: integer)` — Change the number of seats/units billed on a live subscription (applies from the next invoice). |
| Set subscription trial end | write | `subscriptions.set_subscription_trial_end(id: string, trialEnd: string)` — Set or extend the free-trial end date of a subscription (must be in the future). Puts the subscription in trialing until that date; first charge happens then. |
| Pause subscription | write | `subscriptions.pause_subscription(id: string, resumeAt?: string)` — Temporarily stop billing a live subscription (no invoices while paused). Use resume_subscription to restart. |
| Resume subscription | write | `subscriptions.resume_subscription(id: string)` — Restart a paused subscription (a new billing period starts now if the old one lapsed), or undo a scheduled cancel-at-period-end. |
| Cancel subscription | destructive | `subscriptions.cancel_subscription(id: string, atPeriodEnd?: boolean, reason?: string)` — Cancel a subscription immediately, or at the end of the current paid period (atPeriodEnd=true keeps access until then). |
| Preview next subscription invoice | read | `subscriptions.preview_next_invoice(id: string)` — Preview what the next renewal of a subscription will bill: date, line items, coupon discount and total. Read-only; does not create an invoice. |

## M31 Coupons

Create and manage discount codes: value, validity window, redemption limits and product restrictions.

| action | risk | signature / description |
|---|---|---|
| Create coupon | write | `coupons.create_coupon(code: string, description?: string, discountType: "percent"\|"fixed", discountValue: number, validFrom?: string, validUntil?: string, maxRedemptions?: integer, productIds?: string[])` — Create a discount code (percent or fixed amount) with optional validity window, redemption limit and product restriction. Codes are unique. |
| Get coupon details | read | `coupons.get_coupon(id: string)` — Fetch one coupon by ID (code, value, window, redemptions, product restriction). |
| Search coupons | read | `coupons.search_coupons(status?: "active"\|"inactive", discountType?: "percent"\|"fixed", limit?: integer, query?: string)` — Find coupons by code/description text, status, or discount type. |
| Update coupon description | write | `coupons.update_coupon_description(id: string, description: string)` — Change the internal/customer-facing description of a coupon. |
| Set discount value | write | `coupons.set_discount_value(id: string, discountValue: number, discountType?: "percent"\|"fixed")` — Change how much a coupon takes off: a percent (max 100) or a fixed amount. Optionally switch the discount type. |
| Set coupon validity window | write | `coupons.set_coupon_validity_window(id: string, validFrom?: string\|null, validUntil?: string\|null)` — Set when a coupon can be redeemed (validFrom / validUntil dates). Pass null to remove a bound. |
| Set redemption limit | write | `coupons.set_redemption_limit(id: string, maxRedemptions: integer\|null)` — Cap how many times a coupon can be redeemed in total (null = unlimited). Cannot be set below redemptions already used. |
| Restrict coupon to products | write | `coupons.restrict_coupon_to_products(id: string, productIds: string[])` — Limit a coupon to specific products (discount applies only to those lines). An empty list removes the restriction. |
| Validate coupon for order | read | `coupons.validate_coupon(code: string, orderId?: string, productIds?: string[], amount?: number)` — Check whether a coupon code can be used right now on an order (orderId) or a basket (productIds + amount): active, within window, redemptions left, product restriction. Returns valid, discount and reasons. Does not apply it (use orders.apply_coupon_to_order). |
| Deactivate coupon | destructive | `coupons.deactivate_coupon(id: string)` — Turn off a coupon so it can no longer be redeemed. Orders and subscriptions that already used it keep their discount history. |

## M32 Orders

Build, submit, and fulfil product orders with stock reservation, coupons and shipping.

| action | risk | signature / description |
|---|---|---|
| Create draft order | write | `orders.create_order(contactId: string, shippingAddress?: {name?: string, line1: string, line2?: string, city: string, state?: string, postalCode: string, country: string}, notes?: string)` — Start a draft product order for a contact. Add lines with add_order_line_item, then submit_order to reserve stock. (Quotes and invoices are separate modules.) |
| Get order details | read | `orders.get_order(id: string)` — Fetch one product order by ID with its lines, shipping address, coupon and totals. |
| Search orders | read | `orders.search_orders(query?: string, contactId?: string, status?: "draft"\|"submitted"\|"fulfilled"\|"cancelled", productId?: string, totalMin?: number, totalMax?: number, createdAtAfter?: string, createdAtBefore?: string, limit?: integer)` — Find product orders by number, contact, status, product, total range or created date range. |
| Add order line item | write | `orders.add_order_line_item(id: string, productId: string, variantId?: string, priceId?: string, quantity?: integer)` — Add a product (and variant, if it has variants) to a draft order. Unit price comes from priceId, else the variant override, else the product default one-time price. Same product+variant merges quantities. |
| Update order quantity | write | `orders.update_order_quantity(id: string, lineItemId: string, quantity: integer)` — Change the quantity of a line on a draft order; quantity 0 removes the line. Totals and any applied coupon are recalculated. |
| Set order shipping address | write | `orders.set_order_shipping_address(id: string, address: {name?: string, line1: string, line2?: string, city: string, state?: string, postalCode: string, country: string})` — Set or replace the shipping address of a draft order (required before submitting orders with physical items). |
| Apply coupon to order | write | `orders.apply_coupon_to_order(id: string, code: string)` — Apply a coupon code to a draft order using the same rules as coupons.validate_coupon (active, window, redemptions left, product restriction); stores the discount. Replaces any existing coupon. |
| Submit order | write | `orders.submit_order(id: string)` — Submit a draft order: requires lines, a shipping address when any item is physical, and enough available stock (on hand minus other reservations). Reserves stock and redeems the coupon. |
| Cancel order | destructive | `orders.cancel_order(id: string, reason?: string)` — Cancel a draft or submitted order, releasing reserved stock and the coupon redemption. Fulfilled orders cannot be cancelled (refund the payment instead). |
| Mark order fulfilled | write | `orders.fulfill_order(id: string, trackingNumber?: string)` — Mark a submitted order as shipped/delivered: converts its reservation into a stock decrement for tracked items. |

## M33 Refunds

Request, approve, and execute refunds of captured payments.

| action | risk | signature / description |
|---|---|---|
| Create refund request | write | `refunds.create_refund_request(paymentId: string, amount?: number, reason?: "requested_by_customer"\|"duplicate"\|"fraudulent"\|"service_not_delivered"\|"product_defective"\|"other", note?: string)` — Open a refund request against a succeeded payment (full refundable balance by default, or a partial amount). Needs approval before money moves; does not touch the payment yet. |
| Get refund request | read | `refunds.get_refund_request(id: string)` — Fetch one refund request by ID (payment, amount, reason, approval status). |
| Search refund requests | read | `refunds.search_refund_requests(paymentId?: string, contactId?: string, status?: "requested"\|"approved"\|"rejected"\|"executed", reason?: "requested_by_customer"\|"duplicate"\|"fraudulent"\|"service_not_delivered"\|"product_defective"\|"other", amountMin?: number, amountMax?: number, createdAtAfter?: string, createdAtBefore?: string, limit?: integer)` — Find refund requests by payment, contact, status, reason, amount range or created date range. |
| Set refund reason | write | `refunds.set_refund_reason(id: string, reason: "requested_by_customer"\|"duplicate"\|"fraudulent"\|"service_not_delivered"\|"product_defective"\|"other", note?: string)` — Change the reason category (and optional note) of a refund request that is not yet executed or rejected. |
| Set partial refund amount | write | `refunds.set_refund_amount(id: string, amount: number)` — Change the amount of a requested (not yet approved) refund; must not exceed the payment refundable balance. |
| Check refundable balance | read | `refunds.check_refundable_balance(paymentId: string)` — How much of a payment can still be refunded: payment amount minus already refunded minus approved-but-unexecuted refunds. |
| Approve refund request | write | `refunds.approve_refund_request(id: string)` — Approve a requested refund (re-checks the refundable balance). Approval reserves the amount; money moves only on execute_refund. |
| Reject refund request | write | `refunds.reject_refund_request(id: string, reason: string)` — Decline a requested or approved (not yet executed) refund with a reason; frees any reserved refundable balance. |
| Execute simulated refund | external | `refunds.execute_refund(id: string)` — Send an approved refund to the customer via the (simulated) processor: increases the payment refundedAmount/status and, if the payment was applied to invoices, reduces their amountPaid (unallocated money is refunded first). |
| Get refund execution status | read | `refunds.get_refund_execution_status(id: string)` — Where an individual refund stands after approval: not_executed, processing (sent to processor, awaiting settlement), or settled — with processor reference and invoice adjustments. |

## M34 Tax Rules

Configure sales tax/VAT by region and product category, customer exemptions, and calculate tax for orders.

| action | risk | signature / description |
|---|---|---|
| Create tax rule | write | `tax_rules.create_tax_rule(name: string, country: string, state?: string, rate: number, taxCategory?: "general"\|"digital"\|"services"\|"food"\|"exempt", inclusive?: boolean)` — Define a sales tax/VAT rate for a region (country, optional state), optionally only for one product tax category, as tax-exclusive or tax-inclusive pricing. |
| Get tax rule | read | `tax_rules.get_tax_rule(id: string)` — Fetch one tax rule by ID (region, rate, category, inclusive flag, status). |
| List tax rules | read | `tax_rules.list_tax_rules(country?: string, state?: string, taxCategory?: "general"\|"digital"\|"services"\|"food"\|"exempt", inclusive?: boolean, status?: "active"\|"inactive", limit?: integer, query?: string)` — List tax rules filtered by country, state, product tax category, inclusive flag or status. |
| Set tax rate | write | `tax_rules.set_tax_rate(id: string, rate: number)` — Change the percentage rate (0-100) of an active tax rule. |
| Set applicable region | write | `tax_rules.set_tax_region(id: string, country: string, state?: string\|null)` — Change the region (country and optional state) an active tax rule applies to. |
| Set product tax category | write | `tax_rules.set_product_tax_category(productId: string, taxCategory: "general"\|"digital"\|"services"\|"food"\|"exempt")` — Assign a tax category (general, digital, services, food, exempt) to a catalog product; tax rules for that category then apply to it. Exempt products are never taxed. |
| Set tax-inclusive pricing | write | `tax_rules.set_tax_inclusive(id: string, inclusive: boolean)` — Switch a tax rule between tax-inclusive (prices already contain the tax, it is extracted) and tax-exclusive (tax is added on top). |
| Record customer tax exemption | write | `tax_rules.record_tax_exemption(contactId: string, certificateNumber: string, country: string, state?: string, expiresAt?: string, reason?: string)` — Record a tax-exemption certificate for a contact in a region (e.g. reseller or non-profit); their tax in that region calculates as 0. |
| Calculate tax for order | read | `tax_rules.calculate_tax(orderId?: string, lineItems?: {productId: string, amount: number}[], region?: {country: string, state?: string}, contactId?: string)` — Compute tax for an order (orderId; region from its shipping address) or for ad-hoc lines + region. Applies the most specific active rule per line by region and product tax category; exempt contacts/products get 0; handles inclusive vs exclusive pricing. Read-only. |
| Deactivate tax rule | destructive | `tax_rules.deactivate_tax_rule(id: string)` — Stop applying a tax rule to new calculations (kept for history). |

## M35 Websites

Manage sites and their page collections.

| action | risk | signature / description |
|---|---|---|
| Create website | write | `websites.create_website(name: string, domain?: string)` — Create a new multi-page website (draft, no pages yet). Optionally connect a custom domain; names and domains must be unique. For a single conversion page use Create landing page; for a step-by-step journey use Create funnel. |
| Get website settings | read | `websites.get_website(id: string)` — Fetch one website by ID with its domain, status, pages, home page, navigation menu and SEO defaults. |
| List websites | read | `websites.list_websites(status?: "draft"\|"published"\|"unpublished", limit?: integer, query?: string)` — List websites in the account, filterable by status (draft/published/unpublished) or name/domain text. |
| Rename website | write | `websites.rename_website(id: string, name: string)` — Change the display name of a website (not its domain or page slugs). Names must be unique. |
| Add website page | write | `websites.add_website_page(id: string, title: string, slug: string)` — Add a page (title + URL slug) to a website. Slugs must be unique within that site. Not for standalone landing pages or blog posts. |
| Set website home page | write | `websites.set_website_home_page(id: string, pageId: string)` — Choose which of the website's own pages is served at the root URL (/). The page must already belong to that site. |
| Update site navigation | write | `websites.update_site_navigation(id: string, items: {label: string, pageId?: string, url?: string}[])` — Replace a website's menu with an ordered list of items; each item links either to one of the site's pages (pageId) or to an external URL (url), never both. |
| Set site SEO defaults | write | `websites.set_site_seo_defaults(id: string, titleTemplate?: string, metaDescription?: string, ogImage?: string)` — Set site-wide SEO defaults for a whole website: page title template (must contain %s for the page title), default meta description (max 160 chars) and default social share (og) image. Per-page SEO for landing pages or blog posts is a different action. |
| Publish website | external | `websites.publish_website(id: string)` — Make an entire website live on its domain (or a default subdomain). Requires a home page. Only for draft/unpublished sites — publishing a funnel, landing page or blog post are separate actions. |
| Unpublish website | external | `websites.unpublish_website(id: string)` — Take a published website offline (visitors get a not-found page). Content is kept and it can be republished. Does not affect funnels or landing pages. |

## M36 Funnels

Configure ordered journeys toward conversion.

| action | risk | signature / description |
|---|---|---|
| Create funnel | write | `funnels.create_funnel(name: string, description?: string, websiteId?: string)` — Create an empty draft sales/lead funnel (an ordered sequence of steps such as opt-in → sales → thank-you). Optionally attach it to a website domain. Not for single landing pages. |
| Get funnel definition | read | `funnels.get_funnel(id: string)` — Fetch one funnel by ID with its ordered steps (type, path, linked landing page), conversion goal and status. |
| List funnels | read | `funnels.list_funnels(status?: "draft"\|"published"\|"unpublished", websiteId?: string, limit?: integer, query?: string)` — List funnels, filterable by status, website, or name text. |
| Add funnel step | write | `funnels.add_funnel_step(id: string, name: string, type: "optin"\|"sales"\|"upsell"\|"downsell"\|"thankyou"\|"booking", path?: string)` — Append a step to a funnel (types: optin, sales, upsell, downsell, thankyou, booking). A funnel may have at most one thankyou step and 10 steps; new steps are inserted before an existing thankyou step. |
| Reorder funnel steps | write | `funnels.reorder_funnel_steps(id: string, orderedIds: string[])` — Set the order of a funnel's steps by passing every step ID in the new order. A thankyou step must stay last. |
| Remove funnel step | destructive | `funnels.remove_funnel_step(id: string, stepId: string)` — Delete a step from a draft or unpublished funnel (its landing-page link and step metrics are lost). Steps of a live (published) funnel cannot be removed; a step used by the conversion goal cannot be removed. |
| Link landing page to step | write | `funnels.link_landing_page_to_step(id: string, stepId: string, landingPageId: string)` — Attach an existing landing page (landing_pages ID) as the page shown for one funnel step. A landing page can back only one funnel step at a time; steps of a published funnel need a published page. |
| Set funnel conversion goal | write | `funnels.set_funnel_conversion_goal(id: string, type: "form_submit"\|"purchase"\|"booking", targetRate: number, stepId?: string)` — Define what counts as a conversion for a funnel (form_submit on an optin step, purchase on a sales/upsell/downsell step, booking on a booking step) and the target conversion rate in percent. |
| Publish funnel | external | `funnels.publish_funnel(id: string)` — Make a whole multi-step funnel live. Every step must be linked to a published landing page; otherwise fails and lists the steps that are not ready. Publishing a single landing page or a website are separate actions. |
| Get funnel conversion metrics | read | `funnels.get_funnel_metrics(id: string)` — Per-step visits, conversions, conversion rate and drop-off to the next step for a funnel (last 30 days), plus overall conversion vs. the goal target. Only for funnels that have been published. |

## M37 Landing Pages

Build and publish individual conversion pages.

| action | risk | signature / description |
|---|---|---|
| Create landing page | write | `landing_pages.create_landing_page(name: string, slug: string, headline?: string, websiteId?: string)` — Create a standalone draft landing page (single conversion page with a unique URL slug). Use Add website page for pages of a multi-page site. |
| Get landing page | read | `landing_pages.get_landing_page(id: string)` — Fetch one landing page by ID with headline, body, CTA, sections, attached form, SEO metadata and publish status. |
| Search landing pages | read | `landing_pages.search_landing_pages(status?: "draft"\|"published"\|"unpublished", websiteId?: string, formId?: string, limit?: integer, query?: string)` — Find landing pages by name/headline/slug text, status, website, or attached form. |
| Update page content | write | `landing_pages.update_page_content(id: string, headline?: string, body?: string, cta?: {text: string, url?: string})` — Edit a landing page's main copy: headline, body text, and call-to-action button (text + optional link). Sections are managed separately. |
| Add page section | write | `landing_pages.add_page_section(id: string, type: "hero"\|"features"\|"benefits"\|"testimonials"\|"pricing"\|"faq"\|"video"\|"form"\|"cta"\|"text"\|"gallery"\|"download", heading: string, content?: string, mediaUrl?: string)` — Append a content block to a landing page (types: hero, features, benefits, testimonials, pricing, faq, video, form, cta, text, gallery, download). Max 20 sections. A form section on a live page needs a form attached first. |
| Reorder page sections | write | `landing_pages.reorder_page_sections(id: string, orderedIds: string[])` — Set the order of a landing page's sections by passing every section ID in the new order. |
| Attach form to page | write | `landing_pages.attach_form_to_page(id: string, formId: string)` — Embed an existing form (forms ID) on a landing page so submissions are captured there. Replaces any previously attached form; archived forms are rejected. |
| Set page SEO metadata | write | `landing_pages.set_page_seo(id: string, title?: string, description?: string, keywords?: string[], noIndex?: boolean)` — Set search/social metadata for one landing page: SEO title (max 60), meta description (max 160), keywords, noIndex. Not for site-wide defaults or blog posts. |
| Publish landing page | external | `landing_pages.publish_landing_page(id: string)` — Make one landing page live at its URL. Requires a headline and at least one section; a page with a form section must have a form attached. Publishing a whole funnel or website are separate actions. |
| Unpublish landing page | external | `landing_pages.unpublish_landing_page(id: string)` — Take one published landing page offline. Blocked while it backs a step of a published funnel (link another published page to that step first). |

## M38 Blogs

Manage articles and editorial publishing.

| action | risk | signature / description |
|---|---|---|
| Create blog post | write | `blogs.create_blog_post(title: string, body: string, excerpt?: string, slug?: string, websiteId?: string, categories?: string[])` — Draft a new blog article (title, body, optional excerpt/categories/website). The slug is derived from the title unless given and must be unique. |
| Get blog post | read | `blogs.get_blog_post(id: string)` — Fetch one blog post by ID with body, author, categories, SEO, featured image and publish/schedule status. |
| Search blog posts | read | `blogs.search_blog_posts(status?: "draft"\|"scheduled"\|"published", authorId?: string, websiteId?: string, categories?: string, publishedAtAfter?: string, publishedAtBefore?: string, limit?: integer, query?: string)` — Find blog posts by title/excerpt/body text, status (draft/scheduled/published), author, website, category, or published date range. |
| Update blog post | write | `blogs.update_blog_post(id: string, title?: string, excerpt?: string, body?: string, slug?: string, featuredImage?: string)` — Edit a blog post's title, excerpt, body, slug or featured image (media asset ID or image URL). Edits to a published post go live immediately. |
| Assign post author | write | `blogs.assign_post_author(id: string, authorId: string)` — Set the byline author of a blog post. Author must be an active user. |
| Set post categories | write | `blogs.set_post_categories(id: string, categories: string[])` — Replace a blog post's categories (1-5, duplicates ignored case-insensitively). |
| Set post SEO metadata | write | `blogs.set_post_seo(id: string, metaTitle?: string, metaDescription?: string, focusKeyword?: string, canonicalUrl?: string)` — Set search metadata for one blog post: meta title (max 60), meta description (max 160), focus keyword, canonical URL. Not for landing pages or site-wide defaults. |
| Schedule post publication | external | `blogs.schedule_post(id: string, publishAt: string)` — Schedule a draft blog post to publish automatically at a future date/time. Requires an active author. To publish right now use Publish post. |
| Publish post | external | `blogs.publish_post(id: string)` — Publish a blog post on the blog right now (from draft or scheduled). Requires an active author and a body. Not for landing pages, funnels or websites. |
| Unpublish post | external | `blogs.unpublish_post(id: string)` — Pull a published blog post off the blog (or cancel a scheduled one), returning it to draft. Content is kept. |

## M39 Media Assets

Store and organize images and downloadable files.

| action | risk | signature / description |
|---|---|---|
| Upload media asset | write | `media.upload_media(name: string, mimeType: string, sizeBytes: integer, folder?: string, altText?: string)` — Add a file (image, video, audio, PDF/office document) to the media library in a folder. Max 50 MB; names must be unique per folder. Returns the hosted CDN url. |
| Get asset metadata | read | `media.get_media(id: string)` — Fetch one media asset by ID: name, type, size, folder, CDN url, alt text and version history. |
| Search media assets | read | `media.search_media(kind?: "image"\|"video"\|"audio"\|"document", folder?: string, mimeType?: string, sizeBytesMin?: number, sizeBytesMax?: number, createdAtAfter?: string, createdAtBefore?: string, limit?: integer, query?: string)` — Find media assets by name/alt-text, kind (image/video/audio/document), folder, MIME type, size range, or upload date range. |
| Rename media asset | write | `media.rename_media(id: string, name: string)` — Change a media asset's file name (keeps id and url, so references stay valid). The extension cannot change — use Replace asset file for a different format. |
| Set asset alt text | write | `media.set_media_alt_text(id: string, altText: string)` — Set the accessibility alt text of an image asset (max 250 chars). Rejected for videos, audio and documents. |
| Move asset to folder | write | `media.move_media(id: string, folder: string)` — Move a media asset to another folder (created implicitly). The url does not change. Fails if the target folder already has a file with the same name. |
| Replace asset file | write | `media.replace_media_file(id: string, mimeType: string, sizeBytes: integer, name?: string)` — Upload a new file version in place of an existing asset: same id and url, version +1, history kept. The new file must be the same kind (image→image) and ≤50 MB. |
| List asset references | read | `media.list_media_references(id: string)` — Show every record (landing page sections, blog featured images, website SEO, course lessons, etc.) that uses a media asset's id or url. Check before deleting or replacing. |
| Generate asset access link | external | `media.create_media_access_link(id: string, expiresInHours?: integer)` — Create a signed, expiring download link for a media asset (1-168 hours) that works for people outside the account. |
| Delete unreferenced asset | destructive | `media.delete_media(id: string)` — Permanently delete a media asset and its file. Refused (CONFLICT, listing the references) if any page, post, website or lesson still uses it. |

## M40 Courses

Configure learning programs and their structure.

| action | risk | signature / description |
|---|---|---|
| Create course | write | `courses.create_course(title: string, description?: string, instructorId?: string)` — Create a new online course (learning program) as a draft. Add sections and lessons, then publish it. Not for membership plans or communities. |
| Get course details | read | `courses.get_course(id: string)` — Fetch one course with its ordered sections, lesson titles and publish status, prerequisites, instructor and active enrollment count. |
| Search courses | read | `courses.search_courses(status?: "draft"\|"published"\|"archived", instructorId?: string, limit?: integer, query?: string)` — Find courses by title/description text, status, or instructor. Archived courses excluded unless status is given. |
| Update course details | write | `courses.update_course(id: string, title?: string, description?: string)` — Change the title or description of a course (not archived). |
| Add course section | write | `courses.add_course_section(id: string, title: string)` — Append a new (empty) section/module to a course outline. Lessons are added to sections via the Lessons module. |
| Reorder course sections | write | `courses.reorder_course_sections(id: string, orderedIds: string[])` — Change the order of sections in a course. Pass every section ID of the course in the new order. |
| Assign course instructor | write | `courses.assign_course_instructor(id: string, userId: string)` — Set the user who teaches a course. Must be an active user. |
| Set course prerequisites | write | `courses.set_course_prerequisites(id: string, prerequisiteIds: string[])` — Replace the list of courses a learner must complete before enrolling in this course. Pass [] to clear. Rejects self-references and cycles. |
| Publish course | external | `courses.publish_course(id: string)` — Make a draft course live so learners can be enrolled. Requires at least one section containing a published lesson. |
| Archive course | destructive | `courses.archive_course(id: string, force?: boolean)` — Archive (retire) a course so it can no longer be edited or enrolled in. Fails if learners are actively enrolled unless force is true. |

## M41 Lessons

Manage lesson content and completion conditions.

| action | risk | signature / description |
|---|---|---|
| Create lesson | write | `lessons.create_lesson(courseId: string, sectionId: string, title: string, type?: "video"\|"text"\|"quiz"\|"audio"\|"download", content?: string, durationMin?: integer)` — Add a new draft lesson to a section of a course (appended at the end of the section). |
| Get lesson details | read | `lessons.get_lesson(id: string)` — Fetch one lesson with its content, media, release (drip) schedule, completion criteria and its course/section titles. |
| Search lessons | read | `lessons.search_lessons(courseId?: string, sectionId?: string, type?: "video"\|"text"\|"quiz"\|"audio"\|"download", status?: "draft"\|"published", limit?: integer, query?: string)` — Find lessons by title/content text, course, section, type, or publish status. |
| Update lesson content | write | `lessons.update_lesson(id: string, title?: string, content?: string, type?: "video"\|"text"\|"quiz"\|"audio"\|"download", durationMin?: integer)` — Change a lesson's title, body content, type, or duration. |
| Attach lesson media | write | `lessons.attach_lesson_media(id: string, mediaId?: string, url?: string)` — Attach a video/audio/file to a lesson, either a Media library file (mediaId) or an external URL. Replaces any existing media. |
| Move lesson to course section | write | `lessons.move_lesson(id: string, sectionId: string, position?: integer)` — Move a lesson to another section of the same course (or a new position within its section). Cannot move across courses. |
| Set lesson release schedule | write | `lessons.set_lesson_release_schedule(id: string, mode: "immediate"\|"date"\|"drip", releaseAt?: string, daysAfterEnrollment?: integer)` — Drip-schedule a lesson: immediate (on enrollment), a fixed release date, or N days after each learner enrolls. |
| Set lesson completion criteria | write | `lessons.set_lesson_completion_criteria(id: string, criteria: "view"\|"quiz_pass"\|"video_percent", passingScore?: number, videoPercent?: integer)` — Define when a learner counts as having completed a lesson: view it, pass its quiz (passingScore %), or watch a minimum % of its video. |
| Publish lesson | external | `lessons.publish_lesson(id: string)` — Make a draft lesson visible to enrolled learners. It needs content or attached media. |
| Unpublish lesson | external | `lessons.unpublish_lesson(id: string)` — Hide a published lesson from learners (back to draft). Refused if it is the last published lesson of a published course. |

## M42 Enrollments

Manage learner access and learning progress.

| action | risk | signature / description |
|---|---|---|
| Enroll learner in course | write | `enrollments.enroll_learner(contactId: string, courseId: string, expiresAt?: string)` — Give a contact direct access to one published course (course enrollment). Checks prerequisites. For plan-based access use Memberships; for discussion spaces use Communities. |
| Get enrollment details | read | `enrollments.get_enrollment(id: string)` — Fetch one course enrollment with learner name, course title, completed lessons and progress summary. |
| Search enrollments | read | `enrollments.search_enrollments(contactId?: string, courseId?: string, status?: "active"\|"suspended"\|"expired"\|"revoked", enrolledAtAfter?: string, enrolledAtBefore?: string, expiresAtBefore?: string, limit?: integer)` — Find course enrollments by learner (contactId), course, status, enrollment date or expiry date. |
| Set enrollment expiry | write | `enrollments.set_enrollment_expiry(id: string, expiresAt: string\|null)` — Set or clear (null) the date a course enrollment's access ends. Extending an expired enrollment reactivates it. |
| Suspend enrollment | write | `enrollments.suspend_enrollment(id: string, reason: string)` — Temporarily block a learner's access to a course (progress kept). Reversible with resume_enrollment. |
| Resume enrollment | write | `enrollments.resume_enrollment(id: string)` — Restore a suspended course enrollment to active. |
| Revoke enrollment | destructive | `enrollments.revoke_enrollment(id: string, reason?: string)` — Permanently end a learner's course access (e.g. refund). Progress is kept for records; re-enrolling creates a new enrollment. |
| Record lesson completion | write | `enrollments.record_lesson_completion(id: string, lessonId: string, score?: number, percentWatched?: number)` — Mark a lesson complete for a course enrollment. The lesson must be published, released (drip) and in the enrolled course, and meet its completion criteria (quiz score / % watched). |
| Get learner progress | read | `enrollments.get_learner_progress(id?: string, contactId?: string, courseId?: string)` — Course progress for a learner: completed/total published lessons, percent, next lesson (and whether it is drip-locked), per-lesson status. Pass an enrollment id, or contactId + courseId. |
| Issue course completion certificate | external | `enrollments.issue_certificate(id: string)` — Issue a completion certificate for a course enrollment. Only allowed at 100% of published lessons; one certificate per learner per course. |

## M43 Communities

Operate discussion spaces and moderate content.

| action | risk | signature / description |
|---|---|---|
| Create community | write | `communities.create_community(name: string, description?: string, visibility?: "public"\|"private", guidelines?: string)` — Create an online discussion community (group/forum) with a default "general" channel. Private communities are joined via a membership plan. |
| Get community details | read | `communities.get_community(id: string)` — Fetch a community with its channels (post counts), members (names, roles) and guidelines. |
| Update community guidelines | write | `communities.update_community_guidelines(id: string, guidelines: string)` — Replace the code-of-conduct / posting rules text of a community. |
| Create discussion channel | write | `communities.create_channel(id: string, name: string, description?: string)` — Add a topic channel (e.g. "wins", "questions") to a community. |
| Join community | write | `communities.join_community(id: string, contactId: string)` — Add a contact as a member of a discussion community. Private communities require a live membership whose plan includes the community. Not a course enrollment. |
| Leave community | write | `communities.leave_community(id: string, contactId: string)` — Remove a contact from a community's member list (their posts stay). |
| Create community post | write | `communities.create_post(communityId: string, channelId: string, authorId: string, title?: string, body: string)` — Publish a new discussion post in a community channel. The author contact must be a member. |
| Reply to community post | write | `communities.reply_to_post(id: string, authorId: string, body: string)` — Add a reply/comment to a published community post. The replying contact must be a member. |
| Pin community post | write | `communities.pin_post(id: string, pinned?: boolean)` — Pin (or unpin with pinned:false) a post at the top of its channel. Max 3 pinned posts per channel. |
| Remove reported post | destructive | `communities.remove_reported_post(id: string, reason: string, force?: boolean)` — Moderation: take down a community post that members reported, recording the reason. Posts without reports need force:true. |

## M44 Memberships

Manage access packages spanning courses and communities.

| action | risk | signature / description |
|---|---|---|
| Create membership plan | write | `memberships.create_membership_plan(name: string, description?: string, price?: number, interval?: "month"\|"year"\|"one_time", entitlements?: {type: "course"\|"community", refId: string}[])` — Create a membership plan (access package/tier) that can bundle courses and private communities. Not a payment subscription. |
| Get membership plan | read | `memberships.get_membership_plan(id: string)` — Fetch one membership plan with its course/community entitlements and member counts. |
| List membership plans | read | `memberships.list_membership_plans(status?: "active"\|"archived", limit?: integer, query?: string)` — List/search membership plans by name. Archived plans excluded unless status is given. |
| Update plan description | write | `memberships.update_plan_description(id: string, description: string)` — Replace the description text of a membership plan. |
| Add plan entitlement | write | `memberships.add_plan_entitlement(id: string, type: "course"\|"community", refId: string)` — Include a course or community in a membership plan, so every active member of the plan gets access to it. |
| Remove plan entitlement | destructive | `memberships.remove_plan_entitlement(id: string, refId: string)` — Remove a course or community from a membership plan; its members lose that access (unless another plan grants it) and are removed from that community if it is private. |
| Grant membership to contact | write | `memberships.grant_membership(contactId: string, planId: string, expiresAt?: string)` — Give a contact a membership on a plan, granting access to all of the plan's courses and communities. For a single course use Enrollments. |
| Set membership expiry | write | `memberships.set_membership_expiry(id: string, expiresAt: string\|null)` — Set or clear (null) when a membership ends. Extending an expired membership reactivates it. |
| Revoke membership | destructive | `memberships.revoke_membership(id: string, reason?: string)` — End a contact's membership now; they lose every course/community access it granted and are removed from its private communities (unless another live membership covers them). |
| Check member access | read | `memberships.check_member_access(contactId: string, courseId?: string, communityId?: string)` — Check whether a contact can access a course or community through a membership plan (respects status and expiry). Public communities are always allowed. Direct course enrollments are in Enrollments. |

## M45 Reviews

Collect and respond to customer reviews.

| action | risk | signature / description |
|---|---|---|
| Create review request | write | `reviews.create_review_request(contactId: string, channel: "email"\|"sms", platform: "google"\|"facebook"\|"yelp", message?: string)` — Draft (not send) a request asking a contact to leave a review on Google, Facebook, or Yelp via email or SMS. Use send_review_request to deliver it. |
| Send review request | external | `reviews.send_review_request(id: string)` — Deliver a draft review request to the contact by its email/SMS channel (logs an outbound message). Fails if the contact opted out of that channel. |
| Cancel unsent review request | destructive | `reviews.cancel_review_request(id: string)` — Cancel a review request that is still a draft (already-sent requests cannot be recalled). |
| List review requests | read | `reviews.list_review_requests(status?: "draft"\|"sent"\|"completed"\|"cancelled", channel?: "email"\|"sms", platform?: "google"\|"facebook"\|"yelp", contactId?: string, createdAtAfter?: string, createdAtBefore?: string, limit?: integer)` — List outgoing review requests by status (draft/sent/completed/cancelled), channel, platform, contact, or created date. |
| Record simulated customer review | write | `reviews.record_review(rating: integer, text?: string, platform: "google"\|"facebook"\|"yelp", authorName?: string, contactId?: string, requestId?: string)` — Record a review a customer posted (simulated inbound from Google/Facebook/Yelp). If requestId is given, that sent request is marked completed. |
| Search reviews | read | `reviews.search_reviews(ratingMin?: integer, ratingMax?: integer, platform?: "google"\|"facebook"\|"yelp", responded?: boolean, contactId?: string, postedAtAfter?: string, postedAtBefore?: string, limit?: integer, query?: string)` — Find received customer reviews by rating range, platform, responded yes/no, posted date range, contact, or text. Newest first. |
| Get review details | read | `reviews.get_review(id: string)` — Fetch one received review, including any draft or published response. |
| Draft review response | write | `reviews.draft_review_response(id: string, text: string)` — Save a draft public reply on a review (not visible to anyone until publish_review_response). |
| Publish review response | external | `reviews.publish_review_response(id: string, text?: string)` — Post a public reply on the review platform, using the given text or the saved draft. |
| Get review rating summary | read | `reviews.get_review_summary(platform?: "google"\|"facebook"\|"yelp", postedAtAfter?: string, postedAtBefore?: string)` — Reputation overview: average star rating, review count, 1-5 star distribution, response rate, and per-platform breakdown. |

## M46 Business Listings

Manage business profiles in simulated directories.

| action | risk | signature / description |
|---|---|---|
| Create business listing | write | `listings.create_listing(name: string, address?: {street?: string, city?: string, state?: string, postalCode?: string, country?: string}, phone?: string, website?: string, categories?: string[], companyId?: string)` — Create a local business profile (name, address, phone, hours, categories) to publish to directories like Google Business Profile or Yelp. Not a website page or funnel. |
| Get listing details | read | `listings.get_listing(id: string)` — Fetch one business listing with its profile fields and per-directory sync records. |
| Search business listings | read | `listings.search_listings(query?: string, status?: "draft"\|"published"\|"archived", category?: string, city?: string, directory?: "google"\|"yelp"\|"bing"\|"apple"\|"facebook", syncStatus?: "synced"\|"pending"\|"failed"\|"not_listed", limit?: integer)` — Find business listings by name text, city, status, category, or by directory and its sync status (e.g. listings that failed on apple). |
| Update listing name | write | `listings.update_listing_name(id: string, name: string)` — Rename a business listing locally (republish to push it to directories). |
| Update listing address | write | `listings.update_listing_address(id: string, street?: string, city?: string, state?: string, postalCode?: string, country?: string)` — Change street, city, state, postal code, or country of a listing (merged into the current address). |
| Update listing phone | write | `listings.update_listing_phone(id: string, phone: string)` — Set the public phone number on a listing; must be E.164 with country code (separators are stripped). |
| Set listing business hours | write | `listings.set_listing_hours(id: string, hours: object)` — Set opening hours per weekday (mon..sun) as {open:'09:00', close:'17:00'} or 'closed'. Days not given keep their current hours. |
| Set listing categories | write | `listings.set_listing_categories(id: string, categories: string[])` — Replace the business categories on a listing (1-10, e.g. "Dentist", "Cosmetic Dentist"). |
| Publish listing to simulated directory | external | `listings.publish_listing(id: string, directories: "google"\|"yelp"\|"bing"\|"apple"\|"facebook"[])` — Push the current listing profile to one or more directories (google, yelp, bing, apple, facebook). Requires name, address and phone. Apple rejects listings with no categories. |
| Get listing sync status | read | `listings.get_listing_sync_status(id: string)` — Per-directory status (synced / pending / failed / not_listed) with fields edited locally since the last sync. Pending = local changes not yet republished. |

## M47 Support Tickets

Track customer issues and resolution work.

| action | risk | signature / description |
|---|---|---|
| Create support ticket | write | `tickets.create_ticket(subject: string, description?: string, contactId?: string, ownerId?: string, priority?: "urgent"\|"high"\|"normal"\|"low", channel?: "email"\|"chat"\|"phone"\|"web")` — Open a support ticket for a customer issue. Priority sets the resolution SLA deadline: urgent 4h, high 8h, normal 24h, low 72h. Not a task or a sales opportunity. |
| Get ticket details | read | `tickets.get_ticket(id: string)` — Fetch one support ticket with its internal notes and replies. |
| Search tickets | read | `tickets.search_tickets(query?: string, status?: "new"\|"open"\|"pending"\|"resolved"\|"closed", priority?: "urgent"\|"high"\|"normal"\|"low", ownerId?: string, contactId?: string, channel?: "email"\|"chat"\|"phone"\|"web", unassigned?: boolean, breached?: boolean, createdAtAfter?: string, createdAtBefore?: string, limit?: integer)` — Find support tickets by status, priority, owner, contact, unassigned, SLA breached, created date, or subject text. Most urgent SLA first. |
| Assign ticket owner | write | `tickets.assign_ticket(id: string, ownerId: string)` — Set the support agent who owns a ticket (moves new tickets to open). Owner must be an active user; warns if they lack the support role or are out of office. |
| Set ticket priority | write | `tickets.set_ticket_priority(id: string, priority: "urgent"\|"high"\|"normal"\|"low")` — Change ticket priority and recompute the SLA deadline from the ticket creation time (raising priority on an old ticket can breach it immediately). |
| Update ticket status | write | `tickets.update_ticket_status(id: string, status: "new"\|"open"\|"pending"\|"resolved"\|"closed")` — Move a ticket through new → open/pending → resolved → closed. Resolved can be reopened; closed is final and only reachable from resolved. |
| Add internal ticket note | write | `tickets.add_ticket_note(id: string, body: string)` — Add a private note on a ticket visible only to staff (not sent to the customer; use reply_to_ticket for that). |
| Reply to ticket requester | external | `tickets.reply_to_ticket(id: string, body: string)` — Email a reply to the ticket's linked contact (logged as an outbound message; records first response time). Requires a linked contact with an email. |
| Link ticket to contact | write | `tickets.link_ticket_contact(id: string, contactId: string)` — Set or change the requester contact on a ticket. |
| Get ticket SLA status | read | `tickets.get_ticket_sla(id: string)` — SLA check for one ticket: deadline, hours remaining or overdue, breached flag, and whether the first response came before the deadline. |

## M48 Users

Manage platform user accounts (staff, sales reps) and access.

| action | risk | signature / description |
|---|---|---|
| Invite user | external | `users.invite_user(name: string, email: string, role: "admin"\|"manager"\|"sales_rep"\|"support"\|"marketing"\|"billing", title?: string)` — Invite a new staff user by email with an initial role. Sends an invitation email. |
| Get user profile | read | `users.get_user(id: string)` — Fetch a staff user profile by ID. |
| List users | read | `users.list_users(roles?: "admin"\|"manager"\|"sales_rep"\|"support"\|"marketing"\|"billing", status?: "invited"\|"active"\|"deactivated", outOfOffice?: boolean, limit?: integer, query?: string)` — List staff users, filterable by role, status, out-of-office flag, or name/email text. Use to find available sales reps. |
| Update user profile | write | `users.update_user_profile(id: string, name?: string, title?: string, timezone?: string, phone?: string, outOfOffice?: boolean)` — Change a user name, title, timezone, phone, or out-of-office flag. |
| Assign user role | write | `users.assign_user_role(id: string, role: "admin"\|"manager"\|"sales_rep"\|"support"\|"marketing"\|"billing")` — Grant an additional role to a user. |
| Revoke user role | destructive | `users.revoke_user_role(id: string, role: "admin"\|"manager"\|"sales_rep"\|"support"\|"marketing"\|"billing")` — Remove a role from a user (a user must keep at least one role). |
| Deactivate user | destructive | `users.deactivate_user(id: string)` — Deactivate an active (or invited) user so they can no longer log in or own new records. They are removed as manager of any team; team memberships and owned records are kept so they can be reassigned. The last active admin cannot be deactivated. |
| Reactivate user | write | `users.reactivate_user(id: string)` — Reactivate a deactivated user. |
| List user permissions | read | `users.list_user_permissions(id: string)` — Effective permissions for a user, derived from their roles (none while deactivated). |
| View user audit activity | read | `users.get_user_audit_activity(id: string, limit?: integer)` — Actions performed by a user (audit log), newest first. |

## M49 Teams

Organize users into teams and allocate shared work.

| action | risk | signature / description |
|---|---|---|
| Create team | write | `teams.create_team(name: string, description?: string, memberIds?: string[], assignmentStrategy?: "round_robin"\|"least_busy"\|"manual")` — Create a team of active users. |
| Get team details | read | `teams.get_team(id: string)` — Team details with member names. |
| List teams | read | `teams.list_teams(status?: "active"\|"archived", limit?: integer, query?: string)` — List teams. Archived teams are excluded unless status is given. |
| Rename team | write | `teams.rename_team(id: string, name: string)` — Rename a team. |
| Add team member | write | `teams.add_team_member(id: string, userId: string)` — Add an active user to a team. |
| Remove team member | write | `teams.remove_team_member(id: string, userId: string)` — Remove a user from a team. |
| Assign team manager | write | `teams.assign_team_manager(id: string, userId: string)` — Set the manager of a team (must be an active user). |
| Set team assignment strategy | write | `teams.set_team_assignment_strategy(id: string, strategy: "round_robin"\|"least_busy"\|"manual")` — How new work is distributed: round_robin, least_busy, or manual. |
| Get team workload | read | `teams.get_team_workload(id: string)` — Per-member workload (open tasks, open leads, upcoming appointments) and availability (active and not out of office). Use to pick available reps for assignment. |
| Archive team | destructive | `teams.archive_team(id: string)` — Archive a team. |

## M50 Reports

Query business metrics and manage saved reports.

| action | risk | signature / description |
|---|---|---|
| Create saved report | write | `reports.create_report(name: string, metric: "leads_created"\|"deals_won"\|"pipeline_value"\|"revenue_collected"\|"invoices_overdue"\|"appointments_booked"\|"no_show_rate"\|"tickets_opened"\|"avg_review_rating"\|"messages_sent", dateRange?: {preset: "last_7_days"\|"last_30_days"\|"this_month"\|"last_month"\|"this_quarter"}\|{from: string, to: string}, groupBy?: "none"\|"day"\|"week"\|"month"\|"source"\|"owner"\|"status"\|"channel", filters?: object, description?: string)` — Save a reusable cross-module business report: one metric (leads_created, deals_won, pipeline_value, revenue_collected, invoices_overdue, appointments_booked, no_show_rate, tickets_opened, avg_review_rating, messages_sent) with filters, date range, and grouping. |
| Get report definition | read | `reports.get_report(id: string)` — Fetch a saved report definition (metric, filters, date range, grouping, schedule) without running it. |
| List saved reports | read | `reports.list_reports(metric?: "leads_created"\|"deals_won"\|"pipeline_value"\|"revenue_collected"\|"invoices_overdue"\|"appointments_booked"\|"no_show_rate"\|"tickets_opened"\|"avg_review_rating"\|"messages_sent", schedule?: boolean, limit?: integer, query?: string)` — List saved reports, optionally by metric, name text, or whether they have a delivery schedule. |
| Update report filters | write | `reports.update_report_filters(id: string, filters: object)` — Replace a saved report's filters ({} clears them). Keys must be fields of the metric's source table, e.g. leads_created: source, status, ownerId. |
| Set report date range | write | `reports.set_report_date_range(id: string, dateRange: {preset: "last_7_days"\|"last_30_days"\|"this_month"\|"last_month"\|"this_quarter"}\|{from: string, to: string})` — Set the saved date range of a report: a preset (last_7_days, last_30_days, this_month, last_month, this_quarter) or explicit from/to dates. |
| Set report grouping | write | `reports.set_report_grouping(id: string, groupBy: "none"\|"day"\|"week"\|"month"\|"source"\|"owner"\|"status"\|"channel")` — Set how a saved report breaks down its results: none, day, week, month, source, owner, status, or channel (must suit the metric). |
| Run report | read | `reports.run_report(id?: string, metric?: "leads_created"\|"deals_won"\|"pipeline_value"\|"revenue_collected"\|"invoices_overdue"\|"appointments_booked"\|"no_show_rate"\|"tickets_opened"\|"avg_review_rating"\|"messages_sent", dateRange?: {preset: "last_7_days"\|"last_30_days"\|"this_month"\|"last_month"\|"this_quarter"}\|{from: string, to: string}, groupBy?: "none"\|"day"\|"week"\|"month"\|"source"\|"owner"\|"status"\|"channel", filters?: object)` — Compute a business metric live across modules (leads, deals, revenue, overdue invoices, appointments, no-shows, tickets, ratings, messages) for a saved report or ad-hoc metric. Returns grouped rows and total. Use this for cross-module KPIs, not campaign- or funnel-specific stats. |
| Compare report periods | read | `reports.compare_report_periods(id?: string, metric?: "leads_created"\|"deals_won"\|"pipeline_value"\|"revenue_collected"\|"invoices_overdue"\|"appointments_booked"\|"no_show_rate"\|"tickets_opened"\|"avg_review_rating"\|"messages_sent", dateRange?: {preset: "last_7_days"\|"last_30_days"\|"this_month"\|"last_month"\|"this_quarter"}\|{from: string, to: string}, groupBy?: "none"\|"day"\|"week"\|"month"\|"source"\|"owner"\|"status"\|"channel", filters?: object)` — Compare a saved report or ad-hoc metric for its date range against the immediately preceding period (previous calendar month/quarter for the this_month, last_month and this_quarter presets; otherwise the same number of days): values, delta, and % change (per group when grouped by a dimension). |
| Export report results | write | `reports.export_report(id: string, format?: "csv"\|"json")` — Run a saved report now and store the results as a CSV or JSON export file (returns the file content). |
| Schedule report delivery | external | `reports.schedule_report(id: string, frequency: "daily"\|"weekly"\|"monthly", recipients: string[], dayOfWeek?: "sun"\|"mon"\|"tue"\|"wed"\|"thu"\|"fri"\|"sat")` — Email a saved report to recipients on a recurring schedule (daily, weekly on dayOfWeek, or monthly on the 1st), 08:00 UTC. Replaces any existing schedule. |
