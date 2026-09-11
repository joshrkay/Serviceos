# In-app 50-case register — inapp-50-v1

_Generated from `fixtures/voice/inapp-50-cases.json` by `scripts/inapp-50/build-register-doc.mjs` — edit the JSON, not this file._

Fifty in-app operator voice/assistant cases drawn from real usage (PostHog: customer_created 634, job_created 527, estimate_created 432, proposal_approved 275) and support themes: booking, rescheduling, cancellation, status lookup / search, delay notifications, confirmations (incl. duplicate + noisy turns), estimate creation, quote acceptance status, invoice actions, dispatch handoff. Each case carries a severity (critical / core / growth), a cluster, a scripted classifier output (so the hermetic runner exercises the REAL FSM, entity resolver, payload builder and lookup dispatch without an LLM), and a machine-checkable expectation. The same file is loadable by scripts/probe-operator-voice-50-live.mjs (cases[] with id/op/utterance/expectProposal) for live runs against Development/Production.

## Severity map

| Severity | Cases | Rule |
|---|---:|---|
| **critical** | 25 | Blocks the daily operator loop or a customer promise: booking, reschedule, cancel, confirm, delay notice, dispatch/emergency, status + search, and the confirmation/recovery paths that make those deterministic. Release is blocked on ANY critical failure and on ANY critical booking/search case that ends in intent_capture with no proposal or answer. |
| **core** | 22 | Money and CRM loop: estimates, invoices, payments, customers, jobs. Must pass for 50/50 but a failure is a P1, not a release block on its own. |
| **growth** | 3 | Nice-to-have operator conveniences (nudges, change orders, crew add). Must pass for 50/50; failures are P2. |

| Cluster | critical | core | growth | total |
|---|---:|---:|---:|---:|
| Scheduling (booking / reschedule / cancel / confirm / delay) | 10 | 0 | 0 | 10 |
| Search & status lookup | 8 | 2 | 0 | 10 |
| Confirmations & recovery (duplicate / noisy turns) | 5 | 1 | 0 | 6 |
| Estimates & quote acceptance | 0 | 5 | 2 | 7 |
| Invoice actions | 0 | 8 | 0 | 8 |
| Customers & leads | 0 | 3 | 0 | 3 |
| Jobs | 0 | 2 | 0 | 2 |
| Dispatch handoff & emergency | 2 | 1 | 1 | 4 |

## Release gate

1. `PASS === 50/50` on the hermetic run (`npm run inapp-50:run`).
2. No **critical** scheduling / search / confirmations case may end `intent_capture_only` (intent detected, nothing minted or answered).
3. Zero FAIL verdicts (contract violations / exceptions).

`npm run check:inapp-50` evaluates the three rules on `docs/verification-runs/inapp-50/latest.json`.

## The 50 cases

### Scheduling (booking / reschedule / cancel / confirm / delay)

| # | Key | Sev | Intent | Operator says | Must produce | Fixtures / tags |
|---:|---|---|---|---|---|---|
| 1 | `book-01` | critical | `create_appointment` | “Book Garcia for Tuesday at 2 pm for the HVAC install” | `create_appointment` proposal, status `ready_for_review`, payload has `customerId` | customer.garcia, location.garcia |
| 2 | `book-02` | critical | `create_appointment` | “Slot Carlos at Garcia Tuesday two o'clock for the install” | `create_appointment` proposal, status `ready_for_review`, payload has `customerId`, `technicianId` | customer.garcia, technician.carlos |
| 3 | `book-03` | critical | `create_appointment` | “Book Smith furnace maintenance Tuesday at two” | `create_appointment` proposal, status `ready_for_review`, payload has `customerId`, after ONE which-one question | customer.smith-a, customer.smith-b, #ambiguous-name, follow-up: “104 Cedar” |
| 4 | `book-04` | critical | `create_appointment` | “Book a furnace tune-up for Elena Ruiz Thursday at 10 am” | `create_appointment` proposal, payload has `customerName`, gated on `customerId` | #net-new-entity |
| 5 | `book-05` | critical | `create_appointment` | “Book a service visit” → “It's for Khan, Tuesday at 2 pm, condenser install” | `create_appointment` proposal, status `ready_for_review`, payload has `customerId` | customer.khan |
| 6 | `resched-01` | critical | `reschedule_appointment` | “Move Garcia's Tuesday appointment to Thursday at 10 am” | `reschedule_appointment` proposal, status `ready_for_review`, payload has `appointmentId` | appointment.garcia-tuesday, customer.garcia |
| 7 | `cancel-01` | critical | `cancel_appointment` | “Cancel Garcia's Tuesday appointment, the customer asked” | `cancel_appointment` proposal, status `ready_for_review`, payload has `appointmentId` | appointment.garcia-tuesday, customer.garcia |
| 8 | `cancel-02` | critical | `cancel_appointment` | “Cancel the Patel appointment” | honest spoken not-found, no proposal, no on-call page | #seed-gap |
| 9 | `confirm-01` | critical | `confirm_appointment` | “Confirm Garcia for Tuesday” | `confirm_appointment` proposal, status `ready_for_review`, payload has `appointmentId` | appointment.garcia-tuesday, customer.garcia |
| 10 | `delay-01` | critical | `notify_delay` | “Text Garcia that I'm running twenty minutes late” | `notify_delay` proposal, status `ready_for_review`, payload has `appointmentId`, `delayMinutes` | appointment.garcia-tuesday, customer.garcia |

- **book-02** — A named technician on a booking must land as a verified technicianId, not be silently dropped.
- **book-04** — A brand-new customer books NEW work: the proposal must surface with a pending customer reference (gated), never escalate and never approve-to-fail.
- **book-05** — Multi-turn slot fill: the readback is answered with more detail, not a yes/no.
- **cancel-02** — An in-app operator asking about a record that does not exist must hear an honest not-found and stay in control of the session; paging on-call for an operator's own typo is not a recovery path.
- **delay-01** — Operators name the customer, not the appointment. With exactly one upcoming appointment for that customer the delay notice must attach to it without a clarification.

### Search & status lookup

| # | Key | Sev | Intent | Operator says | Must produce | Fixtures / tags |
|---:|---|---|---|---|---|---|
| 13 | `search-01` | critical | `lookup_day_overview` | “What's on my schedule today” | spoken answer from the shared lookup dispatch, no proposal, session stays ready | #read-only |
| 14 | `search-02` | critical | `lookup_appointments` | “When is Garcia's next appointment” | spoken answer from the shared lookup dispatch, no proposal, session stays ready | customer.garcia, appointment.garcia-tuesday, #read-only |
| 15 | `search-03` | critical | `lookup_customer` | “Pull up Khan's customer profile” | spoken answer from the shared lookup dispatch, no proposal, session stays ready | customer.khan, #read-only |
| 16 | `search-04` | critical | `lookup_jobs` | “What's the status of the Johnson water heater job” | spoken answer from the shared lookup dispatch, no proposal, session stays ready | customer.johnson, job.johnson-water-heater, #read-only |
| 17 | `search-05` | critical | `lookup_balance` | “What does Khan owe us” | spoken answer from the shared lookup dispatch, no proposal, session stays ready | customer.khan, #read-only |
| 18 | `search-06` | critical | `lookup_invoices` | “Which invoices are open for Johnson” | spoken answer from the shared lookup dispatch, no proposal, session stays ready | customer.johnson, invoice.johnson, #read-only |
| 19 | `search-07` | critical | `lookup_estimates` | “Did Khan accept the estimate yet” | spoken answer from the shared lookup dispatch, no proposal, session stays ready | customer.khan, estimate.khan, #read-only, #quote-acceptance |
| 20 | `search-08` | critical | `lookup_balance` | “What's Smith's outstanding balance” | spoken which-one question, no proposal, no silent guess | customer.smith-a, customer.smith-b, #read-only, #ambiguous-name |
| 21 | `search-09` | core | `lookup_revenue` | “How much revenue did we do today” | spoken answer from the shared lookup dispatch, no proposal, session stays ready | #read-only, #owner-grade |
| 22 | `search-10` | core | `lookup_customer` | “Pull up the Patel account” | honest spoken not-found, no proposal, no on-call page | #read-only, #seed-gap |

- **search-07** — Quote acceptance is a customer act on the public approval page; the operator's in-app need is the STATUS of that acceptance.
- **search-08** — Two Smiths: the only correct answer is a which-one question — never a silent guess, never a clarification card.

### Confirmations & recovery (duplicate / noisy turns)

| # | Key | Sev | Intent | Operator says | Must produce | Fixtures / tags |
|---:|---|---|---|---|---|---|
| 23 | `conf-01` | critical | `create_appointment` | “Book Garcia for Tuesday at 2 pm for the HVAC install” → “uh yeah, go ahead” | `create_appointment` proposal, payload has `customerId`, exactly 1 proposal(s) | customer.garcia, #noisy-affirmation |
| 24 | `conf-02` | critical | `create_appointment` | “Book Garcia for Tuesday at 2 pm for the HVAC install” → “yes” → “yes” | `create_appointment` proposal, exactly 1 proposal(s) | customer.garcia, #duplicate-turn |
| 25 | `conf-03` | critical | `create_appointment` | “Book Garcia for Tuesday at 2 pm for the HVAC install” → “Book Garcia for Tuesday at 2 pm for the HVAC install” → “yes” | `create_appointment` proposal, payload has `customerId`, exactly 1 proposal(s) | customer.garcia, #duplicate-turn |
| 26 | `conf-04` | critical | `create_appointment` | “Book Garcia for Tuesday at 2 pm for the HVAC install” → “no” → “Book Garcia for Thursday at 10 am for the HVAC install” | `create_appointment` proposal, payload has `customerId`, exactly 1 proposal(s) | customer.garcia, #correction |
| 27 | `noise-01` | critical | `create_appointment` | “um... hello?” → “Book Garcia for Tuesday at 2 pm for the HVAC install” | `create_appointment` proposal, exactly 1 proposal(s) | customer.garcia, #noisy-input |
| 28 | `noise-02` | core | `confirm` | “yes” | deterministic guard line (nothing pending), no proposal | #confirm-without-pending |

- **conf-01** — A noisy but unmistakable yes ("uh yeah, go ahead") must commit the readback, not restart the capture.
- **conf-02** — A duplicated confirm (client retry / double tap) must not mint a second proposal and must not escalate.
- **conf-03** — The same sentence submitted twice (double-submit / echo) must keep the readback pending with its slots intact, then commit once on yes.
- **conf-04** — A rejected readback followed by the corrected request must produce exactly one proposal carrying the corrected slot.
- **noise-01** — Filler / mic-check noise gets one gentle reprompt (no LLM needed, no escalation); the next real request proceeds normally. LLM entries are keyed by `for` (utterance substring), so the filler entry is simply never consumed when the deterministic noise filter answers turn 1.

### Estimates & quote acceptance

| # | Key | Sev | Intent | Operator says | Must produce | Fixtures / tags |
|---:|---|---|---|---|---|---|
| 29 | `est-01` | core | `draft_estimate` | “Quote Khan for a three-ton condenser replacement” | `draft_estimate` proposal, payload has `customerId` | customer.khan, catalog.condenser-3ton |
| 30 | `est-02` | core | `draft_estimate` | “Prepare an estimate for Johnson's water heater job” | `draft_estimate` proposal, payload has `customerId`, `jobId` | customer.johnson, job.johnson-water-heater, catalog.water-heater |
| 31 | `est-03` | core | `update_estimate` | “Add duct sealing to Khan's estimate” | `update_estimate` proposal, payload has `estimateId` | customer.khan, estimate.khan, catalog.duct-sealing |
| 32 | `est-04` | core | `update_estimate` | “Add a fifty dollar service call fee to EST-0001” | `update_estimate` proposal, payload has `estimateId` | estimate.khan, catalog.service-call-fee |
| 33 | `est-05` | core | `send_estimate` | “Send EST-0042 to Garcia by email” | `send_estimate` proposal, status `ready_for_review`, payload has `estimateId` | estimate.explicit-0042, customer.garcia |
| 34 | `est-06` | growth | `send_estimate_nudge` | “Nudge Khan about the pending estimate” | `send_estimate_nudge` proposal, payload has `customerId` | customer.khan, estimate.khan |
| 35 | `est-07` | growth | `create_change_order` | “Khan approved the extra duct work, add a change order to the Khan install job” | `create_change_order` proposal, payload has `jobId` | customer.khan, job.khan-install |

### Invoice actions

| # | Key | Sev | Intent | Operator says | Must produce | Fixtures / tags |
|---:|---|---|---|---|---|---|
| 36 | `inv-01` | core | `create_invoice` | “Invoice Johnson four hundred fifty for the capacitor work” | `draft_invoice` proposal, payload has `customerId` | customer.johnson |
| 37 | `inv-02` | core | `create_invoice` | “Bill Mrs Lee two eighty-five for the service visit” | `draft_invoice` proposal, payload has `customerId` | customer.mrs-lee |
| 38 | `inv-03` | core | `update_invoice` | “Add a twenty-five dollar trip fee to INV-0042” | `update_invoice` proposal, payload has `invoiceId` | invoice.johnson |
| 39 | `inv-04` | core | `send_invoice` | “Email invoice INV-0042 to Johnson” | `send_invoice` proposal, status `ready_for_review`, payload has `invoiceId` | invoice.johnson, customer.johnson |
| 40 | `inv-05` | core | `send_invoice` | “Text Smith the invoice link” | `send_invoice` proposal, payload has `customerId`, after ONE which-one question | customer.smith-a, customer.smith-b, invoice.smith-a, #ambiguous-name, follow-up: “104 Cedar” |
| 41 | `inv-06` | core | `issue_invoice` | “Issue Garcia's invoice” | `issue_invoice` proposal, payload has `invoiceId` | customer.garcia, invoice.garcia |
| 42 | `inv-07` | core | `record_payment` | “Record a four fifty cash payment on INV-0042” | `record_payment` proposal, payload has `invoiceId` | invoice.johnson |
| 43 | `inv-08` | core | `send_payment_reminder` | “Send Johnson a reminder on the overdue invoice” | `send_payment_reminder` proposal, payload has `invoiceId` | customer.johnson, invoice.johnson |

- **inv-08** — Johnson has exactly one open invoice; the reminder must attach to it, not stall on a free-text reference.

### Customers & leads

| # | Key | Sev | Intent | Operator says | Must produce | Fixtures / tags |
|---:|---|---|---|---|---|---|
| 44 | `cust-01` | core | `create_customer` | “New customer Elena Ruiz, phone 480-555-7711” | `create_customer` proposal, status `ready_for_review`, payload has `name` | #net-new-entity |
| 45 | `cust-02` | core | `update_customer` | “Update Khan's email to accounts@khan.test” | `update_customer` proposal, status `ready_for_review`, payload has `customerId`, `email` | customer.khan |
| 46 | `cust-03` | core | `convert_lead` | “Convert the Greenfield lead into a customer” | `convert_lead` proposal, payload has `leadId` | lead.greenfield |

### Jobs

| # | Key | Sev | Intent | Operator says | Must produce | Fixtures / tags |
|---:|---|---|---|---|---|---|
| 47 | `job-01` | core | `create_job` | “Open a job for Khan, kitchen drain clog” | `create_job` proposal, status `ready_for_review`, payload has `customerId`, `title` | customer.khan |
| 48 | `job-02` | core | `update_job` | “Set Johnson's water heater job to in progress” | `update_job` proposal, payload has `jobId` | customer.johnson, job.johnson-water-heater |

### Dispatch handoff & emergency

| # | Key | Sev | Intent | Operator says | Must produce | Fixtures / tags |
|---:|---|---|---|---|---|---|
| 11 | `reassign-01` | critical | `reassign_appointment` | “Hand Garcia's Tuesday visit to Carlos” | `reassign_appointment` proposal, status `ready_for_review`, payload has `appointmentId`, `technicianId` | appointment.garcia-tuesday, technician.carlos, customer.garcia |
| 12 | `dispatch-03` | core | `en_route` | “On my way to the Khan install” | audited direct act (en-route) with spoken confirmation, no proposal | appointment.khan-today, customer.khan, job.khan-install |
| 49 | `dispatch-01` | critical | `emergency_dispatch` | “No heat at the Hayes house, this is an emergency, page on-call now” | immediate escalation with on-call notification | #emergency, #seed-gap |
| 50 | `dispatch-02` | growth | `add_crew_member` | “Add Carlos to the Garcia Tuesday job as a helper” | `add_crew_member` proposal, payload has `appointmentId`, `technicianId` | appointment.garcia-tuesday, technician.carlos, customer.garcia |

- **dispatch-03** — "On my way" is a direct, audited status act on every other surface (chat, phone, memo). In-app must fire the same act, not mint a dead clarification card.

## Themes → cases

| Theme | Cases |
|---|---|
| Booking | `book-01`, `book-02`, `book-03`, `book-04`, `book-05` |
| Rescheduling | `resched-01` |
| Cancellation | `cancel-01`, `cancel-02` |
| Status lookup / search | `search-01`, `search-02`, `search-03`, `search-04`, `search-05`, `search-06`, `search-07`, `search-08`, `search-09`, `search-10` |
| Delay notifications | `delay-01` |
| Confirmations & recovery | `confirm-01`, `conf-01`, `conf-02`, `conf-03`, `conf-04`, `noise-01`, `noise-02` |
| Estimate creation | `est-01`, `est-02`, `est-03`, `est-04` |
| Quote acceptance | `search-07`, `est-05`, `est-06`, `est-07` |
| Invoice actions | `inv-01`, `inv-02`, `inv-03`, `inv-04`, `inv-05`, `inv-06`, `inv-07`, `inv-08` |
| Dispatch handoff | `reassign-01`, `dispatch-01`, `dispatch-02`, `dispatch-03` |
| Customers / jobs | `cust-01`, `cust-02`, `cust-03`, `job-01`, `job-02` |

**Quote acceptance note.** Acceptance itself is a customer act on the public approval page (`/e/:id`); the operator-side in-app need is the *status* of that acceptance (`search-07`), plus sending (`est-05`), nudging (`est-06`) and recording approved scope changes (`est-07`). There is no `accept_estimate` voice intent on any surface (62-op registry rows 22/23 have no on-ramp); adding one is a follow-up, not a release blocker.

## Harness seeds

Tenant timezone `America/Phoenix`; fixture catalog `fixtures/voice/operator-voice-fixture-catalog.json`; catalog items: 3-ton condenser replacement ($3250.00), Duct sealing ($450.00), Service call fee ($50.00), Water heater replacement ($1850.00), AC diagnostic fee ($79.00). Alvarez / Patel / Hayes / Jones are deliberately NOT seeded (seed-gap negatives). The two Smith customers (104 vs 105 QA Cedar Avenue) are the ambiguity fixture.
