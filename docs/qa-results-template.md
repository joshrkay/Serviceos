# QA Results Template — [DATE: YYYY-MM-DD]

**Run Date**: [e.g., 2026-07-30]  
**Tester**: [Name/initials]  
**Environment**: [Production/Staging]  
**Browsers Tested**: [e.g., Chrome 130 on Windows 11, Safari on iOS 18]  
**Device Breakpoints**: Desktop (1920px), Tablet (768px), Mobile (375px)  
**Start Time**: [HH:MM UTC]  
**End Time**: [HH:MM UTC]  
**Total Duration**: [X hours Y minutes]

---

## Summary

**Total Checks**: [X]  
**Passed**: [X] ✅  
**Failed**: [X] ❌  
**Skipped/N/A**: [X] ⊘  
**Pass Rate**: [X%]  

**Status**: 🔴 CRITICAL / 🟠 BLOCKING / 🟡 DEGRADED / 🟢 HEALTHY

---

## Critical Failures (Block Release)

**Count**: [X]

For each critical failure:

### [Section Name]: [Feature]

**Check**: [Specific check that failed]  
**Severity**: 🔴 CRITICAL  
**Steps to Reproduce**:
1. [Step 1]
2. [Step 2]
3. [Step 3]

**Expected**: [What should happen]  
**Actual**: [What actually happened]  

**Evidence**:
- Screenshot: [Describe or attach]
- Network log: [If applicable]
- Console error: [Error message if applicable]
- Video: [If complex interaction]

**Impact**: [Who is affected, what breaks, business impact]  
**Workaround**: [Temporary workaround if any]  
**Root Cause Hypothesis**: [If known]  
**Ticket**: [Link to issue if filed]

---

## High Severity Failures (Urgent Fix)

**Count**: [X]

### [Section Name]: [Feature]

**Check**: [Specific check that failed]  
**Severity**: 🟠 HIGH  
**Steps to Reproduce**:
1. [Step 1]
2. [Step 2]

**Expected**: [What should happen]  
**Actual**: [What actually happened]  

**Impact**: [Affects core workflow or data integrity]  
**Ticket**: [Link if filed]

---

## Medium Severity Failures (Should Fix)

**Count**: [X]

### [Section Name]: [Feature]

**Check**: [Specific check that failed]  
**Severity**: 🟡 MEDIUM  
**Steps to Reproduce**:
1. [Step 1]
2. [Step 2]

**Impact**: [User experience degradation, edge case]  
**Ticket**: [Link if filed]

---

## Low Severity Failures (Nice to Fix)

**Count**: [X]

- **[Section]: [Feature]** — [Brief description]
- **[Section]: [Feature]** — [Brief description]

---

## Regressions (New Failures vs. Prior Run)

**Regression Count**: [X]

Failures that passed in the previous run but are now failing:

### [Feature Name]

**Last Passed**: [Date of last passing run]  
**Last Failed**: [This run]  
**Check**: [What regressed]  
**Hypothesis**: [What code change might have caused this?]

---

## Improvements (New Fixes)

**Improvements**: [X]

Issues that were failing before but now pass:

- **[Feature]** — Fixed since 2026-07-28 run ✅
- **[Feature]** — Fixed since 2026-07-28 run ✅

---

## Skipped Tests

**Count**: [X]

Tests not run (mark why):

- **[Section]: [Feature]** — ⊘ [Reason: Feature not deployed / Test env down / Out of scope / etc.]
- **[Section]: [Feature]** — ⊘ [Reason]

---

## Detailed Failure Log

### 1. Authentication & Account Management

#### 1.1 Sign In / Sign Up
- [ ] Desktop sign in ✅ / ❌ / ⊘
- [ ] Mobile sign in ✅ / ❌ / ⊘
  - **Notes**: [If ❌ include error details]
- [ ] Error handling ✅ / ❌ / ⊘
- [ ] Password reset ✅ / ❌ / ⊘
- [ ] Session persistence ✅ / ❌ / ⊘
- [ ] Logout ✅ / ❌ / ⊘

#### 1.2 Multi-Tenant / Account Switching
- [ ] Multiple accounts ✅ / ❌ / ⊘
- [ ] Tenant isolation ✅ / ❌ / ⊘
- [ ] RLS enforcement ✅ / ❌ / ⊘

#### 1.3 Role-Based Access
- [ ] Owner role ✅ / ❌ / ⊘
- [ ] Technician role ✅ / ❌ / ⊘
- [ ] Admin role ✅ / ❌ / ⊘
- [ ] Public link access ✅ / ❌ / ⊘

### 2. Dashboard & Home

#### 2.1 Dashboard Load & Display
- [ ] Page load time <2s ✅ / ❌ / ⊘
  - **Actual**: [X]ms
- [ ] Data freshness <30s ✅ / ❌ / ⊘
- [ ] All widgets render ✅ / ❌ / ⊘
- [ ] No blank states ✅ / ❌ / ⊘

#### 2.2 Dashboard Interactions
- [ ] Click to details ✅ / ❌ / ⊘
- [ ] Filtering works ✅ / ❌ / ⊘
- [ ] Date range works ✅ / ❌ / ⊘

#### 2.3 Notifications & Alerts
- [ ] Notification badge ✅ / ❌ / ⊘
- [ ] Notification center ✅ / ❌ / ⊘
- [ ] Mark as read ✅ / ❌ / ⊘
- [ ] Dismiss ✅ / ❌ / ⊘

### 3. Appointments & Scheduling

#### 3.1 Create Appointment
- [ ] Form opens ✅ / ❌ / ⊘
- [ ] Date picker works ✅ / ❌ / ⊘
- [ ] Time picker works ✅ / ❌ / ⊘
- [ ] Customer selection ✅ / ❌ / ⊘
- [ ] Add new customer ✅ / ❌ / ⊘
- [ ] Service type selection ✅ / ❌ / ⊘
- [ ] Save works ✅ / ❌ / ⊘
- [ ] Validation works ✅ / ❌ / ⊘

#### 3.2 Appointment Display
- [ ] Calendar view (desktop) ✅ / ❌ / ⊘
- [ ] Calendar view (mobile) ✅ / ❌ / ⊘
- [ ] Appointment details modal ✅ / ❌ / ⊘
- [ ] Color coding ✅ / ❌ / ⊘
- [ ] Conflict detection ✅ / ❌ / ⊘

#### 3.3 Appointment Modification
- [ ] Reschedule ✅ / ❌ / ⊘
- [ ] Reassign tech ✅ / ❌ / ⊘
- [ ] Add note ✅ / ❌ / ⊘
- [ ] Cancel ✅ / ❌ / ⊘
- [ ] Cancel reason ✅ / ❌ / ⊘

#### 3.4 SMS Appointment Confirmations
- [ ] Confirmation sent ✅ / ❌ / ⊘
- [ ] Link in SMS ✅ / ❌ / ⊘
- [ ] Confirmation tracking ✅ / ❌ / ⊘
- [ ] Non-response handling ✅ / ❌ / ⊘

### 4. Estimates & Proposals

#### 4.1 Create Estimate
- [ ] Form opens ✅ / ❌ / ⊘
- [ ] Line items editable ✅ / ❌ / ⊘
- [ ] Price integers (cents) ✅ / ❌ / ⊘
- [ ] Tax calculation ✅ / ❌ / ⊘
- [ ] Subtotal correct ✅ / ❌ / ⊘
- [ ] Total correct ✅ / ❌ / ⊘
- [ ] Discount applies ✅ / ❌ / ⊘
- [ ] Notes work ✅ / ❌ / ⊘
- [ ] AI draft loads ✅ / ❌ / ⊘
- [ ] Can edit AI draft ✅ / ❌ / ⊘
- [ ] Confidence shown ✅ / ❌ / ⊘

#### 4.2 Estimate Pricing Validation
- [ ] Catalog grounded ✅ / ❌ / ⊘
- [ ] Uncatalogued items flagged ✅ / ❌ / ⊘
- [ ] Custom pricing allowed ✅ / ❌ / ⊘
- [ ] No silent guesses ✅ / ❌ / ⊘

#### 4.3 Send Estimate
- [ ] SMS sent ✅ / ❌ / ⊘
- [ ] Email sent ✅ / ❌ / ⊘
- [ ] Public link works ✅ / ❌ / ⊘
- [ ] Link expiration ✅ / ❌ / ⊘
- [ ] Link tracking ✅ / ❌ / ⊘

#### 4.4 Estimate Approval (Customer-Facing)
- [ ] Desktop approval page ✅ / ❌ / ⊘
- [ ] Mobile approval page (375px) ✅ / ❌ / ⊘
- [ ] Responsive images ✅ / ❌ / ⊘
- [ ] Tap targets ≥44px ✅ / ❌ / ⊘
- [ ] Approve flow ✅ / ❌ / ⊘
- [ ] Decline flow ✅ / ❌ / ⊘
- [ ] Success message ✅ / ❌ / ⊘
- [ ] Confirmation sent ✅ / ❌ / ⊘

#### 4.5 Estimate History & Management
- [ ] List estimates ✅ / ❌ / ⊘
- [ ] Filter by status ✅ / ❌ / ⊘
- [ ] Search ✅ / ❌ / ⊘
- [ ] Sort ✅ / ❌ / ⊘
- [ ] Resend ✅ / ❌ / ⊘
- [ ] Archive ✅ / ❌ / ⊘
- [ ] Audit trail ✅ / ❌ / ⊘

### 5. Invoices & Payments

#### 5.1 Create Invoice
- [ ] From estimate ✅ / ❌ / ⊘
- [ ] Manual invoice ✅ / ❌ / ⊘
- [ ] Line items copy correctly ✅ / ❌ / ⊘
- [ ] Date/terms correct ✅ / ❌ / ⊘
- [ ] PO reference ✅ / ❌ / ⊘
- [ ] Deposit shown ✅ / ❌ / ⊘
- [ ] Balance due correct ✅ / ❌ / ⊘
- [ ] Save works ✅ / ❌ / ⊘

#### 5.2 Invoice Pricing Validation
- [ ] Money in cents ✅ / ❌ / ⊘
- [ ] No rounding errors ✅ / ❌ / ⊘
- [ ] Deposit tracking ✅ / ❌ / ⊘
- [ ] Credits applied correctly ✅ / ❌ / ⊘

#### 5.3 Send Invoice
- [ ] SMS sent ✅ / ❌ / ⊘
- [ ] Email sent ✅ / ❌ / ⊘
- [ ] Payment link generated ✅ / ❌ / ⊘
- [ ] Link expiration ✅ / ❌ / ⊘
- [ ] Multiple sends work ✅ / ❌ / ⊘

#### 5.4 Payment Collection (Customer-Facing)
- [ ] Payment page loads ✅ / ❌ / ⊘
- [ ] Mobile friendly ✅ / ❌ / ⊘
- [ ] Card entry ✅ / ❌ / ⊘
- [ ] Save card ✅ / ❌ / ⊘
- [ ] Process payment ✅ / ❌ / ⊘
- [ ] Decline handling ✅ / ❌ / ⊘
- [ ] Verification (3DS) ✅ / ❌ / ⊘
- [ ] Confirmation email ✅ / ❌ / ⊘

#### 5.5 Payment Tracking & Reconciliation
- [ ] Invoice marked paid ✅ / ❌ / ⊘
- [ ] Deposit tracked ✅ / ❌ / ⊘
- [ ] Overpayment handling ✅ / ❌ / ⊘
- [ ] Partial payments ✅ / ❌ / ⊘
- [ ] Payment history ✅ / ❌ / ⊘
- [ ] Stripe sync ✅ / ❌ / ⊘
- [ ] Reconciliation ✅ / ❌ / ⊘

#### 5.6 Invoice History & Management
- [ ] List invoices ✅ / ❌ / ⊘
- [ ] Filter by status ✅ / ❌ / ⊘
- [ ] Search ✅ / ❌ / ⊘
- [ ] Sort ✅ / ❌ / ⊘
- [ ] Download PDF ✅ / ❌ / ⊘
- [ ] Void invoice ✅ / ❌ / ⊘
- [ ] Edit draft ✅ / ❌ / ⊘

### 6. Customer Management

#### 6.1 Create Customer
- [ ] Form opens ✅ / ❌ / ⊘
- [ ] Phone validation ✅ / ❌ / ⊘
- [ ] Address autocomplete ✅ / ❌ / ⊘
- [ ] Email validation ✅ / ❌ / ⊘
- [ ] Duplicate detection ✅ / ❌ / ⊘
- [ ] Notes ✅ / ❌ / ⊘
- [ ] Save works ✅ / ❌ / ⊘

#### 6.2 Customer Directory
- [ ] List view ✅ / ❌ / ⊘
- [ ] Search ✅ / ❌ / ⊘
- [ ] Filter ✅ / ❌ / ⊘
- [ ] Sort ✅ / ❌ / ⊘
- [ ] Pagination (100+ customers) ✅ / ❌ / ⊘
- [ ] Quick add ✅ / ❌ / ⊘

#### 6.3 Customer Details
- [ ] Profile page ✅ / ❌ / ⊘
- [ ] Contact history ✅ / ❌ / ⊘
- [ ] Job history ✅ / ❌ / ⊘
- [ ] Payment history ✅ / ❌ / ⊘
- [ ] Edit ✅ / ❌ / ⊘
- [ ] Communication log ✅ / ❌ / ⊘

#### 6.4 Customer Communication
- [ ] SMS to customer ✅ / ❌ / ⊘
- [ ] Email to customer ✅ / ❌ / ⊘
- [ ] Call to customer ✅ / ❌ / ⊘
- [ ] Message log ✅ / ❌ / ⊘
- [ ] Inbound SMS logging ✅ / ❌ / ⊘

### 7. Leads & Intake

#### 7.1 Lead Capture
- [ ] Inbound call creates lead ✅ / ❌ / ⊘
- [ ] Inbound SMS creates lead ✅ / ❌ / ⊘
- [ ] Web form creates lead ✅ / ❌ / ⊘
- [ ] Lead data captured ✅ / ❌ / ⊘
- [ ] Customer matching ✅ / ❌ / ⊘
- [ ] Duplicate prevention ✅ / ❌ / ⊘

#### 7.2 Lead Management
- [ ] Lead list ✅ / ❌ / ⊘
- [ ] Filter by status ✅ / ❌ / ⊘
- [ ] Filter by source ✅ / ❌ / ⊘
- [ ] Search ✅ / ❌ / ⊘
- [ ] Bulk actions ✅ / ❌ / ⊘
- [ ] Assign ✅ / ❌ / ⊘
- [ ] Add note ✅ / ❌ / ⊘

#### 7.3 Lead Conversion
- [ ] Convert to customer ✅ / ❌ / ⊘
- [ ] Create appointment ✅ / ❌ / ⊘
- [ ] Create estimate ✅ / ❌ / ⊘
- [ ] Link job ✅ / ❌ / ⊘
- [ ] Mark lost ✅ / ❌ / ⊘

### 8. Jobs & Workflow

#### 8.1 Create Job
- [ ] From appointment ✅ / ❌ / ⊘
- [ ] From estimate ✅ / ❌ / ⊘
- [ ] Manual creation ✅ / ❌ / ⊘
- [ ] Job details ✅ / ❌ / ⊘
- [ ] Job notes ✅ / ❌ / ⊘
- [ ] Technician assignment ✅ / ❌ / ⊘
- [ ] Materials list ✅ / ❌ / ⊘

#### 8.2 Job Lifecycle
- [ ] Status tracking ✅ / ❌ / ⊘
- [ ] Technician check-in ✅ / ❌ / ⊘
- [ ] Photo upload ✅ / ❌ / ⊘
- [ ] Job completion ✅ / ❌ / ⊘
- [ ] Time tracking ✅ / ❌ / ⊘
- [ ] Create invoice from job ✅ / ❌ / ⊘

#### 8.3 Job History
- [ ] Job details ✅ / ❌ / ⊘
- [ ] Dispatch view ✅ / ❌ / ⊘
- [ ] Map view ✅ / ❌ / ⊘
- [ ] Search ✅ / ❌ / ⊘
- [ ] Filter ✅ / ❌ / ⊘

### 9. Voice & Telephony

#### 9.1 Inbound Call Handling
- [ ] Call routed to AI ✅ / ❌ / ⊘
- [ ] Professional greeting ✅ / ❌ / ⊘
- [ ] Intent recognition ✅ / ❌ / ⊘
- [ ] Customer identification ✅ / ❌ / ⊘
- [ ] Service type asked ✅ / ❌ / ⊘
- [ ] Time slot offered ✅ / ❌ / ⊘
- [ ] Appointment confirmed ✅ / ❌ / ⊘
- [ ] Callback confirmed ✅ / ❌ / ⊘
- [ ] Call recorded ✅ / ❌ / ⊘
- [ ] Transcript generated ✅ / ❌ / ⊘

#### 9.2 Voicemail Handling
- [ ] Voicemail fallback ✅ / ❌ / ⊘
- [ ] Transcription ✅ / ❌ / ⊘
- [ ] Owner alert ✅ / ❌ / ⊘
- [ ] Reply option ✅ / ❌ / ⊘

#### 9.3 Outbound Calls
- [ ] Call customer ✅ / ❌ / ⊘
- [ ] Call technician ✅ / ❌ / ⊘
- [ ] Call logging ✅ / ❌ / ⊘
- [ ] Recording ✅ / ❌ / ⊘

#### 9.4 Voice Clarity & Transcription
- [ ] Accent handling ✅ / ❌ / ⊘
- [ ] Noise handling ✅ / ❌ / ⊘
- [ ] Clarification ✅ / ❌ / ⊘
- [ ] Transcript accuracy ✅ / ❌ / ⊘
- [ ] Special characters correct ✅ / ❌ / ⊘

### 10. SMS Messaging

#### 10.1 Outbound SMS
- [ ] SMS sends ✅ / ❌ / ⊘
- [ ] Link included ✅ / ❌ / ⊘
- [ ] Formatting correct ✅ / ❌ / ⊘
- [ ] Delivery confirmed ✅ / ❌ / ⊘
- [ ] Logging works ✅ / ❌ / ⊘

#### 10.2 Inbound SMS
- [ ] Message received ✅ / ❌ / ⊘
- [ ] Logging ✅ / ❌ / ⊘
- [ ] Conversation thread ✅ / ❌ / ⊘
- [ ] Intent interpretation ✅ / ❌ / ⊘
- [ ] Reply from CRM ✅ / ❌ / ⊘
- [ ] Keywords handled ✅ / ❌ / ⊘

#### 10.3 SMS Compliance
- [ ] Opt-in respected ✅ / ❌ / ⊘
- [ ] Opt-out option ✅ / ❌ / ⊘
- [ ] Opt-out honored ✅ / ❌ / ⊘
- [ ] STOP keyword ✅ / ❌ / ⊘

### 11. Dispatch & Scheduling

#### 11.1 Dispatch Board
- [ ] Board loads ✅ / ❌ / ⊘
- [ ] By technician ✅ / ❌ / ⊘
- [ ] By time ✅ / ❌ / ⊘
- [ ] Color coding ✅ / ❌ / ⊘
- [ ] Drag & drop ✅ / ❌ / ⊘
- [ ] Add job ✅ / ❌ / ⊘
- [ ] Remove job ✅ / ❌ / ⊘

#### 11.2 Technician Assignments
- [ ] Assign technician ✅ / ❌ / ⊘
- [ ] Capacity check ✅ / ❌ / ⊘
- [ ] Travel time ✅ / ❌ / ⊘
- [ ] Skills check ✅ / ❌ / ⊘
- [ ] Availability shown ✅ / ❌ / ⊘

#### 11.3 Route Optimization
- [ ] Route optimization ✅ / ❌ / ⊘
- [ ] Map view ✅ / ❌ / ⊘
- [ ] ETA ✅ / ❌ / ⊘

### 12. Reports & Analytics

#### 12.1 Dashboard Metrics
- [ ] Revenue today ✅ / ❌ / ⊘
- [ ] Revenue this month ✅ / ❌ / ⊘
- [ ] Pending estimates ✅ / ❌ / ⊘
- [ ] Unpaid invoices ✅ / ❌ / ⊘
- [ ] Appointments ✅ / ❌ / ⊘
- [ ] Completed jobs ✅ / ❌ / ⊘
- [ ] Average job value ✅ / ❌ / ⊘
- [ ] Response time ✅ / ❌ / ⊘

#### 12.2 Report Generation
- [ ] Revenue report ✅ / ❌ / ⊘
- [ ] Job report ✅ / ❌ / ⊘
- [ ] Customer report ✅ / ❌ / ⊘
- [ ] Invoice report ✅ / ❌ / ⊘
- [ ] Export ✅ / ❌ / ⊘
- [ ] Accuracy ✅ / ❌ / ⊘

#### 12.3 Trends & Forecasting
- [ ] Weekly revenue ✅ / ❌ / ⊘
- [ ] Job volume ✅ / ❌ / ⊘
- [ ] Win rate ✅ / ❌ / ⊘

### 13. Settings & Configuration

#### 13.1 Business Settings
- [ ] Business name ✅ / ❌ / ⊘
- [ ] Phone number ✅ / ❌ / ⊘
- [ ] Business hours ✅ / ❌ / ⊘
- [ ] Time zone ✅ / ❌ / ⊘
- [ ] Address ✅ / ❌ / ⊘
- [ ] Logo ✅ / ❌ / ⊘
- [ ] Color scheme ✅ / ❌ / ⊘

#### 13.2 Service Configuration
- [ ] Service types ✅ / ❌ / ⊘
- [ ] Service pricing ✅ / ❌ / ⊘
- [ ] Tax rate ✅ / ❌ / ⊘
- [ ] Deposit requirement ✅ / ❌ / ⊘
- [ ] Payment terms ✅ / ❌ / ⊘

#### 13.3 SMS Configuration
- [ ] SMS enabled ✅ / ❌ / ⊘
- [ ] SMS number ✅ / ❌ / ⊘
- [ ] Opt-in list ✅ / ❌ / ⊘

#### 13.4 Telephony Configuration
- [ ] Forwarding number ✅ / ❌ / ⊘
- [ ] Call routing ✅ / ❌ / ⊘
- [ ] Hours ✅ / ❌ / ⊘
- [ ] Voicemail ✅ / ❌ / ⊘

#### 13.5 Integrations
- [ ] Stripe connected ✅ / ❌ / ⊘
- [ ] Twilio connected ✅ / ❌ / ⊘
- [ ] Google Maps ✅ / ❌ / ⊘
- [ ] Other integrations ✅ / ❌ / ⊘

#### 13.6 User Management
- [ ] Add user ✅ / ❌ / ⊘
- [ ] Role assignment ✅ / ❌ / ⊘
- [ ] Permissions ✅ / ❌ / ⊘
- [ ] Deactivate user ✅ / ❌ / ⊘
- [ ] Password reset ✅ / ❌ / ⊘

### 14. Mobile App

#### 14.1 Mobile Authentication
- [ ] Login ✅ / ❌ / ⊘
- [ ] Auto-lock ✅ / ❌ / ⊘
- [ ] Biometric ✅ / ❌ / ⊘
- [ ] Session persistence ✅ / ❌ / ⊘

#### 14.2 Mobile Dashboard
- [ ] Loads ✅ / ❌ / ⊘
- [ ] Metrics visible ✅ / ❌ / ⊘
- [ ] Responsive ✅ / ❌ / ⊘
- [ ] Tap targets ✅ / ❌ / ⊘

#### 14.3 Mobile Technician Features
- [ ] Job list ✅ / ❌ / ⊘
- [ ] Job details ✅ / ❌ / ⊘
- [ ] Check-in ✅ / ❌ / ⊘
- [ ] Photos ✅ / ❌ / ⊘
- [ ] Notes ✅ / ❌ / ⊘
- [ ] Complete ✅ / ❌ / ⊘
- [ ] Map ✅ / ❌ / ⊘
- [ ] Navigation ✅ / ❌ / ⊘

#### 14.4 Mobile Offline
- [ ] Offline capable ✅ / ❌ / ⊘
- [ ] Sync ✅ / ❌ / ⊘
- [ ] Offline indicators ✅ / ❌ / ⊘

### 15. Error Handling & Edge Cases

#### 15.1 Network Errors
- [ ] No connection ✅ / ❌ / ⊘
- [ ] Slow connection ✅ / ❌ / ⊘
- [ ] Timeout ✅ / ❌ / ⊘
- [ ] Retry ✅ / ❌ / ⊘

#### 15.2 Input Validation
- [ ] Required fields ✅ / ❌ / ⊘
- [ ] Email format ✅ / ❌ / ⊘
- [ ] Phone format ✅ / ❌ / ⊘
- [ ] Currency ✅ / ❌ / ⊘
- [ ] Date range ✅ / ❌ / ⊘
- [ ] Future dates ✅ / ❌ / ⊘

#### 15.3 Concurrency & Race Conditions
- [ ] Duplicate submission ✅ / ❌ / ⊘
- [ ] Stale data ✅ / ❌ / ⊘
- [ ] Multi-user ✅ / ❌ / ⊘

#### 15.4 Data Integrity
- [ ] Money precision ✅ / ❌ / ⊘
- [ ] Timezone handling ✅ / ❌ / ⊘
- [ ] Audit trail ✅ / ❌ / ⊘
- [ ] No data loss ✅ / ❌ / ⊘

#### 15.5 Permission & Security
- [ ] RLS enforced ✅ / ❌ / ⊘
- [ ] Role-based access ✅ / ❌ / ⊘
- [ ] Password security ✅ / ❌ / ⊘
- [ ] Token security ✅ / ❌ / ⊘
- [ ] HTTPS ✅ / ❌ / ⊘

### 16. Performance & Load

#### 16.1 Page Load Times
- [ ] Dashboard <2s (desktop) ✅ / ❌ / ⊘
  - **Actual**: [X]ms
- [ ] Dashboard <3s (mobile) ✅ / ❌ / ⊘
  - **Actual**: [X]ms
- [ ] Customer list <2s ✅ / ❌ / ⊘
  - **Actual**: [X]ms
- [ ] Job list <2s ✅ / ❌ / ⊘
  - **Actual**: [X]ms
- [ ] Search <500ms ✅ / ❌ / ⊘
  - **Actual**: [X]ms

#### 16.2 API Response Times
- [ ] Create estimate <500ms ✅ / ❌ / ⊘
- [ ] Send SMS <1s ✅ / ❌ / ⊘
- [ ] Process payment <2s ✅ / ❌ / ⊘
- [ ] Voice transcription ✅ / ❌ / ⊘

#### 16.3 Concurrency
- [ ] 100 concurrent users ✅ / ❌ / ⊘
- [ ] Multiple payments ✅ / ❌ / ⊘
- [ ] Bulk SMS ✅ / ❌ / ⊘

### 17. AI & Proposal Quality

#### 17.1 AI Call Handling
- [ ] Professional voice ✅ / ❌ / ⊘
- [ ] Accurate capture ✅ / ❌ / ⊘
- [ ] Backoff/clarification ✅ / ❌ / ⊘
- [ ] Error handling ✅ / ❌ / ⊘
- [ ] Handoff ✅ / ❌ / ⊘

#### 17.2 Proposal Generation
- [ ] Reasonable estimates ✅ / ❌ / ⊘
- [ ] Pricing valid ✅ / ❌ / ⊘
- [ ] Confidence shown ✅ / ❌ / ⊘
- [ ] Clear text ✅ / ❌ / ⊘

#### 17.3 Entity Resolution
- [ ] Customer matching ✅ / ❌ / ⊘
- [ ] Address normalization ✅ / ❌ / ⊘
- [ ] Service type ✅ / ❌ / ⊘
- [ ] Ambiguity handling ✅ / ❌ / ⊘

### 18. Security & Compliance

#### 18.1 Authentication
- [ ] Brute-force protection ✅ / ❌ / ⊘
- [ ] Session expiration ✅ / ❌ / ⊘
- [ ] Password policy ✅ / ❌ / ⊘
- [ ] 2FA ✅ / ❌ / ⊘

#### 18.2 Data Protection
- [ ] PII encryption ✅ / ❌ / ⊘
- [ ] Payment data ✅ / ❌ / ⊘
- [ ] Audit logs ✅ / ❌ / ⊘
- [ ] Data deletion ✅ / ❌ / ⊘

#### 18.3 Rate Limiting
- [ ] API rate limits ✅ / ❌ / ⊘
- [ ] SMS limits ✅ / ❌ / ⊘
- [ ] Call frequency ✅ / ❌ / ⊘

---

## Environmental Notes

### System State
- **Database**: Healthy / Degraded / Down
- **Cache (if used)**: Healthy / Degraded / Down
- **External APIs**: Stripe [OK/Degraded/Down], Twilio [OK/Degraded/Down], Other [OK/Degraded/Down]
- **CDN/Assets**: Healthy / Degraded / Down

### Notable Observations
- [Any unusual behavior, system quirks, flaky tests, performance anomalies, etc.]
- [Environmental issues that affected testing]
- [Third-party API issues encountered]

---

## Recommendations for Next Sprint

### Critical Path
1. [Fix critical issue 1 — Blocks release/revenue]
2. [Fix critical issue 2]
3. [Fix high issue 1 — Affects core workflow]

### Important (Next Week)
- [High priority issue]
- [High priority issue]

### Nice to Have (Backlog)
- [Low priority improvement]
- [Low priority improvement]

---

## Comparison to Prior Run

**Previous Run Date**: [2026-07-28]  
**Previous Pass Rate**: [95%]  
**Current Pass Rate**: [92%]  
**Change**: -3% ❌

**Key Deltas**:
- **New Failures** (regressions): [3]
- **New Passes** (fixes): [2]
- **Net Change**: [+1 more failure]

### Regression Analysis
- **[Feature]** was passing 2026-07-28, now failing — likely caused by [PR #123]
- **[Feature]** was passing 2026-07-28, now failing — likely caused by [PR #456]

### Fixed Issues
- **[Feature]** was failing 2026-07-28, now passing ✅ — fixed by [PR #789]

---

## Sign-Off

**QA Lead Approval**: _________________ **Date**: _______  
**Engineering Lead Review**: _________________ **Date**: _______  

**Release Clearance**: 🔴 BLOCKED / 🟡 CONDITIONAL / 🟢 APPROVED

**Release Notes**:
- [If approved, summarize what's being released and known issues]
- [If blocked, summarize what must be fixed]

