# Beta Verification Runbook — Manual Checklist

> **Purpose:** Prove that every shipped feature works end-to-end in a live environment before
> a beta customer is onboarded. This is not a code review — it is a human running through
> real actions against a deployed staging or production instance and confirming each result.
>
> **When to run:** Before each new beta customer onboard, and after any deploy touching
> more than one package.
>
> **How to record:** Copy this file, rename it `beta-verification-YYYY-MM-DD.md`, fill in
> every checkbox, and commit to `docs/verification-runs/`.
>
> **Sequence matters:** Sections 1–6 build on each other. Create the test data in order and
> reference it throughout. Do not skip ahead.

---

## Pre-conditions

- [ ] Staging URL confirmed reachable: `___________________________`
- [ ] Test Clerk account ready (not a real customer)
- [ ] Stripe is in **test mode** — verify the orange "Test mode" badge in the Stripe dashboard
- [ ] Real phone number available to receive SMS (not a VoIP number)
- [ ] Real email inbox available to receive test messages
- [ ] Twilio test number provisioned for this environment: `___________________________`
- [ ] `GET /health` → `{ "status": "ok" }` — **hard stop if this fails**
- [ ] `GET /ready` → `200` — **hard stop if this fails**
- [ ] Deploy SHA being tested: `___________________________`

**Tester:** ___________________________
**Date / Time:** ___________________________
**Environment:** ☐ Staging &nbsp; ☐ Production

---

## Section 1 — Auth & Tenant Bootstrap

Every other section depends on this. A failure here is a hard stop.

- [ ] **1.1** Go to `/signup`. Page loads with Fieldly branding, no console errors.
- [ ] **1.2** Sign up with a fresh test email. Clerk flow completes — no error screen.
- [ ] **1.3** After signup, the app lands on `/onboarding` or `/dashboard`. Not a blank screen.
- [ ] **1.4** Open DevTools → Network. Find the `/api/me` or session call. Response body includes a `tenantId` field. **This proves the Clerk webhook fired and Postgres provisioned the tenant.**
- [ ] **1.5** Hard-reload the page (`Cmd+Shift+R`). You remain logged in — session survived a reload.
- [ ] **1.6** Log out. Browser lands on `/login`.
- [ ] **1.7** Navigate directly to `/customers` while logged out. Browser redirects to `/login` — the protected route gate works.
- [ ] **1.8** Log back in with the same account. You land in the app, not on signup.

**Record tenant ID here for use throughout this runbook:** `___________________________`

**Notes:** _______________________________________________________________

---

## Section 2 — Customer Profile & Service Locations

Build the test customer you will use for the entire lead-to-cash sequence.

### 2A — Create the customer

- [ ] **2.1** Navigate to `/customers` → New customer.
- [ ] **2.2** Fill in: first name, last name, primary phone (real number), email (real inbox), preferred notification channel = SMS.
- [ ] **2.3** Add a **primary service location**: street address, city, state, zip. This is the location jobs and estimates will be attached to.
- [ ] **2.4** Save. Customer appears in the list immediately.
- [ ] **2.5** Open the customer detail. All fields (name, phone, email, location) display correctly.

**Record customer ID:** `___________________________`
**Record location ID:** `___________________________`

### 2B — Multiple service locations

- [ ] **2.6** On the customer detail, add a **second service location** (a different address — a rental property, second location, etc.). Save.
- [ ] **2.7** Both locations now appear on the customer profile. The primary address is labeled correctly.
- [ ] **2.8** Verify that when creating a job in Section 4, you can choose which location the job is at — and the correct one is selected.

### 2C — Customer notes

- [ ] **2.9** On the customer detail, add a note: "Prefers afternoon appointments. Gate code is 1234." Save.
- [ ] **2.10** Reload the customer detail. The note persists.
- [ ] **2.11** Edit the note, append " Dog in backyard." Save. The updated note text is shown.
- [ ] **2.12** When you navigate to a job for this customer in Section 4, the customer notes are visible on the job page (not buried — should surface without drilling).

### 2D — Customer history (validate as you progress through this runbook)

Return here after completing Sections 4–6 and verify:

- [ ] **2.13** Customer detail shows the job created in Section 4 in the job history.
- [ ] **2.14** Customer detail shows the estimate created in Section 5 in the estimate history.
- [ ] **2.15** Customer detail shows the invoice created in Section 6 in the invoice history.
- [ ] **2.16** All three records link back to the **same service location** — not a blank or mismatched location.

### 2E — Edit & archive

- [ ] **2.17** Edit the customer's phone number. Save. Detail page immediately shows the updated number.
- [ ] **2.18** Search for the customer by last name. They appear in results.
- [ ] **2.19** Archive the customer. They disappear from the active list.
- [ ] **2.20** Restore or recreate the customer for the rest of this runbook.

**Notes:** _______________________________________________________________

---

## Section 3 — Lead Pipeline & Conversion

### 3A — Manual lead creation

- [ ] **3.1** Navigate to `/leads` → New lead.
- [ ] **3.2** Enter name, phone, service type (e.g., "AC not cooling"), source = "Phone call." Save.
- [ ] **3.3** Lead appears in the lead list with correct status.
- [ ] **3.4** Open the lead detail. Add a note: "Called during heat wave, urgent." Note saves.

### 3B — Intake form lead

- [ ] **3.5** Open `/intake` in a fresh incognito window (unauthenticated).
- [ ] **3.6** Complete the multi-step form: select a service type, fill in contact info, describe the problem. Submit.
- [ ] **3.7** Back in the app at `/leads`, the intake submission appears as a new lead. Name, phone, and problem description carried over correctly.
- [ ] **3.8** The lead is tagged with source = "Intake form" (or equivalent), not blank.

### 3C — Lead-to-customer conversion

- [ ] **3.9** Open one of the leads from 3A or 3B. Click "Convert to customer."
- [ ] **3.10** Conversion creates a new customer record. All contact info from the lead (name, phone, email) carried over — you should not have to re-enter it.
- [ ] **3.11** Navigate to the new customer's detail page. The lead is visible in the customer's activity or history, proving the conversion link is preserved — not just a copy.
- [ ] **3.12** The original lead record in `/leads` shows status "Converted" (or equivalent). It does not disappear — it becomes read-only history.

**Notes:** _______________________________________________________________

---

## Section 4 — Jobs

Use the customer from Section 2 for all job checks.

### 4A — Create & assign

- [ ] **4.1** Navigate to `/jobs/new`.
- [ ] **4.2** Select the Section 2 customer. The customer's service locations appear in a dropdown. Select the **primary** location — not the second one.
- [ ] **4.3** Add a job description: "Annual AC tune-up." Set status to Draft.
- [ ] **4.4** Save. Job appears in the `/jobs` list.
- [ ] **4.5** Open the job detail. Confirm: customer name is linked (clickable back to customer), service location matches the primary address from Section 2.
- [ ] **4.6** Verify the customer note from **2.9** ("Prefers afternoon appointments...") is visible on the job detail page without navigating away.

### 4B — Job lifecycle

- [ ] **4.7** Change job status: Draft → Scheduled. Status badge updates immediately.
- [ ] **4.8** Change job status: Scheduled → In Progress. Status badge updates.
- [ ] **4.9** Change job status: In Progress → Completed. Status badge updates.
- [ ] **4.10** Navigate back to `/jobs`. The job shows the correct final status in the list view.

### 4C — Time tracking

- [ ] **4.11** On the job detail, add a time entry: start time = 9:00am, end time = 11:30am. Save.
- [ ] **4.12** The time entry appears on the job detail. Duration calculates correctly (2h 30m).
- [ ] **4.13** Add a second time entry for travel. Both entries are listed and the total hours are summed.

### 4D — Job photos

- [ ] **4.14** Upload a photo on the job detail (before photo of the equipment). Upload completes.
- [ ] **4.15** The photo renders on the job page — not a broken image link.
- [ ] **4.16** Upload a second photo (after photo). Both photos are visible and labeled.

### 4E — Job notes

- [ ] **4.17** Add a note on the job detail: "Replaced capacitor and cleaned coils. System back to spec." Save.
- [ ] **4.18** The note persists on reload.
- [ ] **4.19** The note is visible in the customer's activity history at `/customers/:id`.

**Record job ID:** `___________________________`

**Notes:** _______________________________________________________________

---

## Section 5 — Estimates

Use the customer and job from Sections 2 and 4.

### 5A — Create with AI assist

- [ ] **5.1** Navigate to `/estimates/new`.
- [ ] **5.2** Link to the Section 2 customer and Section 4 job. Confirm the service location auto-populates as the primary address — not blank, not the second location.
- [ ] **5.3** Add one line item manually: description = "Capacitor replacement", qty = 1, unit price = $95.00. Total shows $95.00. No floating point artifacts (not $94.9999 or $95.0001).
- [ ] **5.4** Trigger AI line-item suggestions. Suggestions appear within 15 seconds.
- [ ] **5.5** Accept one AI suggestion (e.g., "Labor – 2hrs"). It is appended to the line items.
- [ ] **5.6** Verify the estimate total updates correctly after adding the AI suggestion.
- [ ] **5.7** Save. Estimate status = "draft."

**Record estimate ID:** `___________________________`

### 5B — Send & approve

- [ ] **5.8** Click Send. Choose channel = SMS. Send succeeds.
- [ ] **5.9** The customer's real phone (from Section 2) receives an SMS within 60 seconds. The message includes the business name and a link starting with `/e/`.
- [ ] **5.10** The estimate's status in the app changes to "sent." The sent timestamp appears.
- [ ] **5.11** A dispatch record exists (check `/interactions` or the estimate detail) confirming the SMS was delivered — not just "attempted."
- [ ] **5.12** Open the approval link from the SMS in a **fresh incognito window** (unauthenticated).
- [ ] **5.13** The estimate approval page renders. Customer can see: business name, line items, total, and service address.
- [ ] **5.14** The service address on the approval page matches the **primary location** from Section 2 — not a generic address or blank.
- [ ] **5.15** Click "Approve" on the public page.
- [ ] **5.16** Back in the app, the estimate status is now "approved." This update happens without a manual refresh — the app reflects the webhook or polling result.

### 5C — Estimate notes

- [ ] **5.17** Add a note to the estimate: "Customer approved over phone first, then via link." Save.
- [ ] **5.18** Note persists on reload and is visible in the estimate detail.

**Notes:** _______________________________________________________________

---

## Section 6 — Invoices & Payment

Use the approved estimate from Section 5.

### 6A — Create invoice from estimate

- [ ] **6.1** Navigate to `/invoices/new`. Create the invoice from the Section 5 estimate.
- [ ] **6.2** Invoice inherits all line items. Totals match the estimate exactly (same cent values).
- [ ] **6.3** The invoice is linked to the same customer, job, and service location as the estimate.
- [ ] **6.4** Save. Status = "draft."

**Record invoice ID:** `___________________________`

### 6B — Reverse navigation — full chain

Before sending the invoice, verify the entire data trail is navigable in both directions:

- [ ] **6.5** From the **invoice detail**, there is a link or reference to the **originating estimate**. Click it. You land on the Section 5 estimate.
- [ ] **6.6** From the **estimate detail**, there is a link to the **job**. Click it. You land on the Section 4 job.
- [ ] **6.7** From the **job detail**, there is a link to the **customer**. Click it. You land on the Section 2 customer.
- [ ] **6.8** From the **customer detail**, you can see all three records (job, estimate, invoice) in their respective history sections.
- [ ] **6.9** The **service location** shown on the invoice matches the one on the estimate, which matches the one on the job, which matches the primary address on the customer. All four documents reference the same location — no mismatch.

### 6C — Send & pay

- [ ] **6.10** Click Send on the invoice. Choose channel = Email. Send succeeds.
- [ ] **6.11** The customer's real email receives the invoice email within 2 minutes. The email contains the business name, invoice total, due date, and a payment link.
- [ ] **6.12** A Stripe payment link was generated and is visible on the invoice detail.
- [ ] **6.13** Open the payment link (`/pay/:token`) in a **fresh incognito window**.
- [ ] **6.14** The payment page renders with: business name, line items, total amount, due date, service address.
- [ ] **6.15** Complete payment using Stripe test card `4242 4242 4242 4242`, any future expiry, any CVC.
- [ ] **6.16** After payment, the page shows a confirmation — not an error screen.
- [ ] **6.17** Back in the app, wait up to 60 seconds. The invoice status changes to "paid" automatically (Stripe webhook fired and was processed).
- [ ] **6.18** The paid amount on the invoice equals the invoice total exactly — no rounding error, no $0.01 discrepancy.
- [ ] **6.19** A payment record appears on the invoice detail showing: amount, date, last 4 digits of card.

### 6D — Invoice notes

- [ ] **6.20** Add a note to the invoice: "Paid by homeowner, not tenant." Note persists on reload.

**Notes:** _______________________________________________________________

---

## Section 7 — Appointments & Scheduling

### 7A — Create appointments

- [ ] **7.1** Navigate to `/schedule`. Calendar loads showing the current week.
- [ ] **7.2** Create Appointment A: link to the Section 2 customer and Section 4 job. Set date = tomorrow, time = 10:00am–12:00pm. Assign to Technician 1.
- [ ] **7.3** Appointment A appears on the calendar at the correct slot.
- [ ] **7.4** The appointment card shows the customer name, job description, and assigned technician.
- [ ] **7.5** Click the appointment. Detail view shows the service address from Section 2 — not blank.
- [ ] **7.6** Create Appointment B: same technician, same day, time = 11:00am–1:00pm (overlaps A by 1 hour).
- [ ] **7.7** A conflict indicator (badge, color, icon) appears on both Appointment A and Appointment B.

### 7B — Reschedule & move

- [ ] **7.8** Drag Appointment B to 2:00pm–4:00pm on the same day. The appointment moves.
- [ ] **7.9** The conflict indicator clears on both A and B after the drag.
- [ ] **7.10** Change Appointment A's time via the edit form (not drag) to 9:00am–11:00am. Save. Calendar reflects the new time.
- [ ] **7.11** Reassign Appointment A to Technician 2 via the edit form. Save. The appointment moves to Technician 2's lane on the dispatch board.

### 7C — Appointment confirmation notification

- [ ] **7.12** When Appointment A was created in 7.2, a confirmation SMS was sent to the customer's phone (or check if `autoSendAppointmentReminders` is enabled in settings — if disabled, toggle it on and resend).
- [ ] **7.13** The SMS reads naturally: includes business name, date, time, and technician name. Not a generic template with unfilled `{{placeholders}}`.

### 7D — Delay notification

- [ ] **7.14** Simulate a technician running late: open the delay notification trigger (this may be an internal API call or a dispatcher action — check the dispatch board for a "Mark as late" or "Notify delay" button on the appointment).
- [ ] **7.15** Select a 20-minute delay. Confirm the action.
- [ ] **7.16** The **next** customer in that technician's schedule (not the current one) receives an SMS within 2 minutes. The message text reads naturally: "Hi [name], thanks for your patience — [tech name] is running about 20 minutes late."
- [ ] **7.17** The delay notification is recorded in `/interactions` with the correct customer, technician, and timestamp.
- [ ] **7.18** Triggering the same delay notice again within 1 minute does **not** send a duplicate SMS (idempotency check).

**Notes:** _______________________________________________________________

---

## Section 8 — Dispatch Board

### 8A — Board layout & assignment

- [ ] **8.1** Navigate to the dispatch board.
- [ ] **8.2** The board shows technician lanes for today. Each lane shows the technician's name and assigned appointment count.
- [ ] **8.3** Unassigned appointments appear in the unassigned queue on the left or top.
- [ ] **8.4** Drag an unassigned appointment into a technician's lane. The appointment moves and the unassigned count decrements.
- [ ] **8.5** Drag an appointment from Technician 1's lane to Technician 2's lane. The reassignment saves.
- [ ] **8.6** Open the same dispatch board in a **second browser tab**. The drag-and-drop change from 8.5 is visible in the second tab within a few seconds — no manual refresh needed.
- [ ] **8.7** Conflict badges render on appointments with time overlap within the same technician's lane.

### 8B — Technician location (GPS data)

> The API stores location pings; verify data is flowing. A visual map on the
> dispatch board is a future milestone — do not mark this section as failing
> if there is no map UI, but do confirm the data pipeline is working.

- [ ] **8.8** From the Technician Day View (`/technician/day`), confirm the technician's device can submit a location ping. Open the page on a mobile device or browser with location permissions. Allow location access.
- [ ] **8.9** Trigger a location update (this may be automatic on page load or require an explicit action). No error is shown.
- [ ] **8.10** Verify the ping was stored: call `GET /api/technician-location` (or check the interactions/telemetry log) and confirm a record exists with lat/lng, accuracy, and timestamp within the last 2 minutes.

### 8C — Dispatch analytics

- [ ] **8.11** After completing 8A–8B, navigate to the reports section or dispatch analytics. At least one dispatch event (assignment, delay notice) appears in the analytics data for today.

**Notes:** _______________________________________________________________

---

## Section 9 — Notifications & Communications

### 9A — Estimate & invoice delivery audit

- [ ] **9.1** Navigate to `/interactions`. The SMS sent in Section 5.9 appears as a sent dispatch record with: recipient phone, timestamp, provider message ID.
- [ ] **9.2** The email sent in Section 6.11 appears as a separate dispatch record with: recipient email, timestamp, provider message ID.
- [ ] **9.3** Both records show status = "sent" — not "pending" or "failed."
- [ ] **9.4** Attempt to send the same estimate SMS a second time within 1 minute. Confirm the system does **not** create a duplicate dispatch to the same recipient (idempotency window is ~1 minute by design). After 2+ minutes, a resend should succeed as a new dispatch.

### 9B — Communication history on customer profile

- [ ] **9.5** Open the Section 2 customer detail. A communication history (or recent activity) section shows all SMS and email sends associated with this customer.
- [ ] **9.6** The estimate SMS, invoice email, and appointment confirmation are all listed with their timestamps.
- [ ] **9.7** Each entry is clickable and links to the related estimate, invoice, or appointment.

**Notes:** _______________________________________________________________

---

## Section 10 — Customer-Facing Portal & Public Pages

### 10A — Estimate approval (public)

- [ ] **10.1** Open the estimate approval link from Section 5.9 in an incognito window.
- [ ] **10.2** Approval page renders: business name, customer name, line items, total, service address.
- [ ] **10.3** "Approve" and "Reject" buttons are visible. Clicking "Approve" flips the status in the app (validated in Section 5.15–5.16).
- [ ] **10.4** After approval, attempting to open the same link again shows a confirmation / read-only view — it does not allow re-approval.

### 10B — Invoice payment (public)

- [ ] **10.5** Open the invoice payment link from Section 6.11 in an incognito window.
- [ ] **10.6** Payment page renders: business name, line items, total, due date, service address.
- [ ] **10.7** After the Stripe payment in Section 6.15, opening the link again shows "Paid" status — not an active payment form. Customer cannot accidentally double-pay.

### 10C — Customer portal

- [ ] **10.8** If a portal token exists for the Section 2 customer, open `/portal/:token` in an incognito window.
- [ ] **10.9** Portal shows the customer's jobs, estimates, and invoices. Data matches what is in the app.
- [ ] **10.10** Customer can click into the invoice detail from the portal and see payment status.

### 10D — Intake form

- [ ] **10.11** Open `/intake` in an incognito window. Multi-step form loads.
- [ ] **10.12** Select a service type. Vertical-specific fields appear (e.g., for HVAC: equipment type, system age, symptom).
- [ ] **10.13** Complete and submit the form. Back in the app, a new lead appears in `/leads` within 30 seconds.

### 10E — Feedback form

- [ ] **10.14** After the estimate approval in 10.3, if a feedback link was generated, open it in an incognito window.
- [ ] **10.15** Feedback form renders. Submit a rating and comment.
- [ ] **10.16** In the app, navigate to Settings → Feedback & reviews. The submitted feedback appears with the correct rating, comment, and customer name.

**Notes:** _______________________________________________________________

---

## Section 11 — AI Assistant

- [ ] **11.1** Navigate to `/assistant`. Chat interface loads.
- [ ] **11.2** Ask: "Show me [customer last name from Section 2]'s open work." Response references the actual job and estimate from this runbook by name/number within 15 seconds.
- [ ] **11.3** Ask: "What's the total of estimate [number from Section 5]?" Response gives the correct dollar amount.
- [ ] **11.4** Ask: "Schedule a follow-up for [customer name] next Tuesday at 2pm." Response drafts a proposal or confirms the action — does not hallucinate a confirmation it didn't actually do.
- [ ] **11.5** Reload the page. Conversation history persists — prior messages are visible.
- [ ] **11.6** Open the same assistant in a second tab with the conversation ID in the URL. Both tabs show the same conversation history.
- [ ] **11.7** Record a voice note via the microphone button. Upload completes. Transcription appears in the chat within 30 seconds.
- [ ] **11.8** The transcribed text is accurate enough to be usable (not garbled beyond recognition).

**Notes:** _______________________________________________________________

---

## Section 12 — Technician Mobile View

- [ ] **12.1** Navigate to `/technician/day`. Today's assigned jobs load.
- [ ] **12.2** The appointment from Section 7 appears if today is the appointment day. If not, navigate to the correct date.
- [ ] **12.3** Tap a job. Job detail loads with: customer name, service address, job description, and customer notes ("Prefers afternoon appointments..." from Section 2).
- [ ] **12.4** Record a voice update using the voice/mic button. Transcription appears as a note on the job within 30 seconds.
- [ ] **12.5** The voice note is visible in the main app at `/jobs/:id` — not just in the technician view.
- [ ] **12.6** Change job status to "On site" or "In progress" from the technician view. The status update is reflected immediately in the main dispatch board.

**Notes:** _______________________________________________________________

---

## Section 13 — Maintenance Contracts

- [ ] **13.1** Navigate to `/contracts` → New contract.
- [ ] **13.2** Link to the Section 2 customer and primary service location. Set a plan type and renewal date.
- [ ] **13.3** Save. Contract appears in the list with correct status.
- [ ] **13.4** Open the contract detail. Customer name, location, and plan details all display correctly.
- [ ] **13.5** Navigate to the Section 2 customer detail. The active contract is visible in the customer's profile.
- [ ] **13.6** When creating a new estimate for this customer in a fresh session, the AI assistant (or estimate context) acknowledges the active maintenance contract — e.g., service call fee is waived, or a plan-specific line item is suggested.

**Notes:** _______________________________________________________________

---

## Section 14 — Vertical Packs & Settings

### 14A — Core settings persistence

- [ ] **14.1** Navigate to `/settings` → Business Profile. Edit the company name. Save.
- [ ] **14.2** Hard-reload. The updated company name persists.
- [ ] **14.3** The updated company name appears in the next estimate approval email/SMS sent — not the old name or a placeholder.
- [ ] **14.4** Open Terminology sheet. Change a term (e.g., "Technician" → "Specialist"). Save.
- [ ] **14.5** Navigate to the dispatch board. The label for the assigned person uses the new term.
- [ ] **14.6** Open AI Approval Rules sheet. Set auto-approve threshold. Save. Reload — value persists.
- [ ] **14.7** Open Deposit Rules sheet. Set a deposit requirement. Save. Reload — value persists.

### 14B — Vertical pack switching

- [ ] **14.8** In Settings, activate the Plumbing pack (if HVAC is the default).
- [ ] **14.9** Navigate to `/jobs/new`. Plumbing-specific service types are now available in the service type dropdown (e.g., "Water heater replacement," "Drain cleaning").
- [ ] **14.10** Navigate to `/intake`. The intake form now offers Plumbing as a service type option.
- [ ] **14.11** Deactivate Plumbing. Plumbing service types are no longer offered.

### 14C — Templates & price book

- [ ] **14.12** Navigate to `/settings/templates`. At least one template exists.
- [ ] **14.13** Edit a template — change a default line item description. Save. The change is reflected when creating a new estimate using that template.
- [ ] **14.14** Navigate to `/settings/price-book`. At least one price book item exists. Edit an item price. Save. When adding that item to a new estimate, the updated price pre-fills.

### 14D — Language

- [ ] **14.15** Navigate to `/settings/language`. Switch interface language to Spanish.
- [ ] **14.16** Core navigation labels change to Spanish. Navigate back to `/settings/language` and switch back to English.

**Notes:** _______________________________________________________________

---

## Section 15 — Calling Agent

> Tests the Gather fallback path (always available). The Deepgram + ElevenLabs
> streaming path has its own load-test runbook at
> `docs/superpowers/runbooks/voice-quality-launch-gate.md`.

- [ ] **15.1** Call the Twilio test number for this environment. Call connects — not dead air, not a busy signal.
- [ ] **15.2** The agent greets the caller using the business name from Section 14A (not a hardcoded name, not a blank greeting).
- [ ] **15.3** Say "I need to schedule an AC repair." Agent recognizes the intent and asks a follow-up — not a generic "I didn't understand."
- [ ] **15.4** Provide the name of the Section 2 customer. Agent acknowledges the customer by name and references their account (e.g., "I can see you're at [address]").
- [ ] **15.5** Ask "What's the status of my estimate?" Agent reads back the estimate number and total from Section 5.
- [ ] **15.6** Ask "I'd like to pay my invoice." Agent provides the payment link or a path to pay.
- [ ] **15.7** Say "My furnace is out and it's freezing — this is an emergency." Agent escalates immediately — does not continue a normal booking flow.
- [ ] **15.8** After the call, the full transcript appears in `/interactions` with the correct customer linked.
- [ ] **15.9** The transcript contains the actual words spoken — not a blank or "[inaudible]" throughout.

**Notes:** _______________________________________________________________

---

## Section 16 — Security & Tenant Isolation

> Do not skip. A failure here is a hard stop — no beta customer goes live until this passes.

- [ ] **16.1** Open a **second incognito window** and sign up with a new test email. This is Tenant B.
- [ ] **16.2** Tenant B completes signup. Tenant B gets their own `tenantId` (different from the one recorded in Section 1).
- [ ] **16.3** In Tenant B's session, navigate to `/customers`. The list is empty — the Section 2 customer does not appear.
- [ ] **16.4** In Tenant B's session, attempt `GET /api/customers/<tenant-a-customer-id>` directly (use DevTools or curl). Response is **404 or 403** — not the customer record.
- [ ] **16.5** In Tenant B's session, attempt `GET /api/estimates/<tenant-a-estimate-id>`. Response is **404 or 403**.
- [ ] **16.6** In Tenant B's session, attempt `GET /api/invoices/<tenant-a-invoice-id>`. Response is **404 or 403**.
- [ ] **16.7** In Tenant B's session, attempt `GET /api/jobs/<tenant-a-job-id>`. Response is **404 or 403**.
- [ ] **16.8** In Tenant B's session, attempt `POST /api/notes` with an `entityId` belonging to Tenant A. Response is **403 or 404** — the note is not created.
- [ ] **16.9** Stripe payment link from Section 6.12 is token-scoped and does not expose the tenant ID or any internal ID in the URL.
- [ ] **16.10** Estimate approval link from Section 5.9 is token-scoped. Attempting to brute-force a different token returns 404.

**Notes:** _______________________________________________________________

---

## Sign-Off Summary

| Section | Pass | Fail | Skipped | Blocking? | Notes |
|---------|------|------|---------|-----------|-------|
| 1 — Auth & Tenant Bootstrap | ☐ | ☐ | ☐ | ☐ | |
| 2 — Customer Profile & Locations | ☐ | ☐ | ☐ | ☐ | |
| 3 — Lead Pipeline & Conversion | ☐ | ☐ | ☐ | ☐ | |
| 4 — Jobs | ☐ | ☐ | ☐ | ☐ | |
| 5 — Estimates | ☐ | ☐ | ☐ | ☐ | |
| 6 — Invoices & Payment | ☐ | ☐ | ☐ | ☐ | |
| 7 — Appointments & Scheduling | ☐ | ☐ | ☐ | ☐ | |
| 8 — Dispatch Board | ☐ | ☐ | ☐ | ☐ | |
| 9 — Notifications & Communications | ☐ | ☐ | ☐ | ☐ | |
| 10 — Customer Portal & Public Pages | ☐ | ☐ | ☐ | ☐ | |
| 11 — AI Assistant | ☐ | ☐ | ☐ | ☐ | |
| 12 — Technician Mobile View | ☐ | ☐ | ☐ | ☐ | |
| 13 — Maintenance Contracts | ☐ | ☐ | ☐ | ☐ | |
| 14 — Vertical Packs & Settings | ☐ | ☐ | ☐ | ☐ | |
| 15 — Calling Agent | ☐ | ☐ | ☐ | ☐ | |
| 16 — Security & Tenant Isolation | ☐ | ☐ | ☐ | **Always** | |

**Overall verdict:** ☐ GO &nbsp; ☐ NO-GO

**Blocking issues (must be resolved before customer onboard):**

1. _______________________________________________________________
2. _______________________________________________________________
3. _______________________________________________________________

**Non-blocking issues (log for next sprint):**

1. _______________________________________________________________
2. _______________________________________________________________

**Signed off by:** ___________________________  &nbsp; **Date:** _______________

---

*Automated counterpart: `docs/beta-verify-script.md` (upcoming — maps Sections 1, 5, 6, 9, and 16 to API-driven assertions).*
