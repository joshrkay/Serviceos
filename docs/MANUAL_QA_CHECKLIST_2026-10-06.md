# Manual QA Checklist — 2026-10-06
## Code-Level Verification (No Live Credentials Required)

**Purpose**: Verify critical application behavior that can be tested without Clerk, Stripe, Twilio, or LLM credentials.  
**Scope**: Database schemas, API contracts, UI component logic, state machines, error handling  
**Tester**: Claude Haiku 4.5  
**Execution Date**: 2026-10-06  

---

## Phase 1: Code & Schema Verification

### 1.1 Database Schema Integrity
**Goal**: Verify core tables exist with correct columns and constraints

- [ ] **Customers table**
  - [ ] Columns: id, tenant_id, name, phone, email, address, created_at, updated_at
  - [ ] Constraint: RLS policy on tenant_id
  - [ ] Constraint: Unique phone per tenant (if enforced)
  - [ ] Index on (tenant_id, phone) for lookup speed

- [ ] **Estimates table**
  - [ ] Columns: id, tenant_id, customer_id, job_id, total_cents, tax_cents, status, created_at, updated_at
  - [ ] Constraint: RLS on tenant_id
  - [ ] Constraint: status must be one of [DRAFT, SENT, APPROVED, DECLINED, EXPIRED]
  - [ ] Constraint: total_cents >= 0 (not negative)
  - [ ] Foreign key: customer_id → customers(id)

- [ ] **Invoices table**
  - [ ] Columns: id, tenant_id, customer_id, estimate_id, total_cents, tax_cents, status, created_at, due_date, updated_at
  - [ ] Constraint: RLS on tenant_id
  - [ ] Constraint: status in [DRAFT, SENT, PAID, OVERDUE, VOIDED]
  - [ ] Constraint: Cannot void a PAID invoice (enforced via status machine)
  - [ ] Constraint: due_date must be >= created_date

- [ ] **Payments table**
  - [ ] Columns: id, tenant_id, invoice_id, stripe_payment_intent_id, amount_cents, created_at, status
  - [ ] Constraint: RLS on tenant_id
  - [ ] Constraint: amount_cents must be positive
  - [ ] Index on (stripe_payment_intent_id) for idempotency

- [ ] **Appointments table**
  - [ ] Columns: id, tenant_id, customer_id, scheduled_at, service_type, technician_id, status, created_at
  - [ ] Constraint: RLS on tenant_id
  - [ ] Constraint: scheduled_at must be in future
  - [ ] Constraint: status in [PENDING, CONFIRMED, CANCELLED, COMPLETED]

- [ ] **Jobs table**
  - [ ] Columns: id, tenant_id, customer_id, appointment_id, status, created_at, completed_at
  - [ ] Constraint: RLS on tenant_id
  - [ ] Constraint: status in [SCHEDULED, IN_PROGRESS, COMPLETED, INVOICED]
  - [ ] Constraint: completed_at must be >= created_at

### 1.2 Money Precision Verification
**Goal**: Verify all financial calculations use integer cents (no floats)

- [ ] **Estimate Calculation**
  - [ ] Line item prices stored as integers (cents)
  - [ ] Subtotal = SUM(line_item_prices) — calculated in database
  - [ ] Tax calculation: integer result (ROUND(subtotal * tax_rate / 10000))
  - [ ] Total = subtotal + tax + fees — no float intermediate values

- [ ] **Invoice Calculation**
  - [ ] Line items copied from estimate as integer cents
  - [ ] Deposit amount stored as integer
  - [ ] Balance due = total - deposit (integer arithmetic)
  - [ ] Partial payments handled: remaining_balance = balance - payment_amount

- [ ] **Payment Processing**
  - [ ] Stripe amount in cents (correct: amount_cents = total * 100)
  - [ ] No rounding errors when converting to Stripe currency (cents)
  - [ ] Webhook payment amount matches database record exactly

### 1.3 Row-Level Security (RLS) Verification
**Goal**: Confirm tenant isolation is enforced at database layer

- [ ] **RLS Policy Audit** (each table checked)
  - [ ] SELECT policy: `WHERE tenant_id = current_user_tenant`
  - [ ] INSERT policy: `WITH CHECK (tenant_id = current_user_tenant)`
  - [ ] UPDATE policy: `USING (tenant_id = current_user_tenant)`
  - [ ] DELETE policy: `USING (tenant_id = current_user_tenant)`
  - [ ] Policy enabled: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`

- [ ] **Tables with RLS Enforced**:
  - [ ] customers
  - [ ] estimates
  - [ ] invoices
  - [ ] payments
  - [ ] appointments
  - [ ] jobs
  - [ ] leads
  - [ ] conversations
  - [ ] audit_logs
  - [ ] business_settings

### 1.4 Audit Trail Verification
**Goal**: Confirm all mutations are recorded

- [ ] **Audit Table**
  - [ ] Columns: id, tenant_id, entity_type, entity_id, action (CREATE/UPDATE/DELETE), user_id, changes (jsonb), created_at
  - [ ] Every INSERT/UPDATE/DELETE on core tables → audit_logs entry
  - [ ] RLS enforced on audit_logs (tenant_id)

- [ ] **Mutation Triggers** (sampled)
  - [ ] Create invoice → audit log with full payload
  - [ ] Update invoice status → audit log with old/new values
  - [ ] Void invoice → audit log with reason
  - [ ] Process payment → audit log with stripe_payment_intent_id

---

## Phase 2: API Contract Verification

### 2.1 Invoice API Contracts
**Goal**: Verify API responses match contract (no missing fields, correct types)

**Sample Endpoints Checked**:

- [ ] `POST /api/invoices` (Create Invoice)
  - Request validation: All required fields present (customer_id, items, total)
  - Response: 201 with invoice object including (id, tenant_id, status, total_cents, tax_cents, created_at)
  - Response: 400 if total_cents < 0
  - Response: 400 if tax_cents > total_cents (sanity check)

- [ ] `GET /api/invoices/:id` (Get Invoice Details)
  - Response: 200 with full invoice + line items
  - Response: 403 if invoice belongs to different tenant
  - Response: 404 if invoice doesn't exist

- [ ] `PATCH /api/invoices/:id` (Update Invoice Status)
  - Request: { status: "PAID" | "VOIDED" | ... }
  - Allowed transitions: DRAFT→SENT, SENT→PAID, SENT→VOIDED
  - Rejected transitions: PAID→VOIDED (returns 400 with reason)
  - Response: 200 with updated invoice

- [ ] `GET /api/invoices` (List Invoices)
  - Query filters: status, date_range, customer_id
  - Pagination: ?page=1&limit=20
  - Response: 200 with array of invoices (sorted by created_at DESC)
  - Response: Only invoices belonging to authenticated tenant

### 2.2 Estimate API Contracts
**Goal**: Verify estimate creation, approval, and pricing

- [ ] `POST /api/estimates` (Create Estimate)
  - Request validation: customer_id, items (array with description, qty, price_cents), status
  - Response: 201 with estimate including confidence score
  - Validation: All prices are integers (no floats in request)

- [ ] `PATCH /api/estimates/:id/approve` (Approve Estimate)
  - Request: { customer_consent: true, signature: "...", address: "..." }
  - Response: 200, estimate.status = "APPROVED"
  - Side effect: Job record created (if not exists)
  - Side effect: Audit log entry for approval

- [ ] `GET /api/estimates/:id/public` (Public Approval Page)
  - No auth required (public link)
  - Response: 200 with estimate details
  - Response: 404 if link expired (not yet implemented — just verify 404 vs. 200)

### 2.3 Payment API Contracts
**Goal**: Verify payment webhooks and tracking

- [ ] `POST /api/payments/webhook/stripe` (Stripe Webhook)
  - Signature verification: Webhook signature matches Stripe secret
  - Idempotency: Same webhook received twice → payment recorded once (idempotency key check)
  - Event: `payment_intent.succeeded` → Invoice marked PAID
  - Event: `payment_intent.payment_failed` → Error logged, invoice still SENT

---

## Phase 3: State Machine Verification

### 3.1 Invoice State Machine
**Goal**: Verify valid transitions and rejections

**Valid Transitions** (all should be possible):
- [ ] DRAFT → SENT (when invoice emailed/sent to customer)
- [ ] DRAFT → VOIDED (if not yet sent)
- [ ] SENT → PAID (when payment received)
- [ ] SENT → OVERDUE (when past due date and unpaid)
- [ ] SENT → VOIDED (with audit trail)
- [ ] OVERDUE → PAID (when payment finally received)
- [ ] PARTIAL_PAID → PAID (remaining payment received)

**Invalid Transitions** (all should be REJECTED):
- [ ] ❌ PAID → VOIDED (returns error: "Cannot void paid invoice")
- [ ] ❌ PAID → SENT (returns error: "Cannot resend paid invoice")
- [ ] ❌ VOIDED → PAID (returns error: "Cannot pay voided invoice")

### 3.2 Estimate State Machine
**Goal**: Verify estimate approval flow and expiration

**Valid Transitions**:
- [ ] DRAFT → SENT (email to customer)
- [ ] DRAFT → CANCELLED (before sending)
- [ ] SENT → APPROVED (customer accepts)
- [ ] SENT → DECLINED (customer rejects)
- [ ] SENT → EXPIRED (after 30 days)
- [ ] APPROVED → INVOICED (when invoice created from estimate)

**Invalid Transitions**:
- [ ] ❌ APPROVED → DECLINED (estimate already approved)
- [ ] ❌ EXPIRED → APPROVED (link expired)

### 3.3 Appointment State Machine
**Goal**: Verify appointment booking and confirmation

**Valid Transitions**:
- [ ] PENDING → CONFIRMED (customer confirms via SMS)
- [ ] PENDING → CANCELLED (no show, rescheduled)
- [ ] CONFIRMED → COMPLETED (job finished)
- [ ] CONFIRMED → CANCELLED (after start time)

---

## Phase 4: Data Integrity & Constraints

### 4.1 Foreign Key Integrity
**Goal**: Verify no orphaned records

- [ ] Estimate → Customer
  - [ ] Every estimate has valid customer_id (no orphans)
  - [ ] Cannot delete customer with open estimates

- [ ] Invoice → Customer
  - [ ] Every invoice has valid customer_id
  - [ ] Cannot delete customer with unpaid invoices

- [ ] Job → Appointment
  - [ ] Every job has valid appointment_id or NULL
  - [ ] Deleting appointment cascades or prevents delete

### 4.2 Numeric Constraints
**Goal**: Verify financial calculations don't allow negative/invalid values

- [ ] Estimate totals
  - [ ] total_cents >= 0 (cannot be negative)
  - [ ] tax_cents >= 0
  - [ ] subtotal_cents = SUM(items.price_cents)

- [ ] Invoice totals
  - [ ] total_cents >= 0
  - [ ] balance_due = total_cents - paid_cents
  - [ ] balance_due >= -100 (allow 1 cent overpayment rounding)

- [ ] Payment amounts
  - [ ] amount_cents > 0 (at least 1 cent)
  - [ ] amount_cents <= invoice.balance_due (cannot pay more than due)

### 4.3 Date Constraints
**Goal**: Verify timezone handling and date validity

- [ ] Appointment scheduling
  - [ ] scheduled_at must be in future (no past appointments)
  - [ ] scheduled_at stored as UTC in database
  - [ ] Timezone conversion applied on read (render in tenant timezone)

- [ ] Invoice due dates
  - [ ] due_date >= created_at (due date must be after creation)
  - [ ] overdue_at = due_date (computed on read, not stored)

---

## Phase 5: Error Handling & Validation

### 5.1 Input Validation
**Goal**: Verify required fields and format checks

- [ ] Customer creation
  - [ ] name required (cannot create without)
  - [ ] phone required and validated (E.164 format)
  - [ ] email optional but validated if provided
  - [ ] address optional but validated if provided

- [ ] Estimate creation
  - [ ] customer_id required
  - [ ] items array required (minimum 1)
  - [ ] item.description required
  - [ ] item.price_cents required and integer
  - [ ] item.quantity required and positive

- [ ] Invoice creation
  - [ ] customer_id required
  - [ ] total_cents required
  - [ ] Cannot create invoice without line items

### 5.2 Error Response Format
**Goal**: Verify all error responses are consistent

- [ ] Error response structure
  - [ ] All errors have { error: "...", code: "...", details: "..." }
  - [ ] No raw exception messages leaked (no stack traces)
  - [ ] HTTP status codes are semantic (400 for validation, 403 for forbidden, 404 for not found)

- [ ] Sample error scenarios
  - [ ] 400: POST /api/invoices without required fields
  - [ ] 403: GET /api/invoices/uuid (belongs to different tenant)
  - [ ] 404: GET /api/estimates/invalid-uuid
  - [ ] 409: POST /api/invoices (duplicate idempotency key)

### 5.3 Concurrency & Race Conditions
**Goal**: Verify duplicate submissions and stale data handling

- [ ] Idempotency keys
  - [ ] POST /api/invoices with idempotency-key header
  - [ ] Same key sent twice → second request returns 200 with same invoice (not 201)
  - [ ] No double-charging scenario possible

- [ ] Optimistic locking
  - [ ] PATCH /api/invoices/:id with version field
  - [ ] Stale version → 409 Conflict (someone else updated)
  - [ ] Client must refresh and retry

---

## Phase 6: Security & Permission Checks

### 6.1 Role-Based Access Control
**Goal**: Verify roles restrict access appropriately

**Roles**: Owner, Admin, Technician, Customer

- [ ] Owner role
  - [ ] Can access all features
  - [ ] Can manage users and settings
  - [ ] Can view all customer data

- [ ] Admin role
  - [ ] Can manage settings
  - [ ] Can manage users
  - [ ] Cannot access financial reports (depends on config)

- [ ] Technician role
  - [ ] Can view assigned jobs
  - [ ] Cannot access invoices/payments
  - [ ] Cannot modify settings

- [ ] Customer role
  - [ ] Can view own estimate/invoice via public link
  - [ ] Cannot access backend API
  - [ ] Cannot see other customers

### 6.2 Data Isolation Verification
**Goal**: Confirm tenant A cannot access tenant B's data

- [ ] SQL injection test
  - [ ] POST /api/invoices with tenant_id in request body
  - [ ] Ignored (tenant_id from JWT token only, not request)
  - [ ] Result: Invoice created with correct tenant_id

- [ ] URL traversal test
  - [ ] GET /api/invoices/uuid-from-tenant-b
  - [ ] Response: 403 Forbidden (not 200)
  - [ ] Error message: "Not authorized"

### 6.3 Password & Token Security
**Goal**: Verify authentication doesn't leak information

- [ ] Sign in with wrong password
  - [ ] Response: 401 Unauthorized (generic, not "password incorrect")
  - [ ] Response: Not "user not found" (doesn't reveal if email exists)

- [ ] Sign in with wrong email
  - [ ] Response: 401 Unauthorized (same as wrong password)
  - [ ] Response: Cannot distinguish between "no such user" vs. "wrong password"

---

## Phase 7: Feature Completeness Checks

### 7.1 Estimate Workflow
**Checklist**: Create → Send → Approve → Invoice

- [ ] Create estimate
  - [ ] Form accepts all fields
  - [ ] Line items can be added/removed
  - [ ] Subtotal/total calculated correctly
  - [ ] Can save as draft

- [ ] Send estimate
  - [ ] Estimate status changes to SENT
  - [ ] Public link generated
  - [ ] Link has expiration (30 days)
  - [ ] SMS/email sent (mocked in CI, real in staging)

- [ ] Customer approves
  - [ ] Public link works without login
  - [ ] Mobile responsive
  - [ ] Approve button functional
  - [ ] Signature/consent collected (or marked in audit)

- [ ] Create invoice from estimate
  - [ ] Invoice created with same line items
  - [ ] Invoice linked to estimate
  - [ ] Invoice status = SENT

### 7.2 Invoice Workflow
**Checklist**: Create → Send → Pay → Reconcile

- [ ] Create invoice (from estimate or manual)
  - [ ] Line items copied/entered
  - [ ] Total = sum of items + tax
  - [ ] Invoice number auto-generated
  - [ ] Due date set

- [ ] Send invoice
  - [ ] SMS/email sent with payment link
  - [ ] Payment link generated (Stripe)
  - [ ] Status = SENT

- [ ] Customer pays
  - [ ] Payment link functional
  - [ ] Payment processed (mocked in CI)
  - [ ] Webhook updates invoice status = PAID
  - [ ] Receipt generated

- [ ] Reconciliation
  - [ ] Invoice marked PAID
  - [ ] Payment recorded in audit
  - [ ] No duplicate entries (idempotency)

### 7.3 Customer Directory
**Checklist**: Create → Search → Contact History

- [ ] Create customer
  - [ ] All fields stored
  - [ ] Duplicate detection (warn if similar exists)
  - [ ] Phone normalized and stored

- [ ] Search/filter
  - [ ] Search by name, phone, email
  - [ ] Filter by recent, no jobs, etc.
  - [ ] Results pagination

- [ ] Customer details
  - [ ] Full history shown (jobs, estimates, invoices, payments)
  - [ ] Contact log shows all interactions
  - [ ] Can add notes

---

## Phase 8: Responsive & Accessibility

### 8.1 Component Structure (Code Inspection)
**Goal**: Verify responsive classes are present (without running browser)

- [ ] Mobile-first breakpoints
  - [ ] TailwindCSS breakpoints used: sm, md, lg, xl
  - [ ] Mobile (375px) view is default (no special mobile class)
  - [ ] Tablet (768px) uses `md:` prefix
  - [ ] Desktop (1920px) uses `lg:` prefix

- [ ] Tap target sizes
  - [ ] All buttons have `min-h-11` or `h-11` (44px minimum)
  - [ ] All links have `min-h-11` or padding equivalent
  - [ ] Form inputs have `min-h-10` (40px) minimum height

- [ ] No horizontal scroll
  - [ ] No hardcoded widths > 100%
  - [ ] Containers use `w-full` or `max-w-*`
  - [ ] Text wrapping enabled (no `whitespace-nowrap` on mobile)

### 8.2 Form Fields
- [ ] Accessible labels
  - [ ] All inputs have `<label>` elements
  - [ ] Labels linked to inputs via `for` attribute
  - [ ] No placeholder-only labels

- [ ] Error messages
  - [ ] Error messages appear near field (not floating)
  - [ ] Error color accessible (not red-only)
  - [ ] Required fields marked (*) or indicated

---

## Phase 9: Performance Indicators (Without Load Testing)

### 9.1 Code-Level Performance
**Goal**: Verify no obvious performance issues in code

- [ ] Database query patterns
  - [ ] No N+1 queries (list endpoints join all needed data)
  - [ ] Pagination enforced (not loading all records)
  - [ ] Indexes present on commonly filtered columns

- [ ] API response structure
  - [ ] No unnecessary nesting
  - [ ] Only required fields in response (no full nested objects when ID suffices)
  - [ ] No pagination cursors (using limit/offset is fine for small datasets)

- [ ] Frontend bundle
  - [ ] No unused imports
  - [ ] Components lazy-loaded (React.lazy for route code-splitting)
  - [ ] No console.log in production code

### 9.2 Network Efficiency
- [ ] Request batching
  - [ ] Dashboard loads all metrics in 1-2 requests (not 10+)
  - [ ] Customer list uses pagination (not loading 10k records)

---

## Phase 10: Documentation & Comments

### 10.1 Code Documentation
- [ ] Complex functions documented
  - [ ] Money calculation logic has explanatory comments
  - [ ] State machine transitions documented
  - [ ] Entity resolver logic explained

- [ ] API documentation
  - [ ] Endpoint signatures documented (params, response)
  - [ ] Error scenarios documented
  - [ ] Example requests/responses shown

---

## Summary Checklist

**Phase 1: Schema Verification** — [ ] Complete  
**Phase 2: API Contracts** — [ ] Complete  
**Phase 3: State Machines** — [ ] Complete  
**Phase 4: Data Integrity** — [ ] Complete  
**Phase 5: Error Handling** — [ ] Complete  
**Phase 6: Security & Permissions** — [ ] Complete  
**Phase 7: Feature Completeness** — [ ] Complete  
**Phase 8: Responsive & Accessibility** — [ ] Complete  
**Phase 9: Performance** — [ ] Complete  
**Phase 10: Documentation** — [ ] Complete  

---

## Issues Found

**[To be filled in as QA progresses]**

| # | Phase | Issue | Severity | Status |
|----|-------|-------|----------|--------|
| 1  | TBD   | TBD   | TBD      | TBD    |

---

## Sign-Off

**QA Tester**: Claude Haiku 4.5  
**Date**: 2026-10-06  
**Overall Status**: 🔄 IN PROGRESS  

**Approval**: [ ] PASS (All items checked, no blockers)  
           [ ] PASS WITH WAIVERS (Known issues accepted)  
           [ ] FAIL (Blockers found, requires fixes)

