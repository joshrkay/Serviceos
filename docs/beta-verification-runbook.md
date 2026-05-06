# Beta Verification Runbook — Manual Checklist

> **Purpose:** Prove that each shipped feature works end-to-end in a live environment before
> a beta customer is onboarded. This is not a code review — it is a human running through
> real actions in a real browser against a deployed staging (or production) instance.
>
> **When to run:** Before each new beta customer onboard, and after any deploy that touches
> more than one package.
>
> **How to record:** Copy this file, rename it `beta-verification-YYYY-MM-DD.md`, fill in
> each checkbox, and commit it to `docs/verification-runs/`.

---

## Pre-conditions

Before starting, confirm all of the following:

- [ ] Staging URL is reachable: `___________________________`
- [ ] You have a test Clerk account that is **not** a real customer
- [ ] Stripe is in **test mode** (check Stripe dashboard — top bar shows "Test mode")
- [ ] You have a test Twilio number available for SMS verification
- [ ] The deploy you are testing is confirmed: git SHA `_______________`
- [ ] `/health` returns `{ status: "ok" }` — **stop here if it does not**
- [ ] `/ready` returns 200 — **stop here if it does not**

**Tester:** ___________________________
**Date:** ___________________________
**Environment:** ☐ Staging  ☐ Production

---

## Section 1 — Auth & Tenant Bootstrap

The entire product depends on this. If anything here fails, stop and fix before continuing.

- [ ] **1.1** Navigate to `/signup`. Page loads with Fieldly branding, no console errors.
- [ ] **1.2** Sign up with a new test email. Clerk signup flow completes.
- [ ] **1.3** After signup, app redirects to `/onboarding` or `/`. You are not stuck on a blank screen.
- [ ] **1.4** Hit `GET /api/me` (or open DevTools → Network and look for the me/session call). Response includes a `tenantId`. This proves the Clerk webhook fired and the tenant was bootstrapped in Postgres.
- [ ] **1.5** Reload the page. You remain logged in (session persists).
- [ ] **1.6** Navigate to `/login` while logged in. Redirects away — does not show login form to an already-authenticated user.
- [ ] **1.7** Log out. Redirected to `/login`.
- [ ] **1.8** Navigate to `/` while logged out. Redirected to `/login`.

**Notes:** _______________________________________________________________

---

## Section 2 — Customers

- [ ] **2.1** Navigate to `/customers`. Page loads, empty state or list shown.
- [ ] **2.2** Create a new customer: first name, last name, phone, email, service address. Save succeeds.
- [ ] **2.3** Customer appears in the list immediately after save.
- [ ] **2.4** Click into the customer detail. Name, phone, email, address all display correctly.
- [ ] **2.5** Edit the customer's phone number. Save. Detail page shows the updated number.
- [ ] **2.6** Search for the customer by last name. They appear in results.
- [ ] **2.7** Archive the customer. They disappear from the active list.

**Notes:** _______________________________________________________________

---

## Section 3 — Leads

- [ ] **3.1** Navigate to `/leads`. Page loads.
- [ ] **3.2** Create a new lead manually. Appears in the lead list.
- [ ] **3.3** Open the lead detail. Click "Convert to customer." New customer is created.
- [ ] **3.4** Navigate to `/intake` (unauthenticated tab). Multi-step intake form loads.
- [ ] **3.5** Complete the intake form as a prospective customer. Submit.
- [ ] **3.6** Back in the app, the intake submission appears as a new lead in `/leads`.

**Notes:** _______________________________________________________________

---

## Section 4 — Jobs

- [ ] **4.1** Navigate to `/jobs`. Page loads.
- [ ] **4.2** Create a new job: select the customer from Section 2, add a description, set status to Draft. Save.
- [ ] **4.3** Job appears in the list.
- [ ] **4.4** Open the job detail. Add a time entry (start/end). Entry saves and shows on the detail.
- [ ] **4.5** Upload a job photo. Photo appears on the job detail.
- [ ] **4.6** Change job status from Draft → Scheduled. Status badge updates.
- [ ] **4.7** Change job status to Completed. Status badge updates.

**Notes:** _______________________________________________________________

---

## Section 5 — Estimates

- [ ] **5.1** Navigate to `/estimates`. Page loads.
- [ ] **5.2** Navigate to `/estimates/new`. Create form loads.
- [ ] **5.3** Link the estimate to the customer and job from Sections 2–4.
- [ ] **5.4** Add at least one line item manually (description, qty, unit price). Total calculates correctly in integer cents — no floating point artifacts (e.g. $125.00 not $124.9999).
- [ ] **5.5** Trigger AI line-item suggestions. Suggestions appear within 15 seconds.
- [ ] **5.6** Accept one AI suggestion. It is added to the line items.
- [ ] **5.7** Save the estimate. Status is "draft."
- [ ] **5.8** Send the estimate. A public approval link is generated (format: `/e/:token`).
- [ ] **5.9** Open the approval link in an **incognito window** (unauthenticated). Estimate detail renders — customer can see line items and total.
- [ ] **5.10** Click "Approve" on the public page. Status flips to "approved" in the app.
- [ ] **5.11** Back in the app, the estimate shows as approved.

**Notes:** _______________________________________________________________

---

## Section 6 — Invoices

- [ ] **6.1** Navigate to `/invoices/new`. Create an invoice from the approved estimate in Section 5.
- [ ] **6.2** Invoice inherits line items and total from the estimate.
- [ ] **6.3** Save invoice. Status is "draft."
- [ ] **6.4** Send the invoice. A Stripe payment link is generated.
- [ ] **6.5** A public payment link is generated (format: `/pay/:token`).
- [ ] **6.6** Open the payment link in an **incognito window**. Invoice total and line items render.
- [ ] **6.7** Complete a Stripe test payment using card `4242 4242 4242 4242`, any future expiry, any CVC.
- [ ] **6.8** After payment, return to the app. Invoice status has changed to "paid." *(This depends on the Stripe webhook firing — allow up to 30 seconds.)*
- [ ] **6.9** The paid amount matches the invoice total exactly — no rounding error.

**Notes:** _______________________________________________________________

---

## Section 7 — Appointments & Schedule

- [ ] **7.1** Navigate to `/schedule`. Calendar loads showing current week.
- [ ] **7.2** Create a new appointment: link to the customer and job, set date/time, assign a technician.
- [ ] **7.3** Appointment appears on the calendar at the correct date/time slot.
- [ ] **7.4** Edit the appointment time by dragging it to a new slot. Time updates.
- [ ] **7.5** Create a second appointment that overlaps with the first. A conflict badge appears on at least one of them.
- [ ] **7.6** Delete one of the conflicting appointments. Conflict badge clears on the remaining one.

**Notes:** _______________________________________________________________

---

## Section 8 — Dispatch Board

- [ ] **8.1** Navigate to the dispatch board (check nav for "Dispatch" link).
- [ ] **8.2** Unassigned appointments appear in the unassigned queue.
- [ ] **8.3** Drag an unassigned appointment to a technician lane. It moves.
- [ ] **8.4** Open the same board in a second browser tab. The drag-drop change from 8.3 is visible in the second tab within a few seconds (cross-tab refresh).
- [ ] **8.5** Conflict badges render on appointments with time overlap.

**Notes:** _______________________________________________________________

---

## Section 9 — Payments & Billing

- [ ] **9.1** Navigate to Settings → Payment methods. Stripe Connect onboarding flow is accessible.
- [ ] **9.2** The invoice payment flow from Section 6 completed without error (Stripe test mode).
- [ ] **9.3** The invoice webhook correctly marked the invoice paid (confirmed in Section 6.8).
- [ ] **9.4** Navigate to Settings → Deposit rules. Sheet opens, fields are editable, save succeeds.
- [ ] **9.5** Navigate to Settings → Fieldly subscription. Stripe billing portal link opens (may redirect to Stripe in test mode).

**Notes:** _______________________________________________________________

---

## Section 10 — AI Assistant

- [ ] **10.1** Navigate to `/assistant`. Chat interface loads.
- [ ] **10.2** Type a message: "Show me open estimates." Response comes back within 15 seconds referencing real data from the app.
- [ ] **10.3** Type a message: "Create a follow-up note for [customer name from Section 2]." Response acknowledges the customer by name.
- [ ] **10.4** The conversation persists if you reload the page (conversation ID in URL or localStorage).
- [ ] **10.5** Record a voice note using the microphone button. Upload completes. Transcription appears in the chat within 30 seconds.

**Notes:** _______________________________________________________________

---

## Section 11 — Customer-Facing Portal

- [ ] **11.1** The estimate approval link from Section 5.8 works in incognito (confirmed in 5.9–5.10).
- [ ] **11.2** The invoice payment link from Section 6.5 works in incognito (confirmed in 6.6–6.8).
- [ ] **11.3** Navigate to `/intake`. Intake form loads without auth. Vertical-specific fields appear after selecting a service type.
- [ ] **11.4** Navigate to `/public/feedback/:token` using a token from a sent estimate. Feedback form renders. Submit feedback. It appears in Settings → Feedback & reviews.

**Notes:** _______________________________________________________________

---

## Section 12 — Vertical Packs & Settings

- [ ] **12.1** Navigate to `/settings`. Settings page loads.
- [ ] **12.2** Open Business Profile sheet. Edit company name. Save. Reload — updated name persists.
- [ ] **12.3** Open Terminology sheet. Change a term (e.g., rename "Technician" to "Specialist"). Save. The new term appears in relevant UI labels.
- [ ] **12.4** Open AI Approval Rules sheet. Adjust auto-approve threshold. Save. Reload — value persists.
- [ ] **12.5** Toggle a vertical pack on (e.g., Plumbing if HVAC is default). Pack-specific service types appear in job/estimate forms.
- [ ] **12.6** Navigate to `/settings/templates`. Template list loads. Edit a template — changes save.
- [ ] **12.7** Navigate to `/settings/price-book`. Price book loads with line items.
- [ ] **12.8** Navigate to `/settings/language`. Language toggle works. Switch to Spanish — UI labels change language.

**Notes:** _______________________________________________________________

---

## Section 13 — Integrations

- [ ] **13.1** **SMS:** Send an estimate from Section 5.8 via SMS (not just email). Customer phone receives the text with the approval link. *(Requires a real phone number for the test customer.)*
- [ ] **13.2** **Email:** Send an invoice from Section 6.4 via email. Email is received with the payment link.
- [ ] **13.3** **Calendar sync:** Navigate to Settings → Calendar sync. Google OAuth connect flow launches. *(Full test requires a Google account — confirm flow initiates, not necessarily completes in staging.)*
- [ ] **13.4** **Clerk webhook:** Confirmed in Section 1.4 — new signup triggers tenant bootstrap.
- [ ] **13.5** **Stripe webhook:** Confirmed in Section 6.8 — payment triggers invoice status update.

**Notes:** _______________________________________________________________

---

## Section 14 — Calling Agent (Basic Functional Check)

> This section tests the Gather fallback path (always available). The streaming
> Media Streams path (Deepgram + ElevenLabs) has its own load-test runbook at
> `docs/superpowers/runbooks/voice-quality-launch-gate.md`.

- [ ] **14.1** Call the Twilio test number for this environment. The call connects — not a dead line.
- [ ] **14.2** The agent greets the caller with the business name.
- [ ] **14.3** Say "I need to schedule an AC repair." Agent recognizes the intent and asks for the caller's name.
- [ ] **14.4** Provide a name that matches the test customer from Section 2. Agent acknowledges the customer.
- [ ] **14.5** Say "What's my most recent estimate?" Agent retrieves and reads back the estimate from Section 5.
- [ ] **14.6** Say "I'd like to pay my invoice." Agent provides the payment link or transfers appropriately.
- [ ] **14.7** Say "This is an emergency, my furnace is out and it's freezing." Agent escalates — does not continue the normal booking flow.
- [ ] **14.8** After the call, the transcript appears in `/interactions`.

**Notes:** _______________________________________________________________

---

## Section 15 — Technician Mobile View

- [ ] **15.1** Navigate to `/technician/day`. Day view loads showing today's assigned jobs.
- [ ] **15.2** Tap a job. Job detail is accessible.
- [ ] **15.3** Record a voice update using the voice button. Transcription appears as a note on the job.

**Notes:** _______________________________________________________________

---

## Section 16 — Maintenance Contracts

- [ ] **16.1** Navigate to `/contracts`. Page loads.
- [ ] **16.2** Create a new maintenance contract linked to the customer from Section 2. Save.
- [ ] **16.3** Contract appears in the list with correct status and renewal date.
- [ ] **16.4** Navigate to the contract detail. All fields display correctly.

**Notes:** _______________________________________________________________

---

## Section 17 — Tenant Isolation (Critical Security Check)

> Do not skip this section. A failure here is a hard stop — do not onboard any beta
> customer until this passes.

- [ ] **17.1** Create a **second** test Clerk account in a separate incognito window. Complete signup.
- [ ] **17.2** In Tenant B's session, navigate to `/customers`. Confirm the customer list is **empty** — Tenant A's customer does not appear.
- [ ] **17.3** From Tenant B, attempt to fetch Tenant A's customer by ID directly: `GET /api/customers/<tenant-a-customer-id>`. Confirm the response is **404 or 403** — not the customer record.
- [ ] **17.4** From Tenant B, attempt to fetch Tenant A's estimate by ID. Confirm 404 or 403.
- [ ] **17.5** From Tenant B, attempt to fetch Tenant A's invoice by ID. Confirm 404 or 403.

**Notes:** _______________________________________________________________

---

## Sign-Off

| Section | Pass | Fail | Skipped | Notes |
|---------|------|------|---------|-------|
| 1 — Auth & Tenant Bootstrap | ☐ | ☐ | ☐ | |
| 2 — Customers | ☐ | ☐ | ☐ | |
| 3 — Leads | ☐ | ☐ | ☐ | |
| 4 — Jobs | ☐ | ☐ | ☐ | |
| 5 — Estimates | ☐ | ☐ | ☐ | |
| 6 — Invoices & Payments | ☐ | ☐ | ☐ | |
| 7 — Appointments & Schedule | ☐ | ☐ | ☐ | |
| 8 — Dispatch Board | ☐ | ☐ | ☐ | |
| 9 — Payments & Billing | ☐ | ☐ | ☐ | |
| 10 — AI Assistant | ☐ | ☐ | ☐ | |
| 11 — Customer Portal | ☐ | ☐ | ☐ | |
| 12 — Vertical Packs & Settings | ☐ | ☐ | ☐ | |
| 13 — Integrations | ☐ | ☐ | ☐ | |
| 14 — Calling Agent | ☐ | ☐ | ☐ | |
| 15 — Technician Mobile | ☐ | ☐ | ☐ | |
| 16 — Maintenance Contracts | ☐ | ☐ | ☐ | |
| 17 — Tenant Isolation | ☐ | ☐ | ☐ | |

**Overall verdict:** ☐ GO  ☐ NO-GO

**Blocking issues found:**

1. _______________________________________________________________
2. _______________________________________________________________
3. _______________________________________________________________

**Signed off by:** ___________________________  **Date:** _______________

---

*To automate this checklist, see `docs/beta-verify-script.md` (upcoming).*
