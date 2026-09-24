# ServiceOS Manual QA Checklist

**Purpose:** Detailed manual testing checklist to run every 2–3 days  
**Time Estimate:** 2–3 hours (depends on new features added)  
**Target:** Catch regressions, verify new features, ensure UX quality

---

## Pre-Requisites

- [ ] Dev environment running (`npm run dev` in packages/api and packages/web)
- [ ] Browser open to web app (e.g., `http://localhost:3000`)
- [ ] Test credentials ready (see `.env.qa.example`)
- [ ] Mobile viewport simulator open (Chrome DevTools, 375px width)
- [ ] Slack/email ready for sending/receiving SMS/voice notifications

---

## Checklist Template

Copy and paste this section for each QA cycle, update the date, and fill in as you go.

### QA Run — [DATE: YYYY-MM-DD]
**Tester:** [YOUR NAME]  
**Date Started:** [TIME]  
**Date Completed:** [TIME]  
**Total Issues Found:** __  

---

## Module 1: Authentication & Multi-Tenancy

### 1.1 Login & Session
- [ ] Admin can log in via Clerk
- [ ] Session persists across page reloads
- [ ] Login state reflected in header (user name, avatar)
- [ ] Logout clears session
- [ ] Unauthenticated access to `/api/me` returns 401
- [ ] JWT token includes tenant_id claim

### 1.2 Multi-Tenant Isolation
- [ ] Tenant A customer list ≠ Tenant B customer list
- [ ] Editing Tenant A customer doesn't affect Tenant B
- [ ] Estimates from Tenant A don't appear in Tenant B
- [ ] Invoice totals are per-tenant (no cross-tenant leakage)
- [ ] RLS enforced: Direct DB query with wrong tenant_id returns empty

**Issues Found:** ___

---

## Module 2: Customers

### 2.1 CRUD Operations
- [ ] Create new customer (via web form)
- [ ] Customer appears immediately in list
- [ ] Edit customer: name, phone, email update correctly
- [ ] Delete customer (soft delete — should still appear in audit trail)
- [ ] Can't find deleted customer in active list
- [ ] Phone format: accepts (555) 123-4567, 555-123-4567, 5551234567
- [ ] Email validation: rejects invalid emails

### 2.2 Customer Display & Search
- [ ] Customer list loads in <2s
- [ ] Search by name works
- [ ] Search by phone works (handles formatting)
- [ ] Pagination works (if >100 customers)
- [ ] Customer detail page shows all fields
- [ ] Audit trail shows who created/edited customer

### 2.3 SMS Consent & Privacy
- [ ] Customer has "SMS consent" checkbox
- [ ] Unchecking consent prevents SMS from being sent
- [ ] Consent timestamp is recorded
- [ ] Can't send SMS to non-consented customer (error shown)
- [ ] Consent history is logged in audit trail

**Issues Found:** ___

---

## Module 3: Estimates

### 3.1 Create & Draft
- [ ] Open "New Estimate" form
- [ ] Select customer from dropdown
- [ ] Add service line items (labor + materials)
- [ ] AI-generated estimate appears with realistic pricing
- [ ] Pricing matches catalog (no made-up line items)
- [ ] Can edit line item quantities and prices
- [ ] Discount can be applied (percentage or fixed amount)
- [ ] Total updates correctly (sum of lines, minus discount, plus tax)
- [ ] Save as draft
- [ ] Draft appears in "Open Estimates" list

### 3.2 Approval Workflow
- [ ] Draft estimate can be sent to customer via SMS
- [ ] Customer sees public estimate page (unformatted, no auth needed)
- [ ] Public page shows all line items, total, payment button
- [ ] Public page does NOT leak other customer data or tenant info
- [ ] Customer can approve estimate from public page (one-tap link)
- [ ] Approved timestamp recorded
- [ ] Estimate moves from "Open" to "Approved" in list
- [ ] SMS notification sent to technician (if configured)

### 3.3 Conversion to Job
- [ ] Click "Schedule Job" on approved estimate
- [ ] Job creation form pre-fills customer & description from estimate
- [ ] Can set appointment date/time
- [ ] Can assign technician(s)
- [ ] Job created successfully
- [ ] Estimate marked as "Converted to Job"
- [ ] Can't re-convert same estimate

### 3.4 Pricing & Math
- [ ] Money stored as integer cents (verify in DB)
- [ ] Total = sum(line_items) - discount + tax
- [ ] Tax calculated correctly (round to nearest cent)
- [ ] Discount applies before tax (or after, depending on config)
- [ ] No floating-point errors (e.g., $19.99 not shown as $19.989999)

**Issues Found:** ___

---

## Module 4: Jobs & Scheduling

### 4.1 Job Creation & Status
- [ ] Create job from estimate or manually
- [ ] Job statuses cycle correctly: open → scheduled → in-progress → completed
- [ ] Can't move from scheduled to completed without passing in-progress
- [ ] Status change timestamps recorded
- [ ] Job appears on technician's calendar/list

### 4.2 Appointment Assignments
- [ ] Assign technician to job
- [ ] Appointment shows in technician's schedule
- [ ] Double-booking prevention: can't assign same tech to overlapping time slot
- [ ] Error message shown: "Tech already scheduled 2–3pm"
- [ ] Can reassign to different tech
- [ ] Reassignment updates calendar immediately
- [ ] Time zones respected: appointment shown in tenant's local time

### 4.3 Job Timeline & Audit
- [ ] Job notes can be added
- [ ] Notes appear chronologically
- [ ] Job edit history shows who changed what and when
- [ ] Technician assignment changes logged
- [ ] Status change audit events recorded

**Issues Found:** ___

---

## Module 5: Invoices & Payments

### 5.1 Invoice Lifecycle
- [ ] Invoice created from completed job
- [ ] Invoice number auto-generated (unique, sequential)
- [ ] Invoice status starts as "pending"
- [ ] Can't move to "paid" without payment recorded
- [ ] Payment recorded: status → "paid", timestamp captured
- [ ] Can mark as "void" (soft delete, audit trail retained)
- [ ] Voided invoice can't receive further payments
- [ ] Paid invoice can't be edited

### 5.2 Payment Processing
- [ ] Customer can pay online (Stripe)
- [ ] Payment link sent via SMS (if customer consented)
- [ ] Payment link directs to Stripe Checkout
- [ ] Stripe webhook received and processed
- [ ] Invoice marked as paid within 10 seconds of webhook
- [ ] Payment recorded once (no duplicates from duplicate webhooks)
- [ ] Refund recorded if payment reversed on Stripe side
- [ ] Refund amount matches original payment ± tax

### 5.3 Invoice Math
- [ ] Total = sum of estimate line items + adjustments ± tax
- [ ] No float errors: $123.45 renders correctly (not $123.450000)
- [ ] Tax calculation: verify formula and rounding
- [ ] Discount applied correctly
- [ ] Partial payments tracked (if enabled)

### 5.4 Invoice Display & PDF
- [ ] Invoice renders cleanly in web (no layout breaks)
- [ ] PDF export available (if feature enabled)
- [ ] PDF includes all line items, totals, payment info
- [ ] Audit trail visible (who created, when paid, etc.)

**Issues Found:** ___

---

## Module 6: SMS & Communication

### 6.1 SMS Sending
- [ ] SMS to customer with estimate link (requires consent)
- [ ] SMS to technician about job assignment
- [ ] SMS fails gracefully if customer has no phone or no consent
- [ ] Error message clear: "Can't send SMS — customer has not consented"
- [ ] SMS appears in message log/audit trail
- [ ] Received SMS logged (inbound DNC messages, replies, etc.)

### 6.2 SMS Consent & Privacy
- [ ] Sending SMS to non-consented number fails
- [ ] Consent timestamp recorded accurately
- [ ] Can withdraw consent (checkbox unchecked)
- [ ] DNC (Do Not Call) list is checked before sending
- [ ] TCPA quiet hours enforced (no calls 9pm–8am in customer timezone)

### 6.3 Notifications
- [ ] Push notifications appear on web when SMS received
- [ ] Bell icon shows unread notification count
- [ ] Clicking notification shows message details
- [ ] Notifications persist across page reloads

**Issues Found:** ___

---

## Module 7: Voice & AI

### 7.1 Voice Features
- [ ] Outbound call initiated to customer
- [ ] Call recording captured
- [ ] Transcript recorded (AI-generated if speech-to-text enabled)
- [ ] Call log appears in timeline
- [ ] Transcript searchable
- [ ] Can't initiate call to customer without consent (if privacy policy requires)

### 7.2 AI Proposals
- [ ] Generate proposal via voice: "Create an estimate for a roof repair"
- [ ] AI extracts service details correctly
- [ ] AI-generated estimate appears in draft list
- [ ] Pricing reasonable and grounded in catalog (no hallucinations)
- [ ] Technician can approve/edit before sending to customer

### 7.3 TCPA Compliance
- [ ] Can't call customer during quiet hours (9pm–8am local time)
- [ ] DNC list checked before outbound call
- [ ] Consent tracked (date, method, opt-out option provided)
- [ ] Attempted call to DNC number fails gracefully

**Issues Found:** ___

---

## Module 8: User Interface & UX

### 8.1 Responsiveness & Mobile
- [ ] Tap targets ≥44px (min-h-11 in Tailwind)
- [ ] No horizontal overflow at 320px (iPhone SE width)
- [ ] Forms stack correctly on mobile
- [ ] Buttons are easily clickable (padding, spacing)
- [ ] Modals/overlays close on ESC or outside click
- [ ] Scroll behavior smooth (no jank)

### 8.2 Loading States & Errors
- [ ] Loading spinner appears during API calls
- [ ] Skeletons or placeholders shown for content loading
- [ ] Error messages clear and actionable
- [ ] Retry buttons available for failed requests
- [ ] Network timeout handled gracefully
- [ ] Form validation errors shown next to fields (not separate modal)

### 8.3 Navigation
- [ ] Logo click returns to dashboard
- [ ] Sidebar navigation works on mobile (hamburger or bottom nav)
- [ ] Active tab/route highlighted
- [ ] Breadcrumbs shown (if applicable)
- [ ] Back button works consistently
- [ ] Deep links work (can share URL, reload and state persists)

### 8.4 Accessibility
- [ ] Form labels linked to inputs
- [ ] Tab order logical (top → bottom, left → right)
- [ ] Color contrast ≥4.5:1 for text
- [ ] Alt text on images
- [ ] Keyboard navigation possible (no click-only controls)
- [ ] ARIA labels on custom controls

**Issues Found:** ___

---

## Module 9: Data Integrity & Money

### 9.1 Money Types
- [ ] All prices stored as integer cents in DB
- [ ] No float values in API responses
- [ ] Money math accurate (no rounding errors)
- [ ] Query: `SELECT price, typeof(price) FROM estimates LIMIT 1` returns integer
- [ ] Stripe webhook: amount in cents matches our DB cents

### 9.2 Audit Trail
- [ ] Every mutation (create, update, delete) logged
- [ ] Audit log includes: who, what, when, before, after
- [ ] Can't forge audit entries
- [ ] Audit log searchable by entity_id or user_id
- [ ] Deleted customer still recoverable from audit trail

### 9.3 Transactions & Rollback
- [ ] If job creation fails, estimate not marked as "converted"
- [ ] If payment fails, invoice not marked as "paid"
- [ ] Partial writes don't happen (all-or-nothing)
- [ ] Database constraints prevent orphaned records

**Issues Found:** ___

---

## Module 10: Security

### 10.1 Authentication
- [ ] Unauthenticated access to private pages redirects to login
- [ ] JWT token validated on every request
- [ ] Expired token logs out user
- [ ] Token refresh works without user intervention

### 10.2 Authorization
- [ ] Admin can view all tenants' data (if multi-admin enabled)
- [ ] Non-admin can only see their own tenant
- [ ] Can't access other tenant's customer via direct URL
- [ ] API returns 403 (not 404) when accessing forbidden resource (no info leakage)

### 10.3 Data Privacy
- [ ] PII not logged in error messages
- [ ] Passwords never stored/transmitted in plain text
- [ ] Phone numbers masked in logs (last 4 digits only)
- [ ] Public estimate page doesn't leak tenant name or other customers

**Issues Found:** ___

---

## Module 11: Performance

### 11.1 Load Times
- [ ] Home page loads in <2s (after login)
- [ ] Customer list loads in <2s (even with 1000+ customers)
- [ ] Search (customer, estimate) returns results in <1s
- [ ] Image uploads complete in <5s

### 11.2 Responsiveness
- [ ] Clicking button doesn't lag (no 500ms+ delay)
- [ ] Form submission feedback immediate (loading spinner)
- [ ] Pagination works smoothly
- [ ] Infinite scroll (if enabled) doesn't cause jank

**Issues Found:** ___

---

## Module 12: New Features (This Cycle)

**Last Updated:** [YYYY-MM-DD]  
**New Features Since Last QA Run:** 
- [ ] Feature: [name] — [status: tested/pending/blocked]
- [ ] Feature: [name] — [status: tested/pending/blocked]

---

## Summary & Regression Report

### Issues Found This Cycle
| ID | Severity | Module | Description | Status |
|---|---|---|---|---|
| 1 | 🔴 CRITICAL | | | |
| 2 | 🟠 HIGH | | | |
| 3 | 🟡 MEDIUM | | | |

### Regression Check (vs. Previous Run)
- Previous failures that passed this time: ___
- Previous passes that failed this time: ___
- New failures: ___
- Risk Level: 🟢 LOW / 🟡 MEDIUM / 🔴 HIGH

### QA Sign-Off
- **Tested By:** ___
- **Date:** ___
- **Overall Status:** ✅ READY / 🟡 BLOCKERS / 🔴 CRITICAL ISSUES
- **Recommendation:** [Approve / Hold / Block]

---

## Notes for Next Tester

[Freeform notes about what you discovered, workarounds, setup quirks, things to watch for, etc.]

---

## Helpful Commands

```bash
# Start dev environment
npm run dev

# Run type checking
npm run typecheck

# Run unit tests (with timeout)
timeout 300 npm test --workspace=packages/api

# Run linter
npm run lint:eslint

# View database directly (requires DB URL)
psql $E2E_DB_URL_READONLY

# Check audit trail for a customer
psql $E2E_DB_URL_READONLY -c "SELECT * FROM audit_log WHERE entity_id='[CUSTOMER_ID]' ORDER BY created_at DESC LIMIT 20;"

# Reset test database (use cautiously!)
npm run qa:reset

# Seed test data
npm run seed

# View test reports
npm run qa:report
```

---

## Escalation Path

1. **Minor UI bugs:** Create issue, label `ui-polish`
2. **Money/security issues:** Create issue, label `critical`, assign to lead
3. **Test infrastructure problems:** Tag ops team
4. **Questions about feature behavior:** Ask product owner
