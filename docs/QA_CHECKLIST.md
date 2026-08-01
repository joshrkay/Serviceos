# Comprehensive QA Checklist — AI Service OS

**Purpose**: Complete feature coverage every 2-3 days to catch regressions and new bugs.  
**Cadence**: Every 2-3 days (Tuesday, Thursday, Saturday or similar)  
**Owner**: Engineering QA Lead  
**Date Created**: 2026-07-30

---

## Testing Philosophy

- **Brutally honest**: Record every failure, no matter how small
- **Regression detection**: Compare against prior runs to catch breaks
- **End-to-end focused**: Test actual user workflows, not isolated components
- **Production-like**: Use live/staging data that mirrors real usage
- **Device coverage**: Test on desktop (1920px), tablet (768px), and mobile (375px)

---

## 1. AUTHENTICATION & ACCOUNT MANAGEMENT

### 1.1 Sign In / Sign Up
- [ ] **Desktop (1920px)**: Sign in flow completes, user lands on dashboard
- [ ] **Mobile (375px)**: Sign in responsive, keyboard doesn't obscure fields, tap targets ≥44px
- [ ] **Error handling**: Invalid email shows error message
- [ ] **Error handling**: Wrong password shows error message, doesn't reveal if email exists
- [ ] **Password reset**: Email received, reset link works, new password accepted
- [ ] **Session persistence**: Refresh page, still logged in
- [ ] **Logout**: Clicking logout removes session, redirects to sign-in

### 1.2 Multi-Tenant / Account Switching
- [ ] **Multiple accounts**: Can sign out and sign into different account
- [ ] **Tenant isolation**: Logged into Tenant A, cannot see Tenant B's data via URL manipulation
- [ ] **RLS enforcement**: Database queries respect tenant_id filtering

### 1.3 Role-Based Access
- [ ] **Owner role**: Full access to all features
- [ ] **Technician role**: Cannot access billing/invoicing
- [ ] **Admin role**: Can manage settings and users
- [ ] **Public link access**: Estimate/invoice links work without login

---

## 2. DASHBOARD & HOME

### 2.1 Dashboard Load & Display
- [ ] **Page loads**: Dashboard renders in <2s on cable connection
- [ ] **Data freshness**: Changes to jobs/estimates appear within 30s
- [ ] **Widget display**: All metric cards render (incoming calls, estimates pending, revenue, etc.)
- [ ] **No blank states**: Each section has data or shows "No data" gracefully

### 2.2 Dashboard Interactions
- [ ] **Click to details**: Click on pending estimate card opens estimate details
- [ ] **Click to details**: Click on job card opens job details
- [ ] **Filtering**: Dashboard filters by status (e.g., "Pending Approval" estimates)
- [ ] **Date range**: Changing date range updates all cards

### 2.3 Notifications & Alerts
- [ ] **Notification badge**: Shows unread count
- [ ] **Notification center**: Clicking bell opens notification list
- [ ] **Mark as read**: Notifications can be marked read
- [ ] **Dismiss**: Notifications can be dismissed

---

## 3. APPOINTMENTS & SCHEDULING

### 3.1 Create Appointment
- [ ] **Appointment form**: Opens with correct fields (date, time, customer, address, type)
- [ ] **Date picker**: Calendar date picker works, selects future dates only
- [ ] **Time slot**: Time picker available, respects business hours
- [ ] **Customer selection**: Dropdown shows existing customers
- [ ] **New customer**: Can add inline customer with name/phone
- [ ] **Service type**: Dropdown shows configured service types (HVAC, Plumbing, etc.)
- [ ] **Save**: Appointment saves, appears in calendar
- [ ] **Validation**: Cannot save without required fields (shows error)

### 3.2 Appointment Display
- [ ] **Calendar view (desktop)**: Week/month view shows appointments
- [ ] **Calendar view (mobile)**: Single day/week view only, scrollable
- [ ] **Appointment details**: Clicking appointment shows full details modal
- [ ] **Color coding**: Confirmed vs pending appointments have different colors
- [ ] **Conflict detection**: System warns if technician double-booked

### 3.3 Appointment Modification
- [ ] **Reschedule**: Can change appointment date/time
- [ ] **Reassign tech**: Can change assigned technician
- [ ] **Add note**: Can add/edit appointment notes
- [ ] **Cancel**: Can cancel appointment, shows confirmation
- [ ] **Cancel reason**: Cancelled appointments show reason

### 3.4 SMS Appointment Confirmations
- [ ] **Confirmation sent**: SMS sent to customer confirming appointment details
- [ ] **Link in SMS**: SMS contains link to confirm via mobile (if applicable)
- [ ] **Confirmation tracking**: Confirmed appointments marked as "Confirmed"
- [ ] **Non-response**: System flags unconfirmed appointments after X days

---

## 4. ESTIMATES & PROPOSALS

### 4.1 Create Estimate
- [ ] **Estimate form**: Opens with job/customer info pre-filled
- [ ] **Line items**: Can add line items (description, quantity, unit price)
- [ ] **Price validation**: All prices are integers (cents), no float rounding errors
- [ ] **Tax calculation**: Tax calculated correctly based on tax rate
- [ ] **Subtotal**: Subtotal = sum of line items
- [ ] **Total**: Total = subtotal + tax + fees
- [ ] **Discount**: Can apply discount (percentage or fixed)
- [ ] **Notes**: Can add estimate notes/special instructions
- [ ] **AI draft**: AI-drafted estimates load with pre-filled line items
- [ ] **Edit AI draft**: Can modify AI-drafted line items before sending
- [ ] **Confidence**: Low-confidence items show warning (need customer review)

### 4.2 Estimate Pricing Validation
- [ ] **Catalog grounding**: All auto-filled prices come from tenant catalog
- [ ] **Uncatalogued items**: Items not in catalog have confidence <threshold
- [ ] **Custom pricing**: Can add custom line items outside catalog
- [ ] **No silent guesses**: Ambiguous items trigger clarification, don't guess

### 4.3 Send Estimate
- [ ] **Send via SMS**: SMS sent with estimate link
- [ ] **Send via email**: Email sent with estimate link (if configured)
- [ ] **Public link**: Link works without login, shows estimate to customer
- [ ] **Link expiration**: Expired links show "estimate no longer available"
- [ ] **Link tracking**: System records which estimates have been viewed

### 4.4 Estimate Approval (Customer-Facing)
- [ ] **Desktop approval page**: Estimate displays clearly with all line items
- [ ] **Mobile approval page**: Estimate displays on mobile 375px, no horizontal scroll
- [ ] **Responsive images**: Estimate images (if any) scale to viewport
- [ ] **Tap targets**: Approve/Decline buttons ≥44px
- [ ] **Approve flow**: Customer can approve, signature/consent collected
- [ ] **Decline flow**: Customer can decline with optional reason
- [ ] **Success message**: Approval confirmed, next steps shown
- [ ] **Non-responsive**: After approval, confirmation sent via SMS/email

### 4.5 Estimate History & Management
- [ ] **List estimates**: Dashboard shows all estimates with status
- [ ] **Filter by status**: Can filter Sent, Approved, Declined, Expired
- [ ] **Search**: Can search by customer name or estimate ID
- [ ] **Sort**: Can sort by date, amount, status
- [ ] **Resend estimate**: Can resend approved estimate as new version
- [ ] **Archive**: Can archive old estimates
- [ ] **Audit trail**: Shows who created, when sent, when approved, by whom

---

## 5. INVOICES & PAYMENTS

### 5.1 Create Invoice
- [ ] **From estimate**: Can create invoice from approved estimate
- [ ] **Manual invoice**: Can create invoice from scratch
- [ ] **Line item copy**: Line items copy from estimate correctly
- [ ] **Date/Terms**: Invoice date, due date, payment terms set correctly
- [ ] **Description**: Professional invoice description/memo
- [ ] **PO reference**: Can link to job/appointment reference
- [ ] **Deposit**: Shows deposit previously collected (if any)
- [ ] **Balance due**: Balance due = total - deposit
- [ ] **Save**: Invoice saves with unique invoice number

### 5.2 Invoice Pricing Validation
- [ ] **Money integrity**: All amounts in integer cents
- [ ] **No rounding errors**: Subtotal + tax precision maintained
- [ ] **Deposit tracking**: Deposit amount matches what was collected
- [ ] **Credit application**: Credits applied correctly, no double-counting

### 5.3 Send Invoice
- [ ] **Send via SMS**: SMS with payment link sent
- [ ] **Send via email**: Email with payment link sent
- [ ] **Payment link generation**: Link created via Stripe
- [ ] **Link expiration**: Link remains valid until payment received or 30 days
- [ ] **Multiple sends**: Can resend invoice, link still works

### 5.4 Payment Collection (Customer-Facing)
- [ ] **Payment page loads**: Link opens to Stripe-hosted or custom payment page
- [ ] **Mobile friendly**: Payment form responsive on mobile 375px
- [ ] **Card entry**: Customer can enter card details
- [ ] **Save card**: Option to save card for future payments
- [ ] **Process payment**: Payment processes, confirmation shown
- [ ] **Decline handling**: Declined card shows error, customer can retry
- [ ] **Verification**: CVV/security verification works (3D Secure if enabled)
- [ ] **Confirmation email**: Receipt emailed to customer

### 5.5 Payment Tracking & Reconciliation
- [ ] **Invoice marked paid**: Invoice status changes to "Paid" after payment
- [ ] **Deposit tracking**: Payment recorded in tenant's account
- [ ] **Overpayment handling**: If customer pays over amount, shows balance
- [ ] **Partial payments**: Can accept partial payments, invoice shows remaining
- [ ] **Payment history**: Invoice shows all payments with dates/amounts
- [ ] **Stripe sync**: Payments visible in Stripe dashboard
- [ ] **Reconciliation**: Stripe balance matches system records

### 5.6 Invoice History & Management
- [ ] **List invoices**: All invoices displayed with status and amount
- [ ] **Filter by status**: Can filter Sent, Paid, Overdue, etc.
- [ ] **Search**: Can search by customer name, invoice number
- [ ] **Sort**: Can sort by date, amount, status
- [ ] **Download PDF**: Can download invoice as PDF
- [ ] **Void invoice**: Can void paid invoice with audit trail
- [ ] **Edit draft**: Can edit invoices not yet sent

---

## 6. CUSTOMER MANAGEMENT

### 6.1 Create Customer
- [ ] **Customer form**: Opens with fields (name, phone, email, address)
- [ ] **Phone validation**: Phone stored consistently, formatted for SMS/calls
- [ ] **Address completion**: Address autocomplete works (Google Maps or similar)
- [ ] **Address validation**: Invalid address shows warning
- [ ] **Email validation**: Invalid email shows warning
- [ ] **Duplicates**: Warning if customer with similar name/phone exists
- [ ] **Notes**: Can add customer notes (preferences, service history)
- [ ] **Save**: Customer saves with unique ID

### 6.2 Customer Directory
- [ ] **List view**: All customers displayed in searchable list
- [ ] **Search**: Can search by name, phone, email
- [ ] **Filter**: Can filter by recent, no jobs, high-value, etc.
- [ ] **Sort**: Can sort by name, creation date, last contact
- [ ] **Pagination**: Handles 100+ customers without lag
- [ ] **Quick add**: "Add customer" button accessible from multiple pages

### 6.3 Customer Details
- [ ] **Profile page**: Shows customer name, contact info, address
- [ ] **Contact history**: Shows all interactions (calls, SMS, estimates)
- [ ] **Job history**: Shows all past jobs and appointments
- [ ] **Payment history**: Shows all invoices and payments
- [ ] **Edit**: Can edit customer info
- [ ] **Communication log**: All customer communications timestamped and logged

### 6.4 Customer Communication
- [ ] **SMS to customer**: Can send SMS from customer details page
- [ ] **Email to customer**: Can send email (if email configured)
- [ ] **Call to customer**: Can initiate call (if telephony integrated)
- [ ] **Message log**: All messages logged and timestamped
- [ ] **Inbound SMS**: Inbound SMS from customer logged to conversation

---

## 7. LEADS & INTAKE

### 7.1 Lead Capture
- [ ] **Inbound call**: Call routed to AI, transcribed, lead created
- [ ] **Inbound SMS**: SMS from unknown number creates lead
- [ ] **Web form**: Online lead form creates lead (if deployed)
- [ ] **Lead data**: Phone, address, service type captured automatically
- [ ] **Confidence**: Lead matched to existing customer if similar phone/name
- [ ] **Duplicate prevention**: System warns if similar lead exists

### 7.2 Lead Management
- [ ] **Lead list**: All leads displayed with status and source
- [ ] **Filter by status**: New, Contacted, Converted, Lost
- [ ] **Filter by source**: Phone, SMS, Web, etc.
- [ ] **Search**: Can search by phone, address, service type
- [ ] **Bulk actions**: Can mark multiple leads as contacted/lost
- [ ] **Assign**: Can assign lead to technician (if applicable)
- [ ] **Add note**: Can add follow-up notes to lead

### 7.3 Lead Conversion
- [ ] **Convert to customer**: Can convert lead to customer with one click
- [ ] **Create appointment**: Can create appointment from lead
- [ ] **Create estimate**: Can create estimate from lead
- [ ] **Link job**: Can link lead to completed job
- [ ] **Mark lost**: Can mark lead as lost with reason

---

## 8. JOBS & WORKFLOW

### 8.1 Create Job
- [ ] **From appointment**: Job created when appointment confirmed
- [ ] **From estimate**: Job created when estimate approved
- [ ] **Manual creation**: Can create job manually
- [ ] **Job details**: Shows customer, location, service type, appointment time
- [ ] **Job notes**: Can add job-specific notes
- [ ] **Technician assignment**: Assigned technician shown
- [ ] **Required materials**: Can attach materials list (if applicable)

### 8.2 Job Lifecycle
- [ ] **Status tracking**: Job shows status (Scheduled, In Progress, Complete, Invoiced)
- [ ] **Technician check-in**: Technician can mark job started (via app/SMS)
- [ ] **Photos**: Technician can upload before/after photos
- [ ] **Job completion**: Technician can mark job complete
- [ ] **Time tracking**: Job duration tracked (if configured)
- [ ] **Invoice from job**: Can create invoice after job completion

### 8.3 Job History
- [ ] **Job details**: Shows all job history and timeline
- [ ] **Dispatch view**: Shows jobs by date/technician
- [ ] **Map view**: Shows job locations on map (if available)
- [ ] **Search**: Can search jobs by customer, location, date
- [ ] **Filter**: Can filter by status, technician, service type, date range

---

## 9. VOICE & TELEPHONY

### 9.1 Inbound Call Handling
- [ ] **Call received**: Incoming call goes to AI (not voicemail)
- [ ] **Greeting**: AI answers with professional greeting
- [ ] **Intent recognition**: AI understands if caller wants estimate, schedule, payment, etc.
- [ ] **Customer identification**: AI identifies existing customer by phone
- [ ] **Service type**: AI asks for service type (HVAC, Plumbing)
- [ ] **Time slot**: AI offers available appointment times
- [ ] **Appointment confirmed**: AI confirms appointment details
- [ ] **Callback**: AI confirms callback number
- [ ] **Call recording**: Call recorded (with compliance disclosure)
- [ ] **Transcript**: Call transcript generated and logged

### 9.2 Voicemail Handling
- [ ] **Voicemail fallback**: If unavailable, call goes to voicemail
- [ ] **Transcription**: Voicemail transcribed and logged
- [ ] **Alert**: Owner notified of voicemail
- [ ] **Callback**: Can reply to voicemail via SMS
- [ ] **Contact**: Voicemail includes voicemail caller's phone

### 9.3 Outbound Calls
- [ ] **Call customer**: Can initiate call to customer from CRM
- [ ] **Call technician**: Can call technician (if integrated)
- [ ] **Call tracking**: Outbound calls logged with duration
- [ ] **Recording**: Recording available (if enabled)

### 9.4 Voice Clarity & Transcription
- [ ] **Accent handling**: AI understands various accents
- [ ] **Noise handling**: AI handles background noise (common in shops)
- [ ] **Clarification**: AI asks for clarification if unclear (doesn't guess)
- [ ] **Transcript accuracy**: Transcripts readable and accurate
- [ ] **Special characters**: Phone numbers, addresses spelled out correctly

---

## 10. SMS MESSAGING

### 10.1 Outbound SMS
- [ ] **SMS sends**: SMS to customer with appointment/estimate/invoice link
- [ ] **Link included**: SMS includes clickable link
- [ ] **Formatting**: Link text readable, not truncated
- [ ] **Delivery**: SMS delivered (confirmed via SMS provider status)
- [ ] **Logging**: All SMS logged with timestamp and status

### 10.2 Inbound SMS
- [ ] **Message received**: Inbound SMS from customer received
- [ ] **Logging**: SMS logged to customer record
- [ ] **Conversation**: SMS appears in conversation thread
- [ ] **Intent**: AI can interpret SMS intent (confirm appointment, ask question, etc.)
- [ ] **Response**: Can reply to SMS from CRM
- [ ] **Keywords**: Inbound SMS with keywords (e.g., "confirm", "reschedule") handled

### 10.3 SMS Compliance
- [ ] **Opt-in**: SMS only sent to opted-in customers
- [ ] **Opt-out**: Customer can opt out (unsubscribe keywords)
- [ ] **Opt-out honored**: No SMS sent to opted-out numbers
- [ ] **STOP response**: "STOP" keyword unsubscribes customer

---

## 11. DISPATCH & SCHEDULING (Operator View)

### 11.1 Dispatch Board
- [ ] **Board loads**: Dispatch board shows all jobs for day/week
- [ ] **By technician**: Jobs grouped by assigned technician
- [ ] **By time**: Jobs shown chronologically
- [ ] **Color coding**: Different status shown by color
- [ ] **Drag & drop**: Can drag job to reassign technician (if supported)
- [ ] **Add job**: Can add job to board
- [ ] **Remove job**: Can remove/cancel job

### 11.2 Technician Assignments
- [ ] **Assign technician**: Can assign job to available technician
- [ ] **Capacity**: System warns if technician overbooked
- [ ] **Travel time**: System considers travel time between jobs (if available)
- [ ] **Skills**: System alerts if technician unqualified for job (if tracked)
- [ ] **Availability**: Shows technician's calendar/availability

### 11.3 Route Optimization
- [ ] **Route**: Jobs ordered logically by location/time
- [ ] **Map**: Can view technician's route on map (if available)
- [ ] **ETA**: System shows estimated arrival time (if location data available)

---

## 12. REPORTS & ANALYTICS

### 12.1 Dashboard Metrics
- [ ] **Revenue today**: Shows today's collected revenue
- [ ] **Revenue this month**: Shows month-to-date revenue
- [ ] **Pending estimates**: Shows count and total value
- [ ] **Unpaid invoices**: Shows count and total value
- [ ] **Appointments**: Shows scheduled appointments
- [ ] **Completed jobs**: Shows completed jobs this period
- [ ] **Average job value**: Shows average job value
- [ ] **Response time**: Shows average time to first contact (if available)

### 12.2 Report Generation
- [ ] **Revenue report**: Can generate revenue report by date range
- [ ] **Job report**: Can generate job report with completion rates
- [ ] **Customer report**: Can generate customer list with contact info
- [ ] **Invoice report**: Can generate invoice aging report
- [ ] **Export**: Reports can be exported as CSV or PDF
- [ ] **Accuracy**: Report totals match dashboard and invoice data

### 12.3 Trends & Forecasting
- [ ] **Weekly revenue**: Shows revenue trend over time
- [ ] **Job volume**: Shows job volume trend
- [ ] **Win rate**: Shows estimate approval rate (if tracked)

---

## 13. SETTINGS & CONFIGURATION

### 13.1 Business Settings
- [ ] **Business name**: Can set business name
- [ ] **Phone number**: Can set main business phone
- [ ] **Business hours**: Can set operating hours by day
- [ ] **Time zone**: Can set tenant time zone
- [ ] **Address**: Can set business address
- [ ] **Logo**: Can upload business logo (if applicable)
- [ ] **Color scheme**: Can customize brand colors (if applicable)

### 13.2 Service Configuration
- [ ] **Service types**: Can add/edit service types (HVAC, Plumbing, etc.)
- [ ] **Service pricing**: Can set standard pricing for services
- [ ] **Tax rate**: Can set default tax rate for invoices
- [ ] **Deposit requirement**: Can set deposit % or amount
- [ ] **Payment terms**: Can set default invoice payment terms

### 13.3 SMS Configuration
- [ ] **SMS enabled**: Can enable/disable SMS messaging
- [ ] **SMS number**: Configured SMS number shown
- [ ] **Opt-in list**: Can manage SMS opt-in list

### 13.4 Telephony Configuration
- [ ] **Forwarding number**: Main phone number configured
- [ ] **Call routing**: Calls route to correct queue/voice AI
- [ ] **Hours**: Call routing respects business hours (if configured)
- [ ] **Voicemail**: Voicemail greeting customizable (if supported)

### 13.5 Integrations
- [ ] **Stripe connected**: Stripe account connected
- [ ] **Twilio connected**: Twilio account connected (if SMS/voice used)
- [ ] **Google Maps**: Address autocomplete working
- [ ] **Other integrations**: Any third-party APIs configured

### 13.6 User Management
- [ ] **Add user**: Can add technician/staff user
- [ ] **Role assignment**: Can assign role (owner, technician, admin)
- [ ] **Permissions**: Role-based permissions enforced
- [ ] **Deactivate user**: Can deactivate user without deleting
- [ ] **Password reset**: Can force password reset for user

---

## 14. MOBILE APP (if applicable)

### 14.1 Mobile Authentication
- [ ] **Login**: Can log in on mobile
- [ ] **Auto-lock**: App locks after X minutes of inactivity
- [ ] **Biometric**: Biometric login works (if enabled)
- [ ] **Session**: Session persists after app restart

### 14.2 Mobile Dashboard
- [ ] **Loads**: Mobile dashboard loads on 4G/LTE in <3s
- [ ] **Metrics**: All key metrics visible without scrolling
- [ ] **Responsive**: No horizontal scroll at 375px width
- [ ] **Tap targets**: All buttons/links ≥44px tap target

### 14.3 Mobile Technician Features
- [ ] **Job list**: Technician sees assigned jobs
- [ ] **Job details**: Can view job details, customer info
- [ ] **Check-in**: Can mark job started
- [ ] **Photos**: Can take/upload job photos
- [ ] **Notes**: Can add job notes
- [ ] **Complete**: Can mark job complete
- [ ] **Map**: Can view job location on map
- [ ] **Navigation**: Can launch navigation to job

### 14.4 Mobile Offline
- [ ] **Offline capable**: Basic features work offline (if supported)
- [ ] **Sync**: Data syncs when connection restored
- [ ] **Offline indicators**: App shows offline status

---

## 15. ERROR HANDLING & EDGE CASES

### 15.1 Network Errors
- [ ] **No connection**: App shows "offline" or "connection error"
- [ ] **Slow connection**: App shows loading state, doesn't hang
- [ ] **Timeout**: Long requests show timeout error after X seconds
- [ ] **Retry**: Failed requests can be retried

### 15.2 Input Validation
- [ ] **Required fields**: Cannot submit form with missing required fields
- [ ] **Email format**: Invalid email rejected
- [ ] **Phone format**: Invalid phone rejected
- [ ] **Currency**: Currency inputs validate as numbers
- [ ] **Date range**: End date cannot be before start date
- [ ] **Future dates**: Cannot select past dates for appointments

### 15.3 Concurrency & Race Conditions
- [ ] **Duplicate submission**: Double-clicking submit doesn't create duplicate
- [ ] **Stale data**: Editing stale data shows conflict warning
- [ ] **Multi-user**: Multiple users can work on same tenant without conflicts

### 15.4 Data Integrity
- [ ] **Money precision**: No float rounding errors in financial data
- [ ] **Timezone handling**: All dates stored/displayed in correct timezone
- [ ] **Audit trail**: All mutations recorded in audit table
- [ ] **No data loss**: Database constraints prevent orphaned records

### 15.5 Permission & Security
- [ ] **RLS enforced**: Tenant data not accessible across tenants
- [ ] **Role-based access**: Users can only see data for their role
- [ ] **Password security**: Passwords hashed, never logged
- [ ] **Token security**: Auth tokens expire, cannot be reused
- [ ] **HTTPS**: All traffic encrypted (no HTTP)

---

## 16. PERFORMANCE & LOAD

### 16.1 Page Load Times
- [ ] **Dashboard**: <2s on cable (Desktop)
- [ ] **Dashboard**: <3s on 4G (Mobile)
- [ ] **Customer list (100 customers)**: <2s
- [ ] **Job list (30 jobs)**: <2s
- [ ] **Search**: Search results appear within 500ms

### 16.2 API Response Times
- [ ] **Create estimate**: <500ms
- [ ] **Send SMS**: <1s (async)
- [ ] **Process payment**: <2s
- [ ] **Voice transcription**: Complete within 30s of call end

### 16.3 Concurrency
- [ ] **100 concurrent users**: System handles without errors
- [ ] **Payment processing**: Multiple simultaneous payments processed
- [ ] **SMS sending**: Queue handles bulk SMS without delays

---

## 17. AI & PROPOSAL QUALITY

### 17.1 AI Call Handling
- [ ] **Professional**: AI voice sounds natural and professional
- [ ] **Accurate**: AI correctly captures appointment details
- [ ] **Backoff**: AI asks for clarification, doesn't guess
- [ ] **Failures**: AI offers callback/SMS option on error
- [ ] **Handoff**: Can hand off to human agent (if configured)

### 17.2 Proposal Generation
- [ ] **Estimates**: AI-generated estimates are reasonable and complete
- [ ] **Pricing**: All prices within catalog or flagged as uncertain
- [ ] **Confidence**: Low-confidence estimates don't auto-approve
- [ ] **Clarity**: Generated text is clear and professional

### 17.3 Entity Resolution
- [ ] **Customer matching**: AI correctly identifies existing customers
- [ ] **Address normalization**: Addresses normalized correctly
- [ ] **Service type**: Service type correctly identified
- [ ] **Ambiguity**: Ambiguous references trigger clarification

---

## 18. SECURITY & COMPLIANCE

### 18.1 Authentication
- [ ] **Login security**: Brute-force protection (if configured)
- [ ] **Session management**: Sessions expire after X minutes
- [ ] **Password policy**: Passwords meet minimum requirements
- [ ] **2FA**: Two-factor authentication works (if enabled)

### 18.2 Data Protection
- [ ] **PII encryption**: Sensitive data encrypted at rest (if required)
- [ ] **Payment data**: PCI-DSS compliance (Stripe handles)
- [ ] **Audit logs**: All sensitive actions logged
- [ ] **Data deletion**: Customer data can be deleted (if required)

### 18.3 Rate Limiting
- [ ] **API rate limits**: API enforces rate limiting
- [ ] **SMS limits**: SMS not sent excessively to same customer
- [ ] **Call frequency**: Calls not placed excessively (avoid harassment)

---

## 19. KNOWN ISSUES & WAIVERS

Document any known issues or features not yet implemented:

- **Issue**: [Description]  
  **Severity**: [Critical/High/Medium/Low]  
  **Workaround**: [If any]  
  **Tracked in**: [Issue #, JIRA, etc.]  

---

## 20. TEST EXECUTION NOTES

### Per-Run Checklist
- [ ] **Environment**: Testing against production/staging? [Specify]
- [ ] **Browser**: Chrome, Firefox, Safari? [Specify versions]
- [ ] **Devices**: Desktop tested at [width]px, Mobile at [width]px, Tablet at [width]px
- [ ] **Time**: Started at [time], completed at [time]
- [ ] **Tester**: [Name/initials]
- [ ] **Remarks**: [Any notable observations, system issues, unexpected behavior]

