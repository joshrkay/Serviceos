# Browser UI Review — Coworker Instructions

**What this is:** A walkthrough of the staging app to verify every major screen
works before we onboard beta customers. No coding required — just a browser,
this checklist, and about 90 minutes.

**Staging URL:** https://serviceosweb-development.up.railway.app

**Before you start — confirm the app loads:**
Open the staging URL. You should see a Rivet login page. If you see a white
screen or a JavaScript error, stop and message the dev team — the deployment
needs a fix before this review can proceed.

**How to report:** Copy this file, rename it `ui-review-YYYY-MM-DD-yourname.md`,
fill in every checkbox, and share it back. Mark each item:
- ✅ Works exactly as described
- ❌ Broken — describe what happened in the Notes field
- ⚠️ Works but something looked off — describe it
- ⏭️ Skipped — explain why

---

## Before You Begin — Create Two Test Accounts

You will need **two separate accounts** to test that data stays separated between businesses.

**Account A (your main test account):**
- [ ] Go to `https://serviceosweb-development.up.railway.app/signup`
- [ ] Sign up with a test email you can access (e.g. `yourname+qa-a@gmail.com`)
- [ ] Complete signup and confirm you land inside the app (not a blank screen)
- [ ] Write down this email: `___________________________`

**Account B (the second business account — used for isolation testing):**
- [ ] Open a fresh **incognito window** (Chrome: Cmd+Shift+N / Ctrl+Shift+N)
- [ ] Go to the same signup URL
- [ ] Sign up with a different test email (e.g. `yourname+qa-b@gmail.com`)
- [ ] Confirm you land inside the app
- [ ] Keep this incognito window open — you'll use it later
- [ ] Write down this email: `___________________________`

For the rest of this checklist, do everything in your **normal window (Account A)**
unless a step says "incognito window."

---

## Section 1 — Basic Navigation

- [ ] **1.1** The home/dashboard page loads after login. You see some kind of welcome screen or recent activity — not a blank white page.
- [ ] **1.2** Click each item in the left navigation: Jobs, Customers, Leads, Estimates, Invoices, Schedule, Dispatch, Assistant, Contracts, Interactions, Settings. Each page loads without a full-page error.
- [ ] **1.3** Refresh the page while on `/customers`. You stay on the customers page — you are not logged out.
- [ ] **1.4** Log out (find the logout button in the nav or account menu). You land on the login page.
- [ ] **1.5** Log back in. You return to the app.

**Notes:** _______________________________________________________________

---

## Section 2 — Create a Customer

- [ ] **2.1** Navigate to Customers → click "New Customer" (or similar button).
- [ ] **2.2** Fill in:
  - First name: `Test`
  - Last name: `Customer`
  - Phone: your real mobile number (you'll need it to receive an SMS later)
  - Email: your real email (you'll need it to receive an email later)
- [ ] **2.3** Add a service address: `123 Main St, Austin, TX 78701`
- [ ] **2.4** Add a second service address: `456 Oak Ave, Austin, TX 78702`
- [ ] **2.5** Save. The customer appears in the customer list.
- [ ] **2.6** Click into the customer. Both addresses are visible.
- [ ] **2.7** Add a note on the customer: `Prefers afternoon. Gate code 1234.` Save.
- [ ] **2.8** Reload the page. The note is still there.

**Record the customer URL (e.g. `/customers/abc-123`):** `___________________________`

**Notes:** _______________________________________________________________

---

## Section 3 — Create a Lead & Convert It

- [ ] **3.1** Navigate to Leads → New Lead.
- [ ] **3.2** Fill in a name, phone, and service type (e.g. "AC not cooling"). Save.
- [ ] **3.3** Open the lead. Click "Convert to customer."
- [ ] **3.4** A new customer is created with the lead's contact info already filled in — you did not have to retype it.
- [ ] **3.5** The original lead now shows as "Converted" — it was not deleted.
- [ ] **3.6** Open a new tab and go to `/intake`. A multi-step form loads (no login required).
- [ ] **3.7** Fill out the intake form as if you're a homeowner requesting service. Submit.
- [ ] **3.8** Back in the app at Leads, the intake submission appears as a new lead.

**Notes:** _______________________________________________________________

---

## Section 4 — Create a Job

- [ ] **4.1** Navigate to Jobs → New Job.
- [ ] **4.2** Select the "Test Customer" from Section 2.
- [ ] **4.3** A dropdown of service locations appears. Select `123 Main St` (the first address — not the second one).
- [ ] **4.4** Add a description: `Annual AC tune-up`. Set status to Draft. Save.
- [ ] **4.5** Open the job detail. Confirm:
  - Customer name is shown and is a link back to the customer
  - Service address shows `123 Main St` (not `456 Oak Ave` and not blank)
  - The customer note from Section 2.7 ("Prefers afternoon...") is visible without navigating away
- [ ] **4.6** Add a time entry: start 9:00am, end 11:30am. Duration shows 2h 30m.
- [ ] **4.7** Upload a photo (any image from your computer). It appears on the job page.
- [ ] **4.8** Add a note on the job: `Replaced capacitor. System back to spec.`
- [ ] **4.9** Change status: Draft → Scheduled → In Progress → Completed. Each change sticks.

**Record the job URL:** `___________________________`

**Notes:** _______________________________________________________________

---

## Section 5 — Create & Send an Estimate

- [ ] **5.1** Navigate to Estimates → New Estimate.
- [ ] **5.2** Link to the Test Customer and the job from Section 4. The service address auto-fills as `123 Main St`.
- [ ] **5.3** Add a line item: `Capacitor replacement`, qty 1, price $95.00. Total shows exactly $95.00.
- [ ] **5.4** Look for an AI line-item suggestion button. Click it. Suggestions appear within 15 seconds.
- [ ] **5.5** Accept one suggestion. It's added to the list and the total updates.
- [ ] **5.6** Save. Status = Draft.
- [ ] **5.7** Click Send → choose SMS. The send succeeds (no error message).
- [ ] **5.8** Check your real phone. An SMS arrives within 60 seconds with a link starting with `/e/`.
- [ ] **5.9** Open that link in a new incognito window. The estimate shows: business name, line items, total, and `123 Main St` as the address.
- [ ] **5.10** Click Approve in the incognito window.
- [ ] **5.11** Back in the app, the estimate status changed to Approved — without you refreshing.

**Record the estimate URL:** `___________________________`
**Record the approval link from the SMS:** `___________________________`

**Notes:** _______________________________________________________________

---

## Section 6 — Create Invoice & Trace the Data Chain

- [ ] **6.1** Navigate to Invoices → New Invoice. Create it from the approved estimate (Section 5).
- [ ] **6.2** Line items and total match the estimate exactly.
- [ ] **6.3** Save. Status = Draft.

**Now trace backwards through the data — this is the key check:**

- [ ] **6.4** On the invoice detail: there is a link or reference to the **original estimate**. Click it. You land on the Section 5 estimate.
- [ ] **6.5** On the estimate detail: there is a link to the **job**. Click it. You land on the Section 4 job.
- [ ] **6.6** On the job detail: there is a link to the **customer**. Click it. You land on the Test Customer.
- [ ] **6.7** On the customer detail: the job, estimate, AND invoice are all visible in the history sections.
- [ ] **6.8** The service address shown on the invoice is `123 Main St` — the same as the estimate and job. All four records reference the same location.

**Send and pay:**

- [ ] **6.9** Back on the invoice, click Send → Email. The send succeeds.
- [ ] **6.10** Check your real email. An invoice email arrives with a payment link.
- [ ] **6.11** Open the payment link in incognito. Payment page shows the correct total and address.
- [ ] **6.12** Pay using Stripe test card: `4242 4242 4242 4242`, any future expiry, any CVC.
- [ ] **6.13** Wait up to 60 seconds. The invoice status in the app changes to **Paid** automatically.
- [ ] **6.14** The paid amount matches the invoice total — no rounding error.

**Record the invoice URL:** `___________________________`

**Notes:** _______________________________________________________________

---

## Section 7 — Appointments & Scheduling

- [ ] **7.1** Navigate to Schedule. The calendar loads showing the current week.
- [ ] **7.2** Create an appointment: link to Test Customer and the Section 4 job, set tomorrow 10am–12pm, assign to a technician.
- [ ] **7.3** Appointment appears on the calendar at the correct time.
- [ ] **7.4** Click the appointment. The service address (`123 Main St`) is visible — not blank.
- [ ] **7.5** Create a second appointment for the same technician, tomorrow 11am–1pm (overlaps by 1 hour).
- [ ] **7.6** Both appointments show a conflict indicator (a badge, color change, or warning icon).
- [ ] **7.7** Drag the second appointment to 2pm–4pm. Conflict indicators clear.
- [ ] **7.8** Open the Schedule in a **second browser tab**. The drag change from 7.7 is visible there without refreshing.

**Notes:** _______________________________________________________________

---

## Section 8 — Dispatch Board

- [ ] **8.1** Navigate to the Dispatch Board. Technician lanes are visible.
- [ ] **8.2** The appointment from Section 7 appears in the correct technician's lane.
- [ ] **8.3** Drag an unassigned appointment (if any) into a technician's lane. It moves.
- [ ] **8.4** Open Dispatch in a second tab. The drag change appears in the second tab within a few seconds.

**Notes:** _______________________________________________________________

---

## Section 9 — AI Assistant

- [ ] **9.1** Navigate to Assistant. The chat interface loads.
- [ ] **9.2** Type: `Show me open estimates.` A response comes back within 15 seconds that references real data.
- [ ] **9.3** Type: `What's the status of the Test Customer job?` The response mentions the job from Section 4 by name or status.
- [ ] **9.4** Reload the page. Your previous messages are still visible.

**Notes:** _______________________________________________________________

---

## Section 10 — Customer Portal Pages (No Login Required)

- [ ] **10.1** Open the estimate approval link from Section 5.8 again in incognito. Since it was already approved, it should show a confirmed/read-only view — not an active approval button.
- [ ] **10.2** Open the invoice payment link from Section 6.10 in incognito. Since it was paid, it should show a "Paid" confirmation — not an active payment form.
- [ ] **10.3** Navigate to `/intake` in incognito. Select a service type. Verify the form shows fields specific to that service (not a generic form).

**Notes:** _______________________________________________________________

---

## Section 11 — Settings

- [ ] **11.1** Navigate to Settings → Business Profile. Edit the company name to `QA Test Business`. Save.
- [ ] **11.2** Hard-reload the page (Ctrl+Shift+R / Cmd+Shift+R). The name `QA Test Business` is still there — it persisted.
- [ ] **11.3** Open Terminology. Change "Technician" to "Specialist". Save.
- [ ] **11.4** Navigate to Dispatch. The technician label now says "Specialist" (or equivalent).
- [ ] **11.5** Open Deposit Rules. Set a deposit %. Save. Reload — value is still there.
- [ ] **11.6** Open Team Members. The sheet opens and shows your account.
- [ ] **11.7** Navigate to Settings → Templates. At least one template exists.
- [ ] **11.8** Navigate to Settings → Price Book. At least one item exists.
- [ ] **11.9** Navigate to Settings → Language. Switch to Spanish. Core nav labels change language. Switch back to English.

**Notes:** _______________________________________________________________

---

## Section 12 — Tenant Data Isolation (Critical)

> This section checks that Account B (the incognito window) cannot see Account A's data.
> A failure here is serious — it means one business could see another's customer data.

Switch to your **incognito window (Account B)**.

- [ ] **12.1** Navigate to Customers. The list is **empty** — the Test Customer from Section 2 does not appear.
- [ ] **12.2** In the browser address bar, paste the customer URL from Section 2. Press Enter.
  - Expected result: **404 or "not found"** page
  - ❌ Fail if: the Test Customer's data appears
- [ ] **12.3** Paste the estimate URL from Section 5. Press Enter.
  - Expected result: **404 or access denied**
  - ❌ Fail if: the estimate data appears
- [ ] **12.4** Paste the invoice URL from Section 6. Press Enter.
  - Expected result: **404 or access denied**
  - ❌ Fail if: the invoice data appears
- [ ] **12.5** Navigate to Jobs. List is **empty** — Account B has no jobs.
- [ ] **12.6** Navigate to Settings. Account B sees their own settings — not `QA Test Business` from Section 11.1.

**Notes:** _______________________________________________________________

---

## Section 13 — Technician View

- [ ] **13.1** Navigate to `/technician/day`. The page loads showing a day view.
- [ ] **13.2** If the appointment from Section 7 is today, it appears in the list. If not, note that the date needs to be today for this to show.
- [ ] **13.3** Click a job in the day view. Job detail loads with customer name and address visible.

**Notes:** _______________________________________________________________

---

## Sign-Off

| Section | ✅ Pass | ❌ Fail | ⚠️ Issues | ⏭️ Skipped |
|---------|--------|--------|----------|-----------|
| 1 — Navigation | ☐ | ☐ | ☐ | ☐ |
| 2 — Customer | ☐ | ☐ | ☐ | ☐ |
| 3 — Lead & Convert | ☐ | ☐ | ☐ | ☐ |
| 4 — Job | ☐ | ☐ | ☐ | ☐ |
| 5 — Estimate & SMS | ☐ | ☐ | ☐ | ☐ |
| 6 — Invoice & Payment | ☐ | ☐ | ☐ | ☐ |
| 7 — Appointments | ☐ | ☐ | ☐ | ☐ |
| 8 — Dispatch Board | ☐ | ☐ | ☐ | ☐ |
| 9 — AI Assistant | ☐ | ☐ | ☐ | ☐ |
| 10 — Customer Portal | ☐ | ☐ | ☐ | ☐ |
| 11 — Settings | ☐ | ☐ | ☐ | ☐ |
| 12 — Data Isolation | ☐ | ☐ | ☐ | ☐ |
| 13 — Technician View | ☐ | ☐ | ☐ | ☐ |

**Reviewer:** ___________________________
**Date:** ___________________________
**Browser & OS:** ___________________________
**Overall verdict:** ☐ Ready &nbsp; ☐ Issues found — see notes above

**Top issues to fix before beta:**

1. _______________________________________________________________
2. _______________________________________________________________
3. _______________________________________________________________
