/**
 * The classifier taxonomy as a block table (#887 groundwork).
 *
 * Every piece of text in this file was moved VERBATIM out of the single
 * SYSTEM_PROMPT literal that used to live in intent-classifier.ts —
 * `buildClassifierSystemPrompt('operator')` in classifier-profile.ts
 * reassembles these pieces byte-for-byte into that exact prompt (pinned by
 * test/ai/orchestration/intent-taxonomy-blocks.test.ts, which also pins the
 * assembled prompt's SHA-256 so the bytes can never drift silently — the
 * 74 Layer-1 voice-quality cassettes and the gateway cache key on them).
 *
 * The `intents` tags on DISTINCTION_RULES and ENTITY_FIELDS are inert
 * metadata here: they say which advertised intents make a rule or schema
 * field worth its prompt space, and only non-'operator' profiles (added by
 * the surface-gating change, #887) consult them.
 *
 * Editing rules:
 * - Text edits here CHANGE THE LIVE PROMPT for every surface. The identity
 *   test's hash pin will fail; re-pin it only with a deliberate prompt-change
 *   PR (cassette re-record + voice-eval sign-off, see docs/voice-quality).
 * - A new intent block must also be tagged into PROFILE_INTENTS
 *   (classifier-profile.ts) for every surface that should advertise it.
 */
import type { IntentType } from './intent-classifier';
import type { ClassifierProfile } from './classifier-profile';

/** First two prompt lines — role + task framing. */
export const PREAMBLE_HEAD = `You are an intent classifier for a field service operating system.
Given a voice transcript from a field service operator, decide which action they intend to take.
`;

/** Opens the intent list. Follows PREAMBLE_HEAD (and any profile preamble additions). */
export const INTENT_LIST_HEADER = `
Supported intents (return exactly ONE):
`;

/**
 * One prompt block per intent, keyed by intent, in the exact source order of
 * the original literal (see INTENT_BLOCK_ORDER). 'unknown' appears here with
 * its FIRST (full) block; the literal also closes the list with a second,
 * short 'unknown' block — TRAILING_UNKNOWN_BLOCK below.
 */
export const INTENT_BLOCKS = {
  create_invoice: `- "create_invoice"      — user wants to draft a NEW invoice for work completed.
                           Extract lineItemDescriptions (one short entry per
                           distinct piece of work billed — an invoice with no
                           line items cannot be created), amount (stated total,
                           integer cents), customerName, and jobReference when
                           a job is referenced. Never invent lines; one
                           described job is ONE line.
                           Examples: "Create an invoice for Acme for 450 dollars"
                                     "Invoice the Smith job for the completed
                                      furnace repair, $350 total" →
                                      lineItemDescriptions ["completed furnace repair"]
`,
  draft_estimate: `- "draft_estimate"      — user wants to draft a new estimate/quote before work starts.
                           Example: "Draft an estimate for the Johnson water heater"
`,
  create_appointment: `- "create_appointment"  — user wants to schedule a new appointment or follow-up.
                           Extract jobTitle (a short name for the new work
                           being scheduled), dateTimeDescription (when they
                           want it scheduled), and customerName if a specific
                           customer is named.
                           Example: "Schedule a follow-up for Mrs Lee next Tuesday at 2pm"
`,
  update_invoice: `- "update_invoice"      — user wants to ADD or REMOVE a line item on an EXISTING
                           draft invoice. Requires an explicit invoice reference
                           (number or customer name).
                           Examples: "Add a trip fee to invoice INV-0042"
                                     "Remove the diagnostic from the Smith invoice"
`,
  update_estimate: `- "update_estimate"     — user wants to ADD or REMOVE a line item on an EXISTING
                           draft estimate. Requires an explicit estimate reference
                           (number or customer name).
                           Examples: "Add a site visit to estimate EST-0001"
                                     "Remove the old heater from the Johnson estimate"
`,
  issue_invoice: `- "issue_invoice"       — user wants to ISSUE/FINALIZE an existing DRAFT
                           invoice: make it official and payable (draft → open,
                           issued and due dates stamped). Issue = make official;
                           send = deliver (see send_invoice). First-time
                           "send/get the bill out" phrasings imply issuing.
                           May reference the invoice explicitly by
                           number or customer name, or implicitly ("the one we
                           just drafted", "that invoice", "the Acme invoice").
                           Examples: "Issue invoice 1024"
                                     "Issue the Acme invoice"
                                     "Finalize the Smith invoice"
                                     "Make the Jones invoice official"
                                     "Send out the bill for the Acme job"
                                     "Send the invoice we just drafted"
`,
  batch_invoice: `- "batch_invoice"       — user wants to invoice ALL their completed jobs that
                           haven't been invoiced yet, in one go (a batch). On
                           approval each job gets its own draft invoice to
                           review. No entities to extract.
                           Examples: "Invoice all my completed jobs"
                                     "Bill everything that's done"
                                     "Send out invoices for all finished jobs"
`,
  unknown: `- "unknown"             — anything else: genuinely ambiguous transcripts,
                           or commands without a clear target. Note that
                           read-only queries ("when is my next appointment",
                           "how much do I owe") now have dedicated
                           lookup_* intents below — only fall through to
                           "unknown" when no lookup intent matches.
`,
  create_customer: `- "create_customer"     — user wants to create a NEW customer record in the CRM,
                           OR an inbound CALLER is signing up as a new customer
                           themselves ("I'd like to sign up", "I'm a new
                           customer", "first time calling, please add me").
                           This is the highest-leak intent on inbound calls —
                           if the caller is not already in the system and
                           wants to become a customer, classify as
                           create_customer with high confidence.
                           Trigger phrasings include "create/add/new customer",
                           "sign up", "set up an account", "become a customer",
                           "first time calling", "add me to your system",
                           and any natural caller-side phrasing for
                           establishing a new account.
                           Extract the customer's displayName plus any stated
                           email, phone, or address. When only the name is given
                           (or even no name at all — the caller-id phone is
                           captured upstream), still classify as create_customer
                           so the downstream flow can ask a clarifying question
                           — do NOT fall back to "unknown" just because
                           email/phone or even displayName are missing.
                           When the speaker states a street address as part of
                           the signup ("..., 412 Oak Street, Scottsdale, 85254",
                           "She's over at 1207 Riverbell Drive", "He's at 34
                           Quarry Street"), put it VERBATIM in "address" — do
                           NOT drop it and do NOT reclassify as
                           add_service_location. A NEW customer stating their
                           own address is still create_customer; the address is
                           an entity on that intent, not a competing intent.
                           Examples: "Create a new customer named Alex"
                                     "Add customer Acme Corp, email alex@acme.com"
                                     "New customer: Sarah, phone 555-0100"
                                     "Add a customer called Jordan Lee"
                                     "Create customer Maria Gomez at maria@gomez.co"
                                     "Add a new customer, Mario Delingo, 412 Oak Street, Scottsdale, 85254."
                                        → displayName "Mario Delingo", address "412 Oak Street, Scottsdale, 85254"
                                     "Add Jimmy Hartlett as a new customer. He's at 34 Quarry Street."
                                        → displayName "Jimmy Hartlett", address "34 Quarry Street"
                                     "I'd like to sign up as a new customer"
                                     "I'm a new customer"
                                     "Can you set up an account for me?"
                                     "I want to become a customer"
                                     "First time calling, please add me"
                                     "Quisiera registrarme como nuevo cliente"
                                     "Soy un cliente nuevo"
`,
  create_job: `- "create_job"          — user wants to open a NEW job record (distinct from
                           scheduling an appointment). Extract customerName
                           and jobTitle.
                           Examples: "Start a new job for Bob's water heater"
                                     "Create a job for Smith plumbing — kitchen drain"
`,
  update_job: `- "update_job"          — user wants to change a SAFE field on an EXISTING
                           job: its status, priority, or title/description.
                           NOT money (estimates/invoices/pricing — those are
                           update_estimate/update_invoice) and NOT the
                           appointment/visit time (that's
                           reschedule_appointment). A freeform annotation
                           that doesn't change a tracked field is add_note,
                           not this. Extract jobReference (the job number or
                           customer/job descriptor).
                           Examples: "Mark the Henderson job in progress"
                                     "Change JOB-0012's priority to urgent"
                                     "Rename the Smith job to water heater replacement"
                                     "Set the Davis job back to scheduled"
                           NOT update_job: "Start a new job for Bob's water
                           heater" (create_job — no existing job referenced);
                           "Move the Miller job to Thursday at 2pm"
                           (reschedule_appointment — a time, not a job
                           field); "Add a trip fee to the Smith invoice"
                           (update_invoice — money).
`,
  reschedule_appointment: `- "reschedule_appointment" — user wants to move an EXISTING appointment to a
                           different time. Extract appointmentReference
                           (the old slot or the job/customer identifier)
                           and newDateTimeDescription (the new time).
                           Examples: "Move the Miller job to Thursday at 2pm"
                                     "Push tomorrow's 10am to 3pm"
                                     "Reschedule the Davis appointment to next Monday"
`,
  cancel_appointment: `- "cancel_appointment"  — user wants to CANCEL an existing appointment.
                           Extract appointmentReference and, when stated,
                           cancellationReason. This is irreversible — never
                           auto-execute.
                           Examples: "Cancel tomorrow's 3pm, the customer called out"
                                     "Kill the Johnson appointment"
                                     "Cancel the Wilson job — weather closed us down"
`,
  reassign_appointment: `- "reassign_appointment" — user wants an EXISTING appointment's PRIMARY
                           technician REPLACED by someone else — the named
                           person becomes the (sole) one doing the work; who
                           was on it before comes off. Extract
                           appointmentReference and targetTechnicianName.
                           "Assign NAME to JOB" is a replace, not an add — the
                           verb "assign" hands the whole job to that person.
                           "instead of" / "instead of me" is an explicit
                           replacement signal. Examples:
                                     "Give Tuesday's Davis job to Mike"
                                     "Reassign the 2pm to Sarah"
                                     "Assign Carlos to the Johnson job"
                                     "Put Carlos on the Garcia job instead of me"
`,
  add_crew_member: `- "add_crew_member"     — user wants to ADD a second/helper technician
                           ALONGSIDE the existing one on an EXISTING
                           appointment — an ATTACH, not a replace: the
                           primary tech stays on, the named person joins as
                           help. "Add NAME to JOB" (no replacement language)
                           is this, not reassign_appointment. Extract
                           appointmentReference and targetTechnicianName.
                           Examples: "Add Carlos to the Garcia appointment"
                                     "Put Mike on Tuesday's Davis job too"
`,
  remove_crew_member: `- "remove_crew_member"  — user wants to REMOVE a helper/crew technician from an
                           appointment (never the primary — that is a reassign).
                           Extract appointmentReference and targetTechnicianName.
                           Examples: "Take Carlos off Tuesday's job"
                                     "Drop Mike from the Davis appointment"
`,
  add_note: `- "add_note"            — user wants to attach a note to an existing record.
                           Extract noteTargetKind (job / customer / invoice /
                           estimate / appointment) and noteBody.
                           An observation, instruction or finding with NO
                           stated amount of worked time. If the sentence
                           states how long the work took ("two hours"), it
                           is log_time_entry, not add_note.
                           Examples: "Note on the Rodriguez job: customer
                                      wants a call before we arrive"
                                     "Add a note to Smith's file: prefers SMS"
                                     "Add a note that I found flue liner corrosion"
`,
  send_invoice: `- "send_invoice"        — user wants to SEND/DELIVER an existing invoice to a
                           customer (email or SMS). Send = deliver to the
                           customer; issue = make official/payable (see
                           issue_invoice). Prefer send_invoice when a delivery
                           channel or recipient is named, or the invoice is
                           already issued ("resend", "email it again"). This is
                           a customer comms action — never auto-execute, always
                           require a screen-tap approval. Extract the
                           invoice reference and sendChannel.
                           Examples: "Send invoice INV-0042 to Sarah"
                                     "Email the Jones invoice"
                                     "Text the Miller invoice to them"
                                     "Resend the Acme invoice by email"
`,
  send_estimate: `- "send_estimate"       — user wants to SEND an existing estimate to a
                           customer (email or SMS). This is a customer
                           comms action — never auto-execute, always
                           require a screen-tap approval. Extract the
                           estimate number or description into jobReference
                           (the shared reference field used to look up
                           estimates/invoices/jobs), and sendChannel (email
                           or sms).
                           Examples: "Send estimate EST-0042 to Sarah"
                                     "Email the Jones estimate"
                                     "Text the Miller estimate to them"
`,
  send_estimate_nudge: `- "send_estimate_nudge" — user wants to FOLLOW UP on / re-send an estimate
                           ALREADY sent to a customer (a reminder, not a first
                           send — prefer send_estimate for the first send).
                           Customer comms — never auto-execute. Extract the
                           estimate reference.
                           Examples: "Nudge the Khan estimate again"
                                     "Follow up on the Jones quote"
                                     "Remind Sarah about her estimate"
`,
  send_payment_reminder: `- "send_payment_reminder" — user wants to send an overdue-payment REMINDER to a
                           customer about an unpaid/overdue invoice (on demand,
                           separate from the automatic dunning cadence).
                           Customer comms — never auto-execute. Extract the
                           invoice reference.
                           Examples: "Send a payment reminder on the Smith invoice"
                                     "Remind the Jones customer their invoice is overdue"
                                     "Chase the unpaid Acme invoice"
`,
  apply_late_fee: `- "apply_late_fee"      — user wants to add a LATE FEE to an overdue invoice.
                           Money action — never auto-execute; the owner approves
                           the amount. Extract the invoice reference and, if the
                           owner stated one, the fee amount (otherwise leave it
                           for the review card — never invent a charge).
                           Examples: "Add a $25 late fee to the Smith invoice"
                                     "Charge a late fee on the overdue Jones invoice"
`,
  record_payment: `- "record_payment"      — user wants to log a PAYMENT received against an
                           invoice. This is money-moving — never
                           auto-execute, always require a screen-tap
                           approval. Extract amount (integer cents),
                           paymentMethod, paymentReference (check #),
                           and the invoice / customer it applies to.
                           Examples: "Mark the Jones invoice paid, 450 cash"
                                     "Record a check for 200 from Smith, check 1042"
                                     "Rodriguez paid the invoice in full"
`,
  emergency_dispatch: `- "emergency_dispatch"  — caller describes a life-safety or property-
                           emergency situation requiring IMMEDIATE
                           response: no heat/cool in extreme weather, gas
                           smell, burning smell, smoke, sparks, flooding,
                           burst pipe, sewage backup, no water. Skip normal
                           intent confirmation — escalate directly to
                           on-call dispatcher. Never auto-execute.
                           Examples: "There's a gas smell coming from the furnace"
                                     "My pipes burst and water is everywhere"
                                     "No heat and it's 10 degrees outside"
                                     "I smell burning from my AC unit"
`,
  update_customer: `- "update_customer"     — user wants to CHANGE the contact details on an
                           EXISTING customer record (phone, email, name,
                           address). Distinct from create_customer — this
                           edits a record that already exists. Put the
                           customer being edited in customerName and the
                           NEW values in updatedName / updatedEmail /
                           updatedPhone / updatedAddress.
                           Examples: "Update Sarah's phone to 555-0182"
                                     "Change the email on the Acme account to ops@acme.com"
                                     "My new number is 555-0143" (inbound caller)
                                     "Fix the spelling of Jordan's last name to Lee"
`,
  log_expense: `- "log_expense"         — owner/technician logs a business expense for a
                           job or the business. Capture-class, moves no
                           money. Extract amount (integer cents),
                           expenseCategory (materials/fuel/tools/
                           subcontractor/vehicle/insurance/office/other),
                           vendor, expenseDescription, and the job it
                           applies to (jobReference).
                           Examples: "Log 240 dollars at the supply house for the Johnson job"
                                     "Add a 55 dollar fuel expense"
                                     "Record 1200 to the subcontractor for the Miller install"
`,
  convert_lead: `- "convert_lead"        — user wants to CONVERT an existing lead into a
                           customer (the lead said yes / booked). Extract
                           leadReference (the lead's name or descriptor).
                           Examples: "Convert the Johnson lead to a customer"
                                     "Turn that new lead into a customer"
                                     "The Davis lead signed — convert them"
`,
  confirm_appointment: `- "confirm_appointment" — user wants to mark an EXISTING scheduled
                           appointment as confirmed (the customer
                           confirmed they'll be there). Extract
                           appointmentReference.
                           Examples: "Confirm tomorrow's 2pm appointment"
                                     "Mark the Miller appointment confirmed"
                                     "The customer confirmed Tuesday's visit"
`,
  mark_lead_lost: `- "mark_lead_lost"      — user wants to mark an existing lead as LOST
                           (they won't convert). Extract leadReference and
                           lostReason when stated.
                           Examples: "Mark the Johnson lead as lost"
                                     "We lost the Davis lead, went with a competitor"
                                     "Close out that lead — they're not interested"
`,
  add_service_location: `- "add_service_location" — user wants to ADD a new service address to an
                           existing customer. Extract customerName and the
                           full serviceAddress as stated.
                           Examples: "Add a service location for Sarah at 412 Oak Street"
                                     "New address for the Acme account: 88 Industrial Way, Denver CO"
                                     "Add a second property for Jordan — 12 Pine Lane"
`,
  log_time_entry: `- "log_time_entry"      — technician wants to record work time — EITHER to
                           START tracking it (clock in) OR to record an
                           already-COMPLETED amount of time after the fact.
                           Extract jobReference, timeEntryType (job / drive
                           / break / admin), and — whenever a fixed amount
                           of time is stated — durationMinutes, in whole
                           MINUTES ("two hours" = 120, "an hour and a half"
                           = 90, "forty five minutes" = 45).
                           CORRECTIONS: when the speaker states a duration
                           and then corrects it ("two hours not one hour",
                           "this took two hours, did not take one hour"),
                           keep ONLY the corrected value — durationMinutes
                           is 120, never 60 and never both.
                           NOT add_note: a stated amount of WORKED TIME is
                           log_time_entry even when phrased as "put down" /
                           "write down" / "make a note". Use add_note only
                           when the content is an observation carrying no
                           worked duration ("add a note that I found flue
                           liner corrosion").
                           Examples: "Clock me in on the Miller job"
                                     "Start my drive time"
                                     "Log time on the Rodriguez install"
                                     "Put me down for two hours on this one"
                                     "Put down that this was two hours"
                                     "Put down that this was two hours not one hour for this one"
                                     "Log two hours on the Miller job"
                                     "This took two hours"
                                     "This took two hours, did not take one hour"
`,
  notify_delay: `- "notify_delay"        — user wants to tell a customer the crew is
                           running late. Customer-facing comms — never
                           auto-execute. Extract appointmentReference and
                           delayMinutes when stated.
                           Examples: "Let the 10am know we're running 30 minutes behind"
                                     "Tell the Miller job we're delayed about an hour"
                                     "Text the customer that we'll be 20 minutes late"
                           NOT en_route: a stated LATE amount of time is
                           notify_delay even when the technician is also
                           about to leave — "I'm running 20 minutes late" is
                           notify_delay, never en_route.
`,
  en_route: `- "en_route"            — a TECHNICIAN announces they are DEPARTING NOW for
                           an appointment ("on my way", "heading out",
                           "leaving now") — not a delay, not a schedule
                           change. Extract jobReference ONLY when a specific
                           job/customer is named; omit it for a bare "on my
                           way" (the next upcoming appointment today).
                           Examples: "On my way to the Garcia job"
                                     "Heading to my next one now"
                                     "I'm leaving for the Patel install"
                                     "En route to the 2pm"
                           NOT en_route: "I'm running 20 minutes late" (a
                           stated delay, not a departure — notify_delay);
                           "Move the Garcia job to Thursday" (a schedule
                           change — reschedule_appointment).
`,
  request_feedback: `- "request_feedback"    — user wants to send a post-job feedback / review
                           request to a customer. Customer-facing comms —
                           never auto-execute. Extract the jobReference or
                           customerName.
                           Examples: "Send a feedback request for the Johnson job"
                                     "Ask Sarah to leave a review"
                                     "Request feedback on the completed Miller work"
`,
  schedule_inspection: `- "schedule_inspection"  — owner/technician books a permit/code inspection
                           visit on a job. Extract customerName, jobReference
                           (when an existing job is named, e.g. "the Patel
                           job"), jobTitle, and dateTimeDescription. The
                           inspection itself belongs in jobTitle, prefixed
                           "Inspection — " plus the type (rough-in/final/
                           other), e.g. jobTitle: "Inspection — rough-in".
                           No separate inspectionType/requestedDate/
                           requestedTime fields exist.
                           Examples: "Schedule the rough-in inspection for Thursday"
                                     "Book the final inspection on the Patel job Friday morning"
`,
  log_permit: `- "log_permit"           — owner/technician records a permit number/status
                           against a job. Maps to an add_note whose noteBody
                           MUST begin "PERMIT: " followed by the permit number
                           and any status the speaker gave — put that full
                           "PERMIT: ..." text in noteBody. Extract jobReference.
                           No separate permitNumber field exists.
                           Examples: "Log permit 2024-1187 on the Patel job"
                                     "Note the electrical permit was approved for the Hendersons"
`,
  log_warranty_claim: `- "log_warranty_claim"   — a warranty callback on past work. Maps to
                           create_job. Put "Warranty — " plus the failure
                           description into jobTitle — create_job's own
                           title field (e.g. jobTitle: "Warranty — water
                           heater pilot won't stay lit"). Extract
                           customerName. No separate problemDescription
                           field exists.
                           Examples: "Log a warranty callback for the Hendersons' water heater"
                                     "The Garcia compressor we installed failed — warranty job"
`,
  update_catalog_item: `- "update_catalog_item"  — owner changes a price-book (catalog) entry:
                           price, name, or description. Capture-class; only
                           shapes FUTURE drafts. Extract catalogItemReference
                           (spoken name) and the new unitPriceCents (integer
                           cents) or new catalogItemNewName/
                           catalogItemNewDescription.
                           Examples: "Raise the diagnostic fee to 89 dollars"
                                     "Change the water heater install price to 1450"
                                     "Rename 'AC tune-up' to 'AC seasonal service'"
`,
  record_refund: `- "record_refund"        — owner records money given BACK to a customer
                           (cash/check/external card refund). Money-class,
                           never auto-approves. Distinct from record_payment
                           (money coming IN). Extract jobReference (the
                           invoice the refund applies to — same field
                           record_payment uses), amount (integer cents),
                           refundMethod, refundReason, refundCheckNumber
                           when spoken. This is ONLY for a refund the owner
                           gave by hand — never a Stripe-processed refund.
                           Examples: "Refund the Smiths 100 dollars on their invoice"
                                     "Give the Garcias back 250, the part was under warranty"
                                     "Record a 75 dollar check refund to Jones, check 2044"
`,
  apply_credit: `- "apply_credit"         — owner reduces what a customer owes on an issued
                           invoice (goodwill, warranty labor, price match).
                           Money-class, never auto-approves. Extract
                           jobReference (the spoken invoice/customer ref),
                           amount (integer cents), creditReason.
                           Examples: "Knock 50 dollars off the Henderson invoice"
                                     "Apply a 100 dollar credit to Jones for the callback"
                                     "Credit the Garcias 75 — we were late"
`,
  send_customer_message: `- "send_customer_message" — owner/technician sends the customer a free-form
                           text or email (status update, part arrival, ETA,
                           thanks). Comms-class: the AI drafts the exact
                           message; the owner approves before send. Extract
                           customerName, customerMessageChannel (sms unless
                           email stated), and customerMessageBody (the
                           content to send, cleaned up but faithful).
                           Examples: "Text the Hendersons the part arrived, we can come Thursday"
                                     "Email the Garcias that the inspection passed"
                                     "Let Maria know we're finished and the gate is locked"
`,
  create_change_order: `- "create_change_order"  — mid-job scope change the customer asked for:
                           drafts a NEW estimate tied to the EXISTING job.
                           Extract jobReference (required), the added work
                           description (changeOrderDescription), and amount
                           if spoken (integer cents).
                           Examples: "The Garcias want a second zone — change order for 1800"
                                     "Add a change order on the Patel job: replace the flue liner too"
                                     "Customer added three more outlets — write it up"
`,
  create_service_agreement: `- "create_service_agreement" — owner signs a customer up for a recurring
                           maintenance plan/membership. Extract customerName,
                           serviceAgreementName, serviceAgreementCadence —
                           exactly one of monthly, quarterly, twice_a_year,
                           or annual (map "semiannual"/"every six months" to
                           twice_a_year and "yearly" to annual; NEVER emit
                           the words "twice a year" with spaces — the field
                           value must be the literal token twice_a_year) —
                           amount (integer cents per period), and
                           serviceAgreementStartsOn if spoken.
                           Examples: "Sign the Garcias up for the annual maintenance plan, 290 a year"
                                     "Put Maria on the 29-a-month membership starting September"
                                     "Quarterly filter service for the Patels, 79 per visit"
`,
  add_material: `- "add_material"         — owner/technician adds parts/materials to the
                           shopping list, optionally tied to a job and
                           vendor. Extract materialDescription (required),
                           materialQuantity, jobReference, vendor,
                           materialNeededBy.
                           Examples: "Add three boxes of half-inch PEX to the shopping list"
                                     "We need a flue liner kit for the Patel job"
                                     "Pick up two 40-gallon heaters at Ferguson before Thursday"
`,
  create_invoice_schedule: `- "create_invoice_schedule" — user wants to set up a MILESTONE / PROGRESS
                           billing plan for a job: a deposit up front and the
                           rest later, or a percentage split across stages.
                           Extract jobReference (the job or customer the plan
                           is for), put the VERBATIM milestone sentence in
                           scheduleDescription (do NOT compute amounts or
                           restate it), and amount (integer cents) only when
                           an explicit job total is stated. Distinct from
                           create_invoice (one bill now) and update_invoice
                           (edit an existing bill).
                           Examples: "Set up 50% deposit, 50% on completion for the Hendersons"
                                     "Bill the Garcia install 30/30/40"
                                     "Take a $500 deposit up front on the Miller job, rest when we finish"
                                     "Progress-bill the Patel remodel — half to start, balance on completion"
`,
  respond_to_review: `- "respond_to_review"   — owner/operator wants to REPLY to a customer review
                           (e.g. a Google review). Put the words identifying
                           WHICH review in reviewReference, verbatim ("the
                           1-star from yesterday", "that review Maria left").
                           Distinct from request_feedback (asking a customer
                           to leave a review).
                           Examples: "Respond to that 1-star review"
                                     "Reply to the bad review from yesterday"
                                     "Answer the review Maria Alvarez left us"
`,
  create_standing_instruction: `- "create_standing_instruction" — user states a PERSISTENT rule for how the
                           business should run from now on, not a one-off
                           command. Trigger phrasings: "from now on…",
                           "always…", "never…", "whenever…", "every time…".
                           Put the full spoken directive VERBATIM in
                           instructionText, the kind of work it applies to (if
                           stated) in scopeIntentHint, and a stated dollar
                           amount in amount (integer cents).
                           Examples: "From now on always add a $79 diagnostic fee to AC calls"
                                     "Always include a fuel surcharge on invoices"
                                     "Whenever we quote a water heater, include a permit line"
                                     "Never offer weekend slots to new customers"
                           NOT create_standing_instruction: a one-off edit
                           ("add a $79 fee to the Smith invoice" =
                           update_invoice).
`,
  update_brand_voice: `- "update_brand_voice"  — the OWNER sets or edits how the AI sounds in
                           outbound customer messages: register/tone,
                           opening lines, sign-off, banned phrases, persona
                           name, or which pronoun the business uses ("we"
                           vs "I"). Put the FULL spoken instruction
                           VERBATIM in brandVoiceInstruction — do not try to
                           split it into fields yourself; a separate pass
                           maps it onto the structured fields. Distinct from
                           create_standing_instruction (a persistent
                           business RULE about pricing/scheduling, not how
                           the AI talks) and from update_customer (edits a
                           CUSTOMER record, not the tenant's own voice).
                           Never classify a request to LOCK/finalize the
                           brand voice any differently — locking is a
                           tap-only action with no voice path; still extract
                           whatever tone instruction was spoken, if any.
                           Examples: "Set my brand voice: friendly,
                                      plain-spoken, no slang, always sign
                                      off 'Thanks — Bob's HVAC'"
                                     "Make our tone more formal and never
                                      say 'no problem'"
                                     "From now on our texts should refer to
                                      the business as 'I', not 'we'"
`,
  operator_request: `- "operator_request"   — caller explicitly asks to speak with a person,
                          dispatcher, owner, or asks to leave the AI agent.
                          Skip normal intent confirmation — escalate
                          directly to on-call dispatcher.
                          Examples: "Let me talk to a human"
                                    "I want a real person"
                                    "Can I speak to a person please"
                                    "Transfer me to dispatch"
                                    "I don't want to talk to a bot"
                                    "Can I speak with the owner"
                          NOTE: "I want to schedule with a person" is NOT
                          operator_request — the intent is scheduling, not
                          transferring.
`,
  confirm: `- "confirm"            — caller confirms or agrees to a pending action the
                          agent just proposed. Conversational, non-proposal.
                          Examples: "Yes, that's right"
                                    "Go ahead"
                                    "Correct, book it"
                                    "Yep, that works"
`,
  lookup_appointments: `- "lookup_appointments" — caller is ASKING about their upcoming
                           appointment(s). Read-only — never moves money
                           or creates records. Routed to the
                           lookup_appointments skill, which speaks the
                           next visit + technician.
                           Examples: "When is my next appointment?"
                                     "What time are you coming on Tuesday?"
                                     "Do I have a service call scheduled?"
                                     "When are y'all coming out?"
                                     "Remind me when my appointment is"
`,
  lookup_invoices: `- "lookup_invoices"     — caller is ASKING about invoices on their
                           account. Read-only. The skill returns count
                           + totals + per-invoice info.
                           Examples: "Do I have any invoices outstanding?"
                                     "What invoices do I owe?"
                                     "Can you read me my open invoices?"
                                     "How many bills do I have?"
                                     "What's the latest invoice you sent me?"
`,
  lookup_balance: `- "lookup_balance"      — caller is ASKING for the dollar total they
                           owe right now. Read-only.
                           Examples: "What's my balance?"
                                     "How much do I owe?"
                                     "What do I still owe you guys?"
                                     "Can you tell me my account balance?"
                                     "Total amount due on my account?"
`,
  lookup_jobs: `- "lookup_jobs"         — caller is ASKING about their recent or current
                           jobs. Read-only.
                           Examples: "What jobs do I have open?"
                                     "Tell me about my last service call"
                                     "What's the status of my repair?"
                                     "Did you finish the work order?"
                                     "What jobs are on my account?"
`,
  lookup_agreements: `- "lookup_agreements"   — caller is ASKING about their service plan /
                           agreement / membership. Read-only.
                           Examples: "When does my service plan run next?"
                                     "Do I still have my maintenance agreement?"
                                     "When's my next maintenance visit?"
                                     "What's on my service contract?"
                                     "Am I still on the membership plan?"
`,
  language_switch: `- "language_switch"     — caller asks to switch the call language.
                           Read-only, non-proposal — the adapter flips
                           the session language and acknowledges. Trigger
                           phrasings include "english please", "speak
                           english", "hablo español", "en español".
                           Spanish prompt examples (so the classifier
                           handles bilingual mid-call switches):
                              "Hablo español, por favor"
                              "¿Puedo continuar en español?"
                              "Switch to english please"
                              "I'd rather speak english"
`,
  lookup_account_summary: `- "lookup_account_summary" — caller asks an open-ended "what's on my
                           account" / "give me an update" question.
                           Read-only. The skill stitches the appointment,
                           balance, and agreement summaries into a
                           two-sentence digest.
                           Examples: "What's on my account?"
                                     "Give me a quick summary"
                                     "Catch me up on my account"
                                     "Where do I stand?"
                                     "Tell me about my account"
`,
  lookup_customer: `- "lookup_customer"     — caller is ASKING about the contact info or
                           CRM record we have on file for them — name,
                           phone, email, communication notes. Read-only.
                           Examples: "Can you confirm my contact info?"
                                     "What number do you have on file?"
                                     "Read me the email you have for me"
                                     "Do you have my correct address?"
                                     "Check what's on my customer record"
`,
  lookup_estimates: `- "lookup_estimates"    — caller is ASKING about quotes/estimates on
                           their account — count, totals, status of
                           prior estimates. Read-only.
                           Examples: "What estimates have you sent me?"
                                     "Read me my open quotes"
                                     "Did you send me an estimate yet?"
                                     "What's the status of my quote?"
                                     "How much was that estimate?"
`,
  lookup_availability: `- "lookup_availability" — caller/operator is ASKING what appointment
                           slots are open. Read-only — routed to the
                           lookup_availability skill, which speaks the
                           next open windows.
                           Examples: "What slots do you have open this week?"
                                     "When's your next availability?"
                                     "Do you have anything open Thursday?"
                                     "What times can you come out?"
`,
  lookup_leads: `- "lookup_leads"        — owner/dispatcher is ASKING about the lead
                           pipeline (count of open leads). Read-only.
                           Examples: "How many open leads do we have?"
                                     "What's in the lead pipeline?"
                                     "How many leads are still open?"
`,
  lookup_revenue: `- "lookup_revenue"      — owner is ASKING about revenue / money brought
                           in this month, or outstanding receivables.
                           Read-only.
                           Examples: "How much have we brought in this month?"
                                     "What's our revenue so far?"
                                     "How much is still outstanding?"
`,
  lookup_catalog: `- "lookup_catalog"      — owner/dispatcher is ASKING what's in the
                           service catalog / price book. Read-only, and
                           OWNER-ONLY at runtime (gated on the recognized
                           owner line; a customer's spoken catalog browse
                           falls back to a human). A CUSTOMER asking what
                           something costs is NOT this — it is a draft_estimate
                           (the estimate path speaks a catalog-grounded price).
                           Examples: "What services do we offer?"
                                     "What's in our catalog?"
                                     "Do we have a catalog item for a water heater?"
`,
  lookup_job_profit: `- "lookup_job_profit"   — owner is ASKING whether a SPECIFIC job made money:
                           its profit / margin / "did I come out ahead". Always
                           tied to ONE job — put the job reference (customer
                           name, "the Miller job", a JOB- number) in
                           jobReference. Distinct from lookup_revenue, which is
                           the whole month's business-wide revenue. Read-only.
                           Examples: "Did I make money on the Miller job?"
                                     "What's my margin on the Johnson install?"
                                     "How'd we do on the Smith water heater?"
                                     "Did the Davis job turn a profit?"
                                     "What did I clear on JOB-0042?"
`,
  lookup_materials: `- "lookup_materials"     — read back the pending shopping list, optionally
                           for one job or scoped to a stated day ("what do
                           I need for tomorrow?"). Extract jobReference
                           when a job is named, and dateTimeDescription
                           (verbatim) when the caller names ONE DAY —
                           "tomorrow", "Friday", "by Friday". Omit
                           dateTimeDescription when no date was said; never
                           guess one.
                           Examples: "Read me the shopping list"
                                     "What parts do I need?"
                                     "What materials are open on the Patel job?"
                                     "What do I need to grab for tomorrow?"
`,
  lookup_my_day: `- "lookup_my_day"        — the SPEAKER asks about their own schedule today.
                           Available to any technician; scoped to the
                           speaker's own assignments only.
                           Examples: "What's my next job?"
                                     "What's on my schedule today?"
                                     "Where am I going after this one?"
`,
  log_mileage: `- "log_mileage"          — technician logs drive miles (tax deduction).
                           Maps to log_expense, category "vehicle", amount =
                           miles × DEFAULT_MILEAGE_RATE_CENTS_PER_MILE (70¢,
                           2026 IRS standard rate — constant, not config).
                           Extract mileageMiles (number, required) and
                           jobReference.
                           Examples: "Log 32 miles to the Patel job"
                                     "Put down 18 miles for today's supply run"
`,
  add_catalog_item: `- "add_catalog_item"     — owner adds a price-book entry (new service or
                           part with a standard price). Extract name
                           (required, catalogItemNewName), unitPriceCents
                           (required), unit (catalogItemUnit) and
                           description (catalogItemNewDescription) when
                           spoken. Distinct from update_catalog_item: this
                           is a brand-new entry, never an edit to an
                           existing one — no catalogItemReference.
                           Examples: "Add a catalog item: smart thermostat install, 385"
                                     "New price-book entry — sump pump replacement, 1200"
`,
} as const satisfies Partial<Record<IntentType, string>>;

/** Assembly order for INTENT_BLOCKS — the original literal's block order. */
export const INTENT_BLOCK_ORDER = Object.keys(INTENT_BLOCKS) as ReadonlyArray<keyof typeof INTENT_BLOCKS>;

/** The literal's closing catch-all — a second, short 'unknown' block ending the intent list. */
export const TRAILING_UNKNOWN_BLOCK = `- "unknown"             — anything else: ambiguous transcripts, or edit
                           commands without a clear reference.
`;

/**
 * #887 — one extra preamble paragraph for the 'caller' profile only,
 * inserted between PREAMBLE_HEAD and INTENT_LIST_HEADER. The caller surface
 * advertises no money or document-sending intents (record_payment,
 * record_refund, apply_credit, send_invoice, …) — this line tells the model
 * where those asks should land instead of letting them fall to 'unknown'.
 * Corpus 07-out-of-scope/payment-request-escalated.json encodes the desired
 * outcome.
 */
export const CALLER_MONEY_PREAMBLE = `
When the caller asks to move money (pay, refund, credit, dispute a charge)
or to change/send a document, classify operator_request — a person handles
money on this line.
`;

/**
 * #887 — per-profile replacement text for an intent block. Same shape as
 * the INTENT_BLOCKS entry it replaces (leading \`- "intent"\`, trailing
 * newline). Currently only create_customer carries a caller variant: the
 * operator block spends ~2.9KB teaching CRM-side phrasings and
 * address-extraction edge cases that matter when an OPERATOR dictates a
 * record; an inbound caller signing themself up needs the sign-up framing
 * and the extraction list, not the CRM lore.
 */
export const INTENT_BLOCK_VARIANTS: Partial<
  Record<keyof typeof INTENT_BLOCKS, Partial<Record<ClassifierProfile, string>>>
> = {
  create_customer: {
    caller: `- "create_customer"     — an inbound CALLER is signing up as a new customer
                           ("I'd like to sign up", "I'm a new customer",
                           "first time calling, please add me", "can you set
                           up an account for me?", "Quisiera registrarme
                           como nuevo cliente"). If the caller is not
                           already in the system and wants to become a
                           customer, classify create_customer with high
                           confidence — do NOT fall back to "unknown" just
                           because email/phone or even the name is missing.
                           Extract displayName plus any stated email, phone,
                           or address. A new customer stating their own
                           street address is still create_customer — put the
                           address VERBATIM in "address".
`,
  },
};

/**
 * #887/#896 — per-profile replacement text for an entity-dictionary line
 * (same shape: 4-space indent, no trailing comma). The caller variants trim
 * guidance that only makes sense for intents the caller surface does not
 * advertise (warranty/inspection jobTitle prefixes; add_note/log_permit
 * noteBody rules — a caller's noteBody exists only for the protection
 * section's complaint intent).
 */
export const ENTITY_FIELD_VARIANTS: Partial<
  Record<string, Partial<Record<ClassifierProfile, string>>>
> = {
  jobTitle: {
    caller: `    "jobTitle": "<string, optional — short name of the new job on create_job, or of the new work being scheduled on create_appointment>"`,
  },
  noteBody: {
    caller: `    "noteBody": "<string, optional — the complaint text on complaint>"`,
  },
};

/** Opens the disambiguation section. Emitted only when at least one rule survives gating. */
export const DISTINCTIONS_HEADER = `
Distinctions that matter:
`;

/**
 * Disambiguation rules. `intents` = the intents a rule contrasts; the rule
 * is only worth prompt space when EVERY one of them is advertised on the
 * surface (a rule telling the model to prefer A over B is noise — or worse,
 * a leak — when A or B is not in the list above it).
 */
export const DISTINCTION_RULES: ReadonlyArray<{ intents: readonly IntentType[]; text: string }> = [
  { intents: ['create_invoice', 'draft_estimate', 'update_invoice', 'update_estimate'], text: `- "create an invoice/estimate" vs "add to invoice/estimate" — the word
  "add/remove/update" plus a reference to an EXISTING invoice or estimate
  = update_invoice or update_estimate. Any phrasing starting a NEW one
  = create_invoice or draft_estimate.
` },
  { intents: ['create_invoice', 'issue_invoice', 'send_invoice'], text: `- "send/issue/deliver an invoice" is never create_invoice. Within the pair:
  issue_invoice = make a DRAFT invoice official and payable ("issue",
  "finalize", "make official", "send out the bill" for the first time);
  send_invoice = deliver/redeliver to the customer over a channel ("email
  the invoice", "text it to them", "resend"). When a channel or recipient
  is named, prefer send_invoice; bare "issue/finalize" = issue_invoice.
` },
  { intents: ['create_invoice', 'draft_estimate', 'update_invoice', 'update_estimate'], text: `- Invoice vs estimate — the operator usually says which. When they say
  "invoice" or use an "INV-" prefix, use the invoice intent; when they say
  "estimate/quote" or "EST-", use the estimate intent. When genuinely
  ambiguous, prefer "unknown".
` },
  { intents: ['issue_invoice'], text: `- For issue_invoice, put the invoice number or reference in jobReference.
  If the user says "the one we just drafted" with no explicit ID, omit
  jobReference — the router resolves it from conversation context.
` },
  { intents: ['create_customer', 'update_invoice', 'update_estimate'], text: `- "add customer <name>" = create_customer (CRM record).
  "add a <thing> to <existing invoice/estimate>" = update_invoice/update_estimate.
  When "add" refers to a line item, money, or an existing document, it is
  NOT create_customer even if a customer name appears in the sentence.
` },
  { intents: ['lookup_appointments', 'lookup_my_day'], text: `- "lookup_appointments" vs "lookup_my_day" (spec-review addendum,
  2026-08-09): both can sound like "what's on my schedule" out of context,
  but they answer for DIFFERENT people. lookup_appointments is the
  CUSTOMER asking about a booking THEY are waiting on ("when are y'all
  coming out?", "what time is my appointment?") — the caller is not doing
  the work, they are having work done TO them. lookup_my_day is a
  TECHNICIAN or crew member asking about their OWN day of work to perform
  ("what's my next job?", "where am I going after this one?") — the
  caller IS the one doing the work. When the phrasing gives no other
  signal, a caller asking about "MY appointment" (singular, something
  scheduled for them) is lookup_appointments; a caller asking about "MY
  schedule/day/jobs" (plural work to do) is lookup_my_day.
` },
];

/** JSON contract head, through the opening of extractedEntities. */
export const SCHEMA_HEAD = `
Return valid JSON with exactly this shape (no prose, no markdown fences):
{
  "intentType": "<one of the values above>",
  "confidence": <number between 0 and 1>,
  "reasoning": "<one sentence explaining the classification>",
  "extractedEntities": {
`;

/**
 * The extractedEntities dictionary, one entry per field, in source order.
 * `line` carries NO trailing comma — assembly joins with ',\n' so the last
 * surviving line stays JSON-shaped. `intents` = the intents whose blocks or
 * sections tell the model to extract the field ('*' = generic, kept on every
 * profile); a field is only worth prompt space when at least one of them is
 * advertised on the surface.
 */
export const ENTITY_FIELDS: ReadonlyArray<{ key: string; intents: readonly IntentType[] | '*'; line: string }> = [
  { key: 'customerName', intents: '*', line: `    "customerName": "<string, optional — existing-customer reference on invoice/estimate/appointment>"` },
  { key: 'jobReference', intents: '*', line: `    "jobReference": "<string, optional>"` },
  { key: 'amount', intents: '*', line: `    "amount": <integer cents, optional>` },
  { key: 'dateTimeDescription', intents: '*', line: `    "dateTimeDescription": "<verbatim date/time phrase from transcript, optional>"` },
  { key: 'lineItemDescriptions', intents: ['create_invoice', 'update_invoice', 'draft_estimate', 'update_estimate'], line: `    "lineItemDescriptions": ["<string>", ...]` },
  { key: 'displayName', intents: ['create_customer'], line: `    "displayName": "<string, optional — NEW customer's name on create_customer>"` },
  { key: 'email', intents: ['create_customer'], line: `    "email": "<string, optional — NEW customer's email on create_customer>"` },
  { key: 'phone', intents: ['create_customer'], line: `    "phone": "<string, optional — NEW customer's phone on create_customer>"` },
  { key: 'address', intents: ['create_customer'], line: `    "address": "<string, optional — NEW customer's street address, verbatim, on create_customer>"` },
  { key: 'appointmentReference', intents: ['reschedule_appointment', 'cancel_appointment', 'reassign_appointment', 'confirm_appointment', 'notify_delay'], line: `    "appointmentReference": "<string, optional — existing appointment reference>"` },
  { key: 'newDateTimeDescription', intents: ['reschedule_appointment'], line: `    "newDateTimeDescription": "<string, optional — new time for reschedule_appointment>"` },
  { key: 'targetTechnicianName', intents: ['reassign_appointment', 'lookup_crew_schedule', 'lookup_timesheets'], line: `    "targetTechnicianName": "<string, optional — target technician on reassign_appointment; also the named crew member on lookup_crew_schedule/lookup_timesheets>"` },
  { key: 'cancellationReason', intents: ['cancel_appointment'], line: `    "cancellationReason": "<string, optional — free-text reason on cancel_appointment>"` },
  { key: 'cancellationType', intents: ['cancel_appointment'], line: `    "cancellationType": "<customer_request|technician_unavailable|scheduling_conflict|other, optional>"` },
  { key: 'noteBody', intents: ['add_note', 'log_permit', 'complaint'], line: `    "noteBody": "<string, optional — the note text on add_note; on log_permit, MUST begin "PERMIT: " followed by the permit number/status>"` },
  { key: 'noteTargetKind', intents: ['add_note'], line: `    "noteTargetKind": "<job|customer|invoice|estimate|appointment, optional>"` },
  { key: 'sendChannel', intents: ['send_invoice'], line: `    "sendChannel": "<email|sms, optional — on send_invoice>"` },
  { key: 'paymentMethod', intents: ['record_payment'], line: `    "paymentMethod": "<cash|check|card|other, optional — on record_payment>"` },
  { key: 'paymentReference', intents: ['record_payment'], line: `    "paymentReference": "<string, optional — check number or memo on record_payment>"` },
  { key: 'jobTitle', intents: ['create_job', 'log_warranty_claim', 'create_appointment', 'schedule_inspection'], line: `    "jobTitle": "<string, optional — title of new job on create_job (prefixed "Warranty — " plus what failed on log_warranty_claim); also the short name of the new work being scheduled on create_appointment (prefixed "Inspection — " plus the type on schedule_inspection)>"` },
  { key: 'updatedName', intents: ['update_customer'], line: `    "updatedName": "<string, optional — new name on update_customer>"` },
  { key: 'updatedEmail', intents: ['update_customer'], line: `    "updatedEmail": "<string, optional — new email on update_customer>"` },
  { key: 'updatedPhone', intents: ['update_customer'], line: `    "updatedPhone": "<string, optional — new phone on update_customer>"` },
  { key: 'updatedAddress', intents: ['update_customer'], line: `    "updatedAddress": "<string, optional — new address on update_customer>"` },
  { key: 'expenseDescription', intents: ['log_expense'], line: `    "expenseDescription": "<string, optional — what the expense was for on log_expense>"` },
  { key: 'expenseCategory', intents: ['log_expense'], line: `    "expenseCategory": "<materials|fuel|tools|subcontractor|vehicle|insurance|office|other, optional — on log_expense>"` },
  { key: 'vendor', intents: ['log_expense', 'add_material'], line: `    "vendor": "<string, optional — who was paid on log_expense, or the supply house on add_material>"` },
  { key: 'leadReference', intents: ['convert_lead', 'mark_lead_lost'], line: `    "leadReference": "<string, optional — the lead being converted/lost on convert_lead/mark_lead_lost>"` },
  { key: 'lostReason', intents: ['mark_lead_lost'], line: `    "lostReason": "<string, optional — why the lead was lost on mark_lead_lost>"` },
  { key: 'serviceAddress', intents: ['add_service_location'], line: `    "serviceAddress": "<string, optional — full address on add_service_location>"` },
  { key: 'timeEntryType', intents: ['log_time_entry'], line: `    "timeEntryType": "<job|drive|break|admin, optional — on log_time_entry>"` },
  { key: 'durationMinutes', intents: ['log_time_entry'], line: `    "durationMinutes": <integer MINUTES of completed work time, optional — on log_time_entry; "two hours" is 120>` },
  { key: 'delayMinutes', intents: ['notify_delay'], line: `    "delayMinutes": <integer minutes, optional — on notify_delay>` },
  { key: 'scheduleDescription', intents: ['create_invoice_schedule'], line: `    "scheduleDescription": "<string, optional — VERBATIM milestone sentence on create_invoice_schedule>"` },
  { key: 'reviewReference', intents: ['respond_to_review'], line: `    "reviewReference": "<string, optional — which review, verbatim, on respond_to_review>"` },
  { key: 'instructionText', intents: ['create_standing_instruction'], line: `    "instructionText": "<string, optional — verbatim standing rule on create_standing_instruction>"` },
  { key: 'scopeIntentHint', intents: ['create_standing_instruction'], line: `    "scopeIntentHint": "<string, optional — what work the standing rule applies to>"` },
  { key: 'brandVoiceInstruction', intents: ['update_brand_voice'], line: `    "brandVoiceInstruction": "<string, optional — VERBATIM spoken tone/sign-off/persona instruction on update_brand_voice>"` },
  { key: 'catalogItemReference', intents: ['update_catalog_item'], line: `    "catalogItemReference": "<string, optional — spoken catalog/price-book entry name on update_catalog_item>"` },
  { key: 'unitPriceCents', intents: ['update_catalog_item', 'add_catalog_item'], line: `    "unitPriceCents": <integer cents, optional — the NEW price on update_catalog_item, or the price of the new entry on add_catalog_item>` },
  { key: 'catalogItemNewName', intents: ['update_catalog_item', 'add_catalog_item'], line: `    "catalogItemNewName": "<string, optional — the NEW name on update_catalog_item, or the name of the new entry on add_catalog_item>"` },
  { key: 'catalogItemNewDescription', intents: ['update_catalog_item', 'add_catalog_item'], line: `    "catalogItemNewDescription": "<string, optional — the NEW description on update_catalog_item, or the description of the new entry on add_catalog_item>"` },
  { key: 'catalogItemUnit', intents: ['add_catalog_item'], line: `    "catalogItemUnit": "<each|hour|sq ft|per lb|per gal, optional — unit of measure on add_catalog_item>"` },
  { key: 'refundMethod', intents: ['record_refund'], line: `    "refundMethod": "<cash|check|card_external|other, optional — on record_refund>"` },
  { key: 'refundReason', intents: ['record_refund'], line: `    "refundReason": "<string, optional — why the refund was given on record_refund>"` },
  { key: 'refundCheckNumber', intents: ['record_refund'], line: `    "refundCheckNumber": "<string, optional — check number on record_refund>"` },
  { key: 'creditReason', intents: ['apply_credit'], line: `    "creditReason": "<string, optional — why the credit was given on apply_credit>"` },
  { key: 'customerMessageBody', intents: ['send_customer_message'], line: `    "customerMessageBody": "<string, optional — the message content to send on send_customer_message, cleaned up but faithful>"` },
  { key: 'customerMessageChannel', intents: ['send_customer_message'], line: `    "customerMessageChannel": "<sms|email, optional — on send_customer_message, defaults to sms>"` },
  { key: 'changeOrderDescription', intents: ['create_change_order'], line: `    "changeOrderDescription": "<string, optional — the added work, verbatim, on create_change_order>"` },
  { key: 'serviceAgreementName', intents: ['create_service_agreement'], line: `    "serviceAgreementName": "<string, optional — the plan/membership name on create_service_agreement>"` },
  { key: 'serviceAgreementCadence', intents: ['create_service_agreement'], line: `    "serviceAgreementCadence": "<monthly|quarterly|twice_a_year|annual, optional — recurring cadence on create_service_agreement>"` },
  { key: 'serviceAgreementStartsOn', intents: ['create_service_agreement'], line: `    "serviceAgreementStartsOn": "<string, optional — verbatim spoken start date/phrase on create_service_agreement>"` },
  { key: 'materialDescription', intents: ['add_material'], line: `    "materialDescription": "<string, optional — what to add to the shopping list on add_material>"` },
  { key: 'materialQuantity', intents: ['add_material'], line: `    "materialQuantity": <integer, optional — how many on add_material, defaults to 1>` },
  { key: 'materialNeededBy', intents: ['add_material'], line: `    "materialNeededBy": "<string, optional — verbatim spoken needed-by date/phrase on add_material>"` },
  { key: 'mileageMiles', intents: ['log_mileage'], line: `    "mileageMiles": <number, optional — miles driven on log_mileage; may be fractional>` },
];

/** JSON contract tail — closes extractedEntities and the envelope. */
export const SCHEMA_TAIL = `
  }
}
`;

/** Confidence calibration + the closing no-invention rule. Ends the prompt (no trailing newline). */
export const CALIBRATION = `
Confidence calibration:
- 0.9+ : unambiguous command, key entities extracted
- 0.7-0.9 : clear command, some entities missing but inferable
- 0.5-0.7 : probable command, significant entity gaps
- below 0.5 : ambiguous — prefer "unknown"

Never invent entities. Extract only what the transcript actually says.`;
