# ServiceOS — Manual QA Checklist
**Every 2-3 days, run this exhaustive manual QA process**  
**This is brutally honest assessment, not sugar-coated reporting**

---

## Pre-Flight Checks (Before Testing Features)

### Environment Verification
- [ ] Node.js version: `node --version` (should be v20+)
- [ ] npm version: `npm --version` (should be 10.x)
- [ ] Database accessible: Can connect to dev/staging DB
- [ ] API running: `curl http://localhost:3000/health` returns `{status: ok}`
- [ ] Web app loads: No console errors when page loads
- [ ] Docker daemon: `docker ps` succeeds (for integration tests)

### Code Quality Baseline
- [ ] `npm run typecheck` — No TypeScript errors
- [ ] `npm run lint` — All ESLint rules pass
- [ ] Tests starting: `npm test` initializing (wait for completion)

---

## Feature Testing — Complete Runbook

### 1. PROVISIONING & ONBOARDING

**Objective:** New tenant can be created, configured, and ready to use

#### 1.1 Organization Setup
- [ ] **Create new organization**
  - [ ] Web form accepts valid name
  - [ ] Submitting creates record in DB
  - [ ] Tenant isolation: only creator sees it
  - [ ] RLS policy enforced (verify in DB: `SELECT count(*) FROM organization WHERE tenant_id = <id>`)

- [ ] **Required fields validation**
  - [ ] Organization name: required; error shown if empty
  - [ ] Address: optional but if provided, stored correctly
  - [ ] Phone: E.164 format enforced; error shown for invalid format

- [ ] **Mobile flow (320px viewport)**
  - [ ] Form fields display without horizontal scroll
  - [ ] Buttons ≥44px tall; easy to tap
  - [ ] Error messages inline; not overlapping fields
  - [ ] Loading spinner visible during submit

#### 1.2 User & Role Assignment
- [ ] **Admin role**
  - [ ] Can create other users
  - [ ] Can change user roles
  - [ ] Can delete users (soft-delete or hard; verify behavior)
  - [ ] Sees full audit log
  - [ ] Cannot demote own admin role (if enforced)

- [ ] **Staff role**
  - [ ] Can view customers and appointments
  - [ ] Cannot create users or modify settings
  - [ ] Can only see tenant's data (RLS check)
  - [ ] Cannot view billing/payments (if restricted)

- [ ] **Customer role** (if applicable)
  - [ ] Portal login works
  - [ ] Can view own estimates/invoices
  - [ ] Cannot see other customers' data

#### 1.3 Integration with Onboarding Journey
- [ ] **Conversation flow**
  - [ ] Initial prompt appears
  - [ ] Each message populates a field
  - [ ] Clarifications work (e.g., "Did you mean X or Y?")
  - [ ] Conversation ends when requirements captured
  - [ ] Data persists if page refreshed

- [ ] **No data loss on reload**
  - [ ] Refresh mid-onboarding; data still there
  - [ ] Close and reopen; conversation resumable
  - [ ] Network error; graceful retry (not silent failure)

---

### 2. CUSTOMER MANAGEMENT

**Objective:** Customers added, tracked, and isolated per tenant

#### 2.1 Customer CRUD
- [ ] **Create customer**
  - [ ] Name field: accepts any string
  - [ ] Phone field: E.164 format enforced
  - [ ] Email: optional; must be valid if provided
  - [ ] Creates DB record (verify with `SELECT * FROM customer WHERE id = <id>`)
  - [ ] Tenant_id set correctly (RLS isolation)

- [ ] **Read customer**
  - [ ] List shows only this tenant's customers
  - [ ] Detail page loads without 401/403
  - [ ] All fields display correctly

- [ ] **Update customer**
  - [ ] Edit form pre-fills current values
  - [ ] Changing name/phone/email persists
  - [ ] Audit event logged (check audit table)
  - [ ] Other tenant cannot edit (403 error)

- [ ] **Delete customer** (if supported)
  - [ ] Soft-delete or hard-delete? Verify behavior
  - [ ] Appointments orphaned or cascade-deleted?
  - [ ] Audit event shows deletion

#### 2.2 Phone Validation
- [ ] **E.164 format enforced**
  - [ ] `+1-555-0123` rejected (hyphens)
  - [ ] `1555012345` rejected (no +)
  - [ ] `+15550123456` accepted
  - [ ] `+44123456789` accepted (international)
  - [ ] Error message clear: "Phone must be +[country][number]"

- [ ] **Duplicate detection**
  - [ ] Cannot create two customers with same phone (if enforced)
  - [ ] Error message: "Phone already exists"
  - [ ] Can merge duplicates (if feature exists)

#### 2.3 SMS Consent Tracking
- [ ] **SMS consent checkbox**
  - [ ] Visible on customer form
  - [ ] Defaults to unchecked (conservative)
  - [ ] Persists on save
  - [ ] Audit log shows consent change with timestamp

- [ ] **Consent enforced at SMS send**
  - [ ] SMS not sent if `smsConsent=false`
  - [ ] SMS queue rejects message (verify in queue table)
  - [ ] Error message: "Customer has not consented to SMS"

#### 2.4 DNC (Do Not Call) Integration
- [ ] **DNC list check**
  - [ ] `dncRepo.isOnDnc(tenantId, phone)` called on outbound
  - [ ] Calls rejected for DNC numbers (verify in logs)
  - [ ] Error message shown to user: "Number is on DNC list"

- [ ] **DNC list management** (if admin UI exists)
  - [ ] Can add numbers to DNC
  - [ ] Can remove numbers from DNC
  - [ ] List searchable

#### 2.5 Timezone Inference
- [ ] **Timezone detection**
  - [ ] On customer form, infer from phone country code (if implemented)
  - [ ] Manual timezone selection available
  - [ ] Timezone stored with customer record
  - [ ] Appointments render in customer timezone

- [ ] **Timezone use in scheduling**
  - [ ] Appointment at "2pm EST" shows in customer's timezone
  - [ ] If customer in PST, shows as "11am PST"
  - [ ] SMS/notification times respect timezone (no 3am SMS)

---

### 3. ESTIMATES & PROPOSALS

**Objective:** AI-drafted estimates flow through approval to execution

#### 3.1 Estimate Generation
- [ ] **Line items created**
  - [ ] AI returns 3–5 line items
  - [ ] Each has description + price + quantity
  - [ ] Total calculated correctly (sum of line×qty prices)

- [ ] **Price catalog validation** ⚠️ CRITICAL
  - [ ] Every line item checked against tenant catalog
  - [ ] Line NOT in catalog? Confidence score capped below auto-approve threshold
  - [ ] Uncatalogued lines require manual approval
  - [ ] Price matches catalog exactly (case-sensitive if applicable)

- [ ] **No floating-point money**
  - [ ] All prices in integer cents
  - [ ] No `123.45` or `99.9`; must be `12345` (cents)
  - [ ] Check DB: `SELECT price FROM line_item LIMIT 1;` (should be integer, not decimal)

- [ ] **Mobile estimate view**
  - [ ] Line items readable without horizontal scroll
  - [ ] Total price visible above fold
  - [ ] Approve/reject buttons ≥44px

#### 3.2 Estimate State Machine
- [ ] **Draft state**
  - [ ] Estimate created; shows "Draft"
  - [ ] Can edit line items (if allowed)
  - [ ] Can delete estimate
  - [ ] Cannot collect payment

- [ ] **Pending Approval state**
  - [ ] Customer sent approval link
  - [ ] Customer receives SMS/email notification (if consent=true)
  - [ ] Public link approval page works (no login required)
  - [ ] CSRF token present on form

- [ ] **Approved state**
  - [ ] Customer clicked "Approve" on link
  - [ ] Estimate locked; cannot change line items
  - [ ] Proceeds to execution
  - [ ] Audit event logged with customer ID

- [ ] **Executed state**
  - [ ] Invoice created from estimate
  - [ ] Line items copied to invoice
  - [ ] Prices match estimate exactly
  - [ ] Customer can view/pay invoice

#### 3.3 Approval Flow — Public Links
- [ ] **Unauthenticated approval**
  - [ ] Customer can approve without logging in
  - [ ] Link is long (≥32 chars) and unpredictable
  - [ ] Link works for ≥30 days (configurable)
  - [ ] After approval, link expires

- [ ] **CSRF protection**
  - [ ] Approve form has CSRF token
  - [ ] Cross-site POST to approval fails with 403
  - [ ] Token validated server-side before state change

- [ ] **Mobile approval**
  - [ ] Approve/reject buttons ≥44px
  - [ ] No horizontal scroll
  - [ ] After action, thank-you message shown (not silent)

#### 3.4 Confidence Scoring & Auto-Approval
- [ ] **High confidence (≥85%)**
  - [ ] All line items in catalog
  - [ ] No special handling needed
  - [ ] Auto-approve enabled? Executes immediately
  - [ ] Customer notified: "Approved and scheduled" (SMS if consent)

- [ ] **Low confidence (<85%)**
  - [ ] Uncatalogued items present
  - [ ] Manual approval required
  - [ ] Cannot auto-execute even if threshold passed
  - [ ] Waits for human approval

- [ ] **No missing catalog checks**
  - [ ] AI cannot invent prices not in catalog
  - [ ] If item not found, estimation blocked with clarification
  - [ ] Error message to user: "We need to add that service to your catalog first"

---

### 4. SCHEDULING & APPOINTMENTS

**Objective:** Appointments assigned to technicians; no double-booking

#### 4.1 Appointment Creation
- [ ] **Appointment record created**
  - [ ] Links to job/customer
  - [ ] Scheduled start/end times stored (UTC)
  - [ ] Duration calculated correctly
  - [ ] Status: "scheduled" (or similar)

- [ ] **Timezone handling**
  - [ ] Times stored in UTC
  - [ ] Customer sees appointment in their timezone
  - [ ] SMS notification sent in customer TZ (not 3am)

#### 4.2 Double-Booking Prevention ⚠️ CRITICAL
- [ ] **DB exclusion constraint enforced**
  - [ ] Attempt to assign same tech to overlapping times → DB error
  - [ ] Error message to user: "Technician unavailable during this time"
  - [ ] Appointment NOT created
  - [ ] Verify constraint in schema: `ALTER TABLE appointment_assignments ADD EXCLUDE (tenant_id WITH =, technician_id WITH =, tsrange(scheduled_start, scheduled_end) WITH &&)`

- [ ] **No race conditions**
  - [ ] Rapid double-click on "Assign Technician" → only one assignment
  - [ ] Two API calls simultaneously → DB constraint prevents both
  - [ ] Audit shows only successful assignment

#### 4.3 Technician Availability
- [ ] **Working hours respected**
  - [ ] Cannot schedule before 8am or after 6pm (or tenant config)
  - [ ] Cannot schedule on off days (if configured)
  - [ ] Error message: "Outside working hours"

- [ ] **Travel time calculated**
  - [ ] Distance between jobs computed
  - [ ] Travel time deducted from available window
  - [ ] If no time for travel, error shown
  - [ ] Example: Job 1 ends 2pm, 30min travel, Job 2 starts 2:45pm → conflict

#### 4.4 Rescheduling
- [ ] **Reschedule appointment**
  - [ ] Can change appointment time
  - [ ] Technician assignment updated
  - [ ] Old assignment removed (not orphaned in DB)
  - [ ] New time checked for conflicts (no double-booking)
  - [ ] Audit event logged: "Rescheduled from 2pm to 3pm"

- [ ] **Customer notification**
  - [ ] SMS sent if reschedule confirmed (and consent=true)
  - [ ] Shows old time and new time
  - [ ] Clear direction: "Your appointment has been moved to 3pm"

---

### 5. VOICE (Real-Time AI Calling)

**Objective:** Technician calls customer; AI handles call; orders result

#### 5.1 Outbound Call Initiation
- [ ] **Technician can start call**
  - [ ] "Call customer" button appears
  - [ ] Button disabled if no phone number (grayed out)
  - [ ] Clicking initiates API call

- [ ] **Call routing**
  - [ ] Twilio SDK receives request
  - [ ] Technician's number appears as caller ID
  - [ ] Customer's phone rings
  - [ ] Call connected; technician and customer hear each other

#### 5.2 TCPA/DNC Compliance ⚠️ CRITICAL
- [ ] **DNC check before dial**
  - [ ] On call initiation, check `dncRepo.isOnDnc(tenantId, customerPhone)`
  - [ ] If true, block call with error: "Number is on DNC list"
  - [ ] Never attempt dial
  - [ ] Audit log: "Call blocked: DNC number"

- [ ] **Quiet hours enforcement**
  - [ ] No calls 9pm–8am in customer timezone
  - [ ] Check customer timezone; no exceptions
  - [ ] If call initiated outside quiet hours, error shown
  - [ ] Audit log: "Call blocked: Outside quiet hours (PST)"

- [ ] **SMS consent check**
  - [ ] Before outbound call, verify `smsConsent=true` (or configurable)
  - [ ] If consent=false, offer option to send SMS notification first
  - [ ] If customer doesn't consent to SMS, still allow call (configurable)

#### 5.3 AI Intent Recognition
- [ ] **Voice input parsed**
  - [ ] Customer says: "We need a water heater replacement"
  - [ ] AI recognizes: intent=`estimate_request`, detail=`water_heater_replacement`
  - [ ] AI responds: "I can help with that. Let me get some details..."

- [ ] **Multi-turn conversation**
  - [ ] AI asks clarifying questions
  - [ ] Customer provides answers
  - [ ] Context maintained across turns
  - [ ] No repetition (AI doesn't ask same question twice)

#### 5.4 Slot Filling
- [ ] **Required data captured**
  - [ ] Appointment time: customer provides; AI confirms
  - [ ] Service type: customer describes; AI extracts category
  - [ ] Any special requests: AI notes them
  - [ ] All fields captured before estimate generation

- [ ] **Confirmation step**
  - [ ] AI summarizes: "So we're scheduling a water heater replacement on Thursday at 2pm?"
  - [ ] Customer confirms
  - [ ] Estimate generated and sent to customer

#### 5.5 Call Recording & Encryption ⚠️ CRITICAL
- [ ] **Recording stored**
  - [ ] Call recorded by Twilio
  - [ ] Stored in encrypted vault (not plaintext)
  - [ ] Audit log: "Call recorded and encrypted"

- [ ] **Transcript generated**
  - [ ] Speech-to-text creates transcript
  - [ ] Transcript encrypted at rest
  - [ ] Accessible only to technician/admin
  - [ ] PII masked in logs (not in raw transcript)

#### 5.6 Proposal Execution from Call
- [ ] **Estimate auto-approved**
  - [ ] If confidence ≥85% and all catalog items valid
  - [ ] Estimate state: Draft → Approved → Executed
  - [ ] Invoice created immediately
  - [ ] Customer notified (SMS if consent)

- [ ] **Manual approval flow**
  - [ ] If confidence <85%, estimate sent for approval
  - [ ] Customer receives link
  - [ ] Customer approves/rejects
  - [ ] Audit trail preserved

---

### 6. SMS & COMMUNICATIONS

**Objective:** SMS sent only to consenting, non-DNC customers

#### 6.1 SMS Send
- [ ] **Queue submission**
  - [ ] SMS message added to queue
  - [ ] Recipient phone validated (E.164)
  - [ ] Message content stored in DB

- [ ] **DNC check at queue time**
  - [ ] Before sending, check if phone on DNC
  - [ ] If yes, mark as "blocked" (don't attempt send)
  - [ ] Audit log: "SMS blocked: DNC number"
  - [ ] Error shown to user

- [ ] **Delivery tracking**
  - [ ] Twilio webhook received (delivery confirmed)
  - [ ] DB updated: `sms.status = 'delivered'`
  - [ ] If delivery fails, retry logic (check if present)
  - [ ] Failed SMS logged; alert admin if threshold reached

#### 6.2 Inbox Management
- [ ] **Incoming SMS appears**
  - [ ] Customer replies to SMS
  - [ ] Appears in inbox immediately
  - [ ] Linked to conversation thread (if threaded)
  - [ ] Technician can read and reply

- [ ] **Message threading**
  - [ ] Customer ↔ Tech conversation coherent
  - [ ] Each message shows sender name (not just phone)
  - [ ] Timestamps correct
  - [ ] No duplicate messages

#### 6.3 Consent Enforcement
- [ ] **SMS not sent if consent=false**
  - [ ] Manual attempt to send SMS → error
  - [ ] Automated SMS blocked at queue level
  - [ ] No SMS in queue or delivery logs
  - [ ] User notified: "Customer has opted out of SMS"

- [ ] **Consent change tracked**
  - [ ] Customer opts out → audit event logged
  - [ ] Customer opts in → audit event logged
  - [ ] Timestamp recorded
  - [ ] Admin can see history

---

### 7. PAYMENTS & BILLING

**Objective:** All payments tracked correctly; no double-charges; money type correct

#### 7.1 Stripe Integration
- [ ] **Payment link generated**
  - [ ] Invoice has "Pay Now" link
  - [ ] Link goes to Stripe checkout
  - [ ] Amount correct (matches invoice total)

- [ ] **Money stored as cents, not float** ⚠️ CRITICAL
  - [ ] Invoice amount: 10000 (not 100.00)
  - [ ] Stripe receives: 10000 cents = $100.00
  - [ ] DB type: INTEGER or BIGINT (not DECIMAL)
  - [ ] Verify: `SELECT money_type FROM information_schema.columns WHERE table_name='invoice' AND column_name='amount'`

- [ ] **Stripe charge succeeds**
  - [ ] Customer completes payment
  - [ ] Stripe returns success webhook
  - [ ] Invoice status: Paid
  - [ ] No error stacks returned to customer

#### 7.2 Webhook Idempotency ⚠️ CRITICAL BUG RISK
- [ ] **Double-payment webhook handling**
  - [ ] Simulate Stripe sending payment webhook twice (same event ID)
  - [ ] First webhook: Invoice marked paid; audit logged
  - [ ] Second webhook: No duplicate payment applied
  - [ ] Verify DB: Only one payment record created
  - [ ] Idempotency key check: `SELECT * FROM webhook_events WHERE idempotency_key = <key>`

- [ ] **Reconciliation correct**
  - [ ] Customer paid once
  - [ ] Financial reports show single payment (not double)
  - [ ] Stripe balance matches DB balance (within cent tolerance)

#### 7.3 Invoice State Machine
- [ ] **Draft → Sent**
  - [ ] Invoice created (Draft)
  - [ ] Send to customer (state → Sent)
  - [ ] Cannot revert to Draft

- [ ] **Sent → Paid**
  - [ ] Customer pays
  - [ ] Webhook received
  - [ ] Invoice state → Paid
  - [ ] Cannot reverse to Sent (or explicit void only)

- [ ] **No state-skipping**
  - [ ] Cannot jump Draft → Paid (must go through Sent)
  - [ ] DB constraint enforces state transitions (if present)
  - [ ] State machine verified in code

#### 7.4 Void Invalidation
- [ ] **Void invoice kills payment links**
  - [ ] Invoice has unpaid payment link
  - [ ] Admin voids invoice
  - [ ] Payment link expires immediately
  - [ ] Customer cannot pay via old link (404 or expired error)
  - [ ] Audit log: "Invoice voided; payment link invalidated"

#### 7.5 Paid State Rejection
- [ ] **Cannot accept payment on paid invoice**
  - [ ] Invoice status: Paid
  - [ ] Attempt to send payment webhook → rejected
  - [ ] DB: No second payment record created
  - [ ] Audit log: "Payment attempt on paid invoice; rejected"

#### 7.6 Refunds
- [ ] **Full refund**
  - [ ] Original invoice: $100
  - [ ] Process full refund
  - [ ] Refunded amount: $100 (not over)
  - [ ] Invoice status: Refunded
  - [ ] DB: Refund record linked to invoice

- [ ] **Partial refund**
  - [ ] Original invoice: $100
  - [ ] Process $30 partial refund
  - [ ] Refunded amount: $30 (exactly)
  - [ ] Remaining balance: $70
  - [ ] Invoice status: Partially Refunded

- [ ] **No refund over original**
  - [ ] Attempt to refund $110 against $100 invoice → error
  - [ ] Error message: "Refund exceeds invoice amount"
  - [ ] No refund applied

#### 7.7 Tax Calculation
- [ ] **Tax computed correctly**
  - [ ] Subtotal: $100
  - [ ] Tax rate: 8.5%
  - [ ] Tax amount: $8.50 (not $8.49 or $8.51 due to rounding)
  - [ ] Total: $108.50
  - [ ] Verify rounding rules in code (ROUND_HALF_UP or similar)

- [ ] **Tax persisted**
  - [ ] Tax amount stored in DB
  - [ ] Refund adjusts tax proportionally
  - [ ] Audit shows tax amount

#### 7.8 Row-Level Security (RLS)
- [ ] **Customer sees own invoices only**
  - [ ] Login as Customer A
  - [ ] GET `/invoices` → only Customer A's invoices
  - [ ] Attempt GET `/invoices?customer_id=<Other>` → 403 Forbidden
  - [ ] DB policy: `SELECT * FROM invoice WHERE tenant_id = auth.claims.tenant_id`

- [ ] **Staff sees tenant invoices**
  - [ ] Login as Staff (same tenant as Customer)
  - [ ] GET `/invoices` → all invoices for tenant
  - [ ] See Customer A's and Customer B's invoices
  - [ ] Cannot see other tenant's invoices (403)

---

### 8. DATA ISOLATION & SECURITY

**Objective:** Tenant data hermetically sealed; no leaks; no unauth access

#### 8.1 Row-Level Security
- [ ] **Tenant isolation enforced**
  - [ ] Every table has `tenant_id` column
  - [ ] RLS policy: `SELECT * FROM table WHERE tenant_id = auth.claims.tenant_id`
  - [ ] Staff from Tenant A cannot read Tenant B data (403)
  - [ ] API filters by tenant_id on every query
  - [ ] Verify: `SELECT count(*) FROM pg_policies WHERE schemaname = 'public'` (should be >0)

- [ ] **Public tables exempt**
  - [ ] Some tables (e.g., `public_estimate_template`) don't have RLS
  - [ ] Verify intentional (not oversight)
  - [ ] Document in code comments

#### 8.2 Unauthenticated Endpoints
- [ ] **Public estimate approval**
  - [ ] No auth required
  - [ ] Link-based access (token in URL)
  - [ ] Cannot access other estimates via ID guessing (token prevents)

- [ ] **Health checks**
  - [ ] GET `/health` → returns 200, no auth required
  - [ ] GET `/ready` → returns 200 or 503, no auth required
  - [ ] Both safe to expose (no data leakage)

- [ ] **All other endpoints protected**
  - [ ] GET `/customers` → 401 without token
  - [ ] POST `/invoices` → 401 without token
  - [ ] No accidental public endpoints

#### 8.3 Metrics Endpoint
- [ ] **Requires METRICS_SECRET token**
  - [ ] GET `/metrics` without token → 403 Forbidden
  - [ ] GET `/metrics?token=xyz` → 200 OK (if token correct)
  - [ ] Token not in URL if possible (use header)
  - [ ] Token not logged in access logs

#### 8.4 Logs & PII
- [ ] **No PII in structured logs**
  - [ ] Customer phone not logged (or masked as +1****6789)
  - [ ] Customer email not logged (or masked)
  - [ ] Invoice amounts OK to log (not PII)
  - [ ] Verify: `grep -r "phone\|email" logs/ | grep -v masked` (should be empty or documented)

- [ ] **Sensitive data masked**
  - [ ] API tokens: show only last 4 chars (e.g., `sk_live_****abc123`)
  - [ ] Passwords: never logged, even on error
  - [ ] Credit card numbers: never logged (Stripe handles)

- [ ] **Database credentials**
  - [ ] Not in logs
  - [ ] Not in error messages
  - [ ] Not in stack traces
  - [ ] Verify: `grep -r "postgresql://\|DATABASE_URL" logs/` (should be empty)

#### 8.5 CSRF Protection
- [ ] **Public links have CSRF token**
  - [ ] Estimate approval form includes hidden `_csrf` field
  - [ ] Token validated server-side before state change
  - [ ] Cross-site POST without token → 403

- [ ] **API endpoints use SameSite cookies**
  - [ ] Cookies set with `SameSite=Lax` or `Strict`
  - [ ] Verify: Check response headers `Set-Cookie`
  - [ ] Or use API tokens (Bearer scheme) instead

---

### 9. AUDIT & COMPLIANCE

**Objective:** Every mutation logged; full trail for disputes/audits

#### 9.1 Mutation Audit Events
- [ ] **Create events**
  - [ ] Create customer → audit event logged
  - [ ] Event contains: user ID, customer ID, timestamp, "created"
  - [ ] Audit table: `SELECT * FROM audit_log WHERE entity_type='customer' AND action='created'`

- [ ] **Update events**
  - [ ] Change customer phone → audit event
  - [ ] Shows old value and new value
  - [ ] Timestamp precise (to second or millisecond)

- [ ] **Delete events**
  - [ ] Soft-delete customer → audit event
  - [ ] Event shows user who deleted
  - [ ] Cannot alter/delete audit records (immutable)

#### 9.2 Payment Audit Trail
- [ ] **Payment events**
  - [ ] Payment succeeded: audit logged with amount, invoice ID
  - [ ] Payment failed: audit logged with reason (Stripe error)
  - [ ] Refund processed: audit logged with refund amount

- [ ] **Webhook events**
  - [ ] Stripe webhook received: audit logged with event ID
  - [ ] Webhook processed: timestamp logged
  - [ ] Webhook errors: logged with full error message

#### 9.3 User Action Logging
- [ ] **Estimate approval**
  - [ ] Customer approves via public link → audit: who (customer email or ID), when
  - [ ] Cannot falsify approval source
  - [ ] IP address logged (if applicable)

- [ ] **Estimate rejection**
  - [ ] Customer rejects → audit logged

#### 9.4 Data Retention
- [ ] **Logs kept ≥90 days**
  - [ ] Verify DB configuration or S3 retention policy
  - [ ] Older logs archived (not deleted immediately)
  - [ ] Audit query for logs older than 90 days succeeds

#### 9.5 Audit Log Transparency
- [ ] **Admin sees audit log**
  - [ ] Dashboard or report shows all mutations
  - [ ] Can filter by date, user, entity type
  - [ ] Cannot edit or delete audit entries
  - [ ] Export to CSV/JSON for external audit

---

### 10. UI/UX (Mobile-First)

**Objective:** App works on 320px width; all buttons ≥44px

#### 10.1 Mobile Responsiveness
- [ ] **No horizontal scroll at 320px**
  - [ ] Open web app in mobile browser or Chrome DevTools (320px)
  - [ ] Scroll only vertically
  - [ ] Text readable (not crammed)
  - [ ] Forms fit without scroll

- [ ] **Text readable**
  - [ ] Font size ≥14px (standard)
  - [ ] Line height ≥1.5 (breathing room)
  - [ ] Contrast ≥4.5:1 (WCAG AA)

- [ ] **Images responsive**
  - [ ] Images scale to fit container
  - [ ] No blurry or stretched images
  - [ ] Max-width: 100% applied

#### 10.2 Tap Targets
- [ ] **Buttons ≥44px**
  - [ ] Measure: inspect element, check height
  - [ ] All buttons: Approve, Reject, Submit, etc.
  - [ ] Links with action purpose (not plain text links)
  - [ ] Padding around icons (not just 20px icon in center)

- [ ] **Spacing between targets**
  - [ ] Minimum 8px gap between clickable elements
  - [ ] Prevents mis-taps
  - [ ] Especially important on mobile

#### 10.3 Dark Mode
- [ ] **Light theme**
  - [ ] Text readable on background
  - [ ] Buttons contrast visible
  - [ ] No harsh white (consider off-white)

- [ ] **Dark theme**
  - [ ] Text readable on dark background
  - [ ] Buttons contrast visible
  - [ ] No harsh black
  - [ ] Smooth transition between themes (no flash)

#### 10.4 Loading States
- [ ] **Spinner visible**
  - [ ] Submit form → spinner appears
  - [ ] User knows request in progress
  - [ ] Button disabled during loading (prevents double-submit)

- [ ] **Skeleton screens**
  - [ ] List loading → skeleton placeholders show
  - [ ] Prevents flash of "no data"
  - [ ] Graceful transition to real content

#### 10.5 Error Handling
- [ ] **User-facing errors**
  - [ ] Error message clear: "Phone number invalid; use +[country][number]"
  - [ ] Not: "ValidationError: invalid_phone_format"
  - [ ] No stack traces shown

- [ ] **Network errors**
  - [ ] Connection lost → message shown
  - [ ] Retry option provided
  - [ ] Not silent failure (user doesn't wonder if submitted)

#### 10.6 Form UX
- [ ] **Required fields marked**
  - [ ] Asterisk (*) or "required" label
  - [ ] Consistent style across all forms

- [ ] **Validation inline**
  - [ ] Error appears below field (not as pop-up)
  - [ ] On blur or submit (not on every keystroke)
  - [ ] Clears when user corrects value

- [ ] **Focus management**
  - [ ] Tab order logical
  - [ ] Focus visible (blue outline or similar)
  - [ ] Mobile keyboard appropriate (email field → email keyboard)

---

### 11. PERFORMANCE

**Objective:** App feels fast; no bottlenecks

#### 11.1 Page Load Time
- [ ] **Initial HTML + CSS < 3s (4G)**
  - [ ] Open DevTools → Network tab
  - [ ] Load home page
  - [ ] Time to Interactive < 3s
  - [ ] Check Core Web Vitals: LCP < 2.5s

#### 11.2 API Response Time
- [ ] **Endpoints < 1s (p95)**
  - [ ] GET /customers → < 500ms
  - [ ] POST /estimates → < 1000ms
  - [ ] Check logs or APM tool for response times
  - [ ] No endpoints > 2s (unless async job)

#### 11.3 Database Queries
- [ ] **No N+1 queries**
  - [ ] Fetch 10 customers → 1 DB query (not 11)
  - [ ] Use `JOIN` or batch loading
  - [ ] Check query logs or APM

- [ ] **Indexes used**
  - [ ] Query on `tenant_id` → index present
  - [ ] Query on `created_at` → index present
  - [ ] EXPLAIN ANALYZE shows seq scans minimized

#### 11.4 Memory Leaks
- [ ] **No unbounded memory growth**
  - [ ] Run server 1 hour
  - [ ] Monitor RSS memory
  - [ ] Should be stable (not increasing 100MB/min)
  - [ ] If growing, identify leak (EventEmitter, timers, etc.)

- [ ] **Worker GC working**
  - [ ] Long-running workers don't leak
  - [ ] Garbage collection runs regularly
  - [ ] Node.js `--max-old-space-size` not exceeded

---

### 12. DEPLOYMENT & INFRASTRUCTURE

**Objective:** App deployable; can restart; migrations work

#### 12.1 Docker Build
- [ ] **Builds without errors**
  - [ ] `docker build -f Dockerfile -t serviceos-api .`
  - [ ] No warnings (or only accepted warnings)
  - [ ] Builds in < 5 minutes

- [ ] **Railway.toml config correct**
  - [ ] Refers to correct Dockerfile
  - [ ] Service names match deployment targets
  - [ ] Environment variables listed

#### 12.2 Database Migrations
- [ ] **Latest migrations applied**
  - [ ] Check migration version: `SELECT * FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 1`
  - [ ] Timestamp recent (today or yesterday)

- [ ] **Rollback doesn't crash**
  - [ ] If revert needed, migrations can roll back (if supported)
  - [ ] No data loss on rollback
  - [ ] Verify rollback plan documented

#### 12.3 Environment Configuration
- [ ] **All required vars in .env.example**
  - [ ] `.env.example` lists every var
  - [ ] Missing var → clear error message (not cryptic)
  - [ ] Check startup logs for env warnings

#### 12.4 Health Checks
- [ ] **GET /health responds**
  - [ ] Status code: 200
  - [ ] Body: `{status: "ok", version: "...", environment: "..."}` (or similar)
  - [ ] No authentication required

- [ ] **GET /ready responds**
  - [ ] Status code: 200 (if healthy) or 503 (if not)
  - [ ] Body: `{status: "ready"}` or error details
  - [ ] Checks DB connectivity
  - [ ] Used by load balancer for routing

#### 12.5 Graceful Shutdown
- [ ] **Worker drains tasks**
  - [ ] Send SIGTERM to worker
  - [ ] Worker stops accepting new tasks
  - [ ] Waits for in-flight tasks to complete
  - [ ] Exits cleanly (not killed by timeout)

- [ ] **Database connections closed**
  - [ ] On shutdown, all DB connections close
  - [ ] No "stale connection" errors
  - [ ] Can restart without connection pooling issues

---

## Test Results Submission

After completing above, fill in this table:

| Category | Status | Notes |
|---|---|---|
| **Provisioning & Onboarding** | ✅ PASS / ⚠️ PARTIAL / ❌ FAIL | |
| **Customer Management** | ✅ PASS / ⚠️ PARTIAL / ❌ FAIL | |
| **Estimates & Proposals** | ✅ PASS / ⚠️ PARTIAL / ❌ FAIL | |
| **Scheduling & Appointments** | ✅ PASS / ⚠️ PARTIAL / ❌ FAIL | |
| **Voice (AI Calling)** | ✅ PASS / ⚠️ PARTIAL / ❌ FAIL | |
| **SMS & Communications** | ✅ PASS / ⚠️ PARTIAL / ❌ FAIL | |
| **Payments & Billing** | ✅ PASS / ⚠️ PARTIAL / ❌ FAIL | |
| **Data Isolation & Security** | ✅ PASS / ⚠️ PARTIAL / ❌ FAIL | |
| **Audit & Compliance** | ✅ PASS / ⚠️ PARTIAL / ❌ FAIL | |
| **UI/UX (Mobile-First)** | ✅ PASS / ⚠️ PARTIAL / ❌ FAIL | |
| **Performance** | ✅ PASS / ⚠️ PARTIAL / ❌ FAIL | |
| **Deployment & Infrastructure** | ✅ PASS / ⚠️ PARTIAL / ❌ FAIL | |

---

## Regressions This Run

If any category shows FAIL or PARTIAL that was PASS last run:

| Feature | Last Run | This Run | Root Cause | Action |
|---|---|---|---|---|
| | | | | |

---

## Sign-Off

**QA Coordinator:** _______________  
**Date:** _______________  
**Approved for Production?** ☐ YES ☐ NO (if NO, list blockers above)
