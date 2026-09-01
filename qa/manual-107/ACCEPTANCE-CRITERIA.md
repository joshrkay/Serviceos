# ServiceOS Manual QA — Acceptance Criteria Ledger (107)

Generated: 2026-07-25T14:02:55.947Z

Reconstructed in-repo because the Mac-path accounting file was unavailable to the cloud agent. Sources: docs/beta-verification-runbook.md, e2e/qa-matrix/matrix.ts, docs/superpowers/specs/2026-05-24-platform-assessment-and-e2e-qa-50-workflows.md, and the 22-section goal order.

## Summary

| Status | Count |
|---|---|
| PASS | 0 |
| FAIL | 0 |
| NOT_RUN | 107 |

## Index

| ID | Section | Name | Tenant | Role | Primary ref |
|---|---|---|---|---|---|
| QA-001 | 1. Authentication and access | Signup page loads with Rivet branding | none | anonymous | beta 1.1; WF-01 |
| QA-002 | 1. Authentication and access | Fresh signup completes Clerk flow | C | owner | beta 1.2; WF-01 |
| QA-003 | 1. Authentication and access | /api/me returns tenantId after bootstrap | A|C | owner | beta 1.4; ME-01; WF-01 |
| QA-004 | 1. Authentication and access | Session survives hard reload; logout lands on /login | A | owner | beta 1.5–1.6; WF-02 |
| QA-005 | 1. Authentication and access | Protected route redirects when logged out | none | anonymous | beta 1.7; WF-03 |
| QA-006 | 2. Onboarding and go-live | Land onboarding or dashboard after signup | C | owner | beta 1.3; WF-06 |
| QA-007 | 2. Onboarding and go-live | Onboarding v2 identity→pack→phone→billing | C | owner | WF-06; PROV-01 |
| QA-008 | 2. Onboarding and go-live | HVAC pack activated via configure | A | owner | PROV-01 |
| QA-009 | 2. Onboarding and go-live | Plumbing pack distinct from HVAC | A | owner | PROV-02 |
| QA-010 | 2. Onboarding and go-live | Twilio subaccount provisions phone | A | owner+system | beta 16.6–16.10; WF-07 |
| QA-011 | 3. CRM and customers | Create customer (UI + API) | A | owner | CUST-01; WF-11; beta 2.1–2.5 |
| QA-012 | 3. CRM and customers | Primary + second service location | A | owner | LOC-01; beta 2.3, 2.6–2.8 |
| QA-013 | 3. CRM and customers | Customer notes CRUD + surface on job | A | owner | NOTE-01; beta 2.9–2.12 |
| QA-014 | 3. CRM and customers | Edit phone + search by last name | A | owner | WF-12; beta 2.17–2.18 |
| QA-015 | 3. CRM and customers | Archive customer drops from active list | A | owner | CUST-03; beta 2.19 |
| QA-016 | 3. CRM and customers | Customer history shows job/estimate/invoice | A | owner | beta 2.13–2.16; JRN-03 |
| QA-017 | 4. Leads and conversion | Manual lead create + note | A | owner | LEAD-01; beta 3.1–3.4; WF-14 |
| QA-018 | 4. Leads and conversion | Public intake → lead with source tag | A | anonymous | beta 3.5–3.8; WF-16; JRN-03 |
| QA-019 | 4. Leads and conversion | Lead stage progression (won-guard) | A | owner | LEAD-01 |
| QA-020 | 4. Leads and conversion | Lead lost with reason | A | owner | LEAD-02 |
| QA-021 | 4. Leads and conversion | Convert lead → customer (link preserved) | A | owner | beta 3.9–3.12; WF-15; JRN-03 |
| QA-022 | 5. Jobs | Create job on primary location | A | owner | JOB-01; WF-17; beta 4.1–4.6 |
| QA-023 | 5. Jobs | Job lifecycle new→scheduled→in_progress→completed | A | owner | JOB-01; WF-18; beta 4.7–4.10 |
| QA-024 | 5. Jobs | Invalid job transition rejected | A | owner | JOB-02 |
| QA-025 | 5. Jobs | Job photos upload + render | A | owner | beta 4.14–4.16 |
| QA-026 | 5. Jobs | Job notes persist + customer activity | A | owner | NOTE-01; beta 4.17–4.19 |
| QA-027 | 6. Scheduling | Calendar loads; create appointment | A | owner | SCH-01; WF-19; beta 7.1–7.5 |
| QA-028 | 6. Scheduling | Reschedule via API/UI (version bump) | A | owner | SCH-01; WF-20; beta 7.8–7.10 |
| QA-029 | 6. Scheduling | Overlap conflict indicator | A | owner/dispatcher | beta 7.6–7.7, 7.9 |
| QA-030 | 6. Scheduling | Appointment status lifecycle confirm→complete | A | owner | SCH-04 |
| QA-031 | 6. Scheduling | Running-late delay notice (virtual status) | A | owner/dispatcher | SCH-05; beta 7.14–7.18 |
| QA-032 | 7. Dispatch | GET /api/dispatch/board responds | A | owner/dispatcher | beta §8; WF-23 |
| QA-033 | 7. Dispatch | Assign / reassign technician lane | A | dispatcher | WF-23–24; beta 7.11 |
| QA-034 | 7. Dispatch | Feasibility / conflict warnings | A | dispatcher | WF-24; PROP-04 |
| QA-035 | 7. Dispatch | Technician GPS ping stored | A | technician | beta 8.8–8.10 |
| QA-036 | 8. Technician workflows | /technician/day shows assigned work | A | technician | WF-26; beta 12.1–12.3 |
| QA-037 | 8. Technician workflows | Tech status CTA updates job | A | technician | WF-27; beta 12.6; JOB-01 |
| QA-038 | 8. Technician workflows | Clock-in → clock-out time entry | A | technician/owner | TIME-01; WF-22; beta 4.11–4.13 |
| QA-039 | 8. Technician workflows | Tech voice note appears on job | A | technician | beta 12.4–12.5 |
| QA-040 | 9. Estimates | Create draft estimate (integer cents) | A | owner | EST-01/04; WF-28; beta 5.1–5.7 |
| QA-041 | 9. Estimates | Validation errors on invalid create | A | owner | EST-02 |
| QA-042 | 9. Estimates | Edit draft + revise sent (versioned) | A | owner | EST-03; EST-R1 |
| QA-043 | 9. Estimates | Mixed line items create→send→accept | A | owner | JRN-01; WF-29–30 |
| QA-044 | 9. Estimates | Send estimate SMS + public approve | A | owner+customer | PORT-01; WF-29–30; beta 5.8–5.16 |
| QA-045 | 9. Estimates | Convert estimate → invoice (linked) | A | owner | EST-05; WF-31; beta 6.1–6.4 |
| QA-046 | 10. Invoices and payments | Invoice issue → void lifecycle | A | owner | INV-01; INV-CR-01 |
| QA-047 | 10. Invoices and payments | Invalid invoice transition rejected | A | owner | INV-02 |
| QA-048 | 10. Invoices and payments | Issue + delivery (email/SMS) | A | owner | INV-03; WF-32; beta 6.10–6.12 |
| QA-049 | 10. Invoices and payments | Public pay via Stripe test card | A | customer | PORT-02; WF-33; beta 6.13–6.19 |
| QA-050 | 10. Invoices and payments | Partial → full pay + overpay guard | A | owner | PAY-01; WF-34 |
| QA-051 | 10. Invoices and payments | Deposit credit on first invoice | A | owner | PAY-02 |
| QA-052 | 10. Invoices and payments | Stripe webhook paid + idempotency | A | system | INV-05/06; beta 17.31–17.32 |
| QA-053 | 11. Contracts | Create maintenance contract | A | owner | MC-01; beta 13.1–13.4 |
| QA-054 | 11. Contracts | Contract visible on customer profile | A | owner | beta 13.5 |
| QA-055 | 11. Contracts | Recurring agreement pause→resume→cancel | A | owner | AGR-01/02 |
| QA-056 | 12. Reports and reconciliation | Money dashboard after paid revenue | A | owner | RPT-01; PAY-03; WF-35 |
| QA-057 | 12. Reports and reconciliation | Revenue-by-source report | A | owner | RPT-02 |
| QA-058 | 12. Reports and reconciliation | Time-given-back report | A | owner | RPT-03 |
| QA-059 | 12. Reports and reconciliation | Overdue invoice → job money_state | A | owner+worker | PAY-04; INV-07; WF-35 |
| QA-060 | 13. Proposals | Proposal create + draft reject guard | A | owner | PROP-01; WF-36–37 |
| QA-061 | 13. Proposals | Proposal inbox prioritization | A | owner | PROP-02; WF-41 |
| QA-062 | 13. Proposals | Cross-tenant proposal denial | B | owner | PROP-03 |
| QA-063 | 13. Proposals | Approve booking proposal executes | A | owner | WF-36; SCH-02 |
| QA-064 | 13. Proposals | Edit proposal before approve | A | owner | WF-38 |
| QA-065 | 14. Communications and interactions | Conversation + message thread | A | owner | CONV-01 |
| QA-066 | 14. Communications and interactions | Interactions show SMS/email dispatches | A | owner | beta 9.1–9.3; SMS-01 |
| QA-067 | 14. Communications and interactions | Customer comms history links entities | A | owner | beta 9.5–9.7 |
| QA-068 | 14. Communications and interactions | Dispatch idempotency window | A | owner | beta 9.4; SMS-01 |
| QA-069 | 15. Assistant and in-app voice | Assistant chat loads + grounded answers | A | owner | AST-01–06; beta 11.1–11.4; WF-39 |
| QA-070 | 15. Assistant and in-app voice | Create customer via assistant | A | owner | AST-01; CUST-02 |
| QA-071 | 15. Assistant and in-app voice | Create/revise estimate via assistant | A | owner | AST-02/03 |
| QA-072 | 15. Assistant and in-app voice | In-app voice bar / mic transcript | A | owner | WF-40/45; beta 11.7–11.8 |
| QA-073 | 15. Assistant and in-app voice | Conversation history persists across tabs | A | owner | beta 11.5–11.6 |
| QA-074 | 16. Inbound voice calls | Live Twilio call connects + greets | A | caller | beta 15.1–15.2; WF-08/42 |
| QA-075 | 16. Inbound voice calls | Identify customer + book proposal | A | caller→owner | SCH-02; CUST-02; WF-42 |
| QA-076 | 16. Inbound voice calls | Emergency triage escalation | A | caller | VOX-01; WF-43; beta 15.7 |
| QA-077 | 16. Inbound voice calls | Spanish / i18n voice response | A | caller | VOX-02 |
| QA-078 | 16. Inbound voice calls | Voice→estimate/invoice proposals | A | caller→owner | VOX-05–08, VOX-11 |
| QA-079 | 16. Inbound voice calls | Session in interactions + DB artifacts | A | owner | VOX-09/10; WF-44; beta 15.8–15.9 |
| QA-080 | 17. Notifications and compliance | Outbound SMS dispatch + entity_type CHECK | A | owner | SMS-01; beta 7.12–7.13 |
| QA-081 | 17. Notifications and compliance | SMS consent / DNC gating | A | owner | SMS-02; VOX-03 |
| QA-082 | 17. Notifications and compliance | Appointment confirmation SMS natural copy | A | owner | beta 7.12–7.13 |
| QA-083 | 17. Notifications and compliance | Delay notice idempotency | A | owner | SCH-05; beta 7.18 |
| QA-084 | 18. Public and customer self-service | Public estimate approve/reject + re-open | A | customer | PORT-01; WF-30; beta 10.1–10.4 |
| QA-085 | 18. Public and customer self-service | Public invoice view + paid state | A | customer | PORT-02; beta 10.5–10.7 |
| QA-086 | 18. Public and customer self-service | Customer portal token-scoped data | A | customer | WF-47; beta 10.8–10.10 |
| QA-087 | 18. Public and customer self-service | Intake form vertical fields | A | anonymous | beta 10.11–10.13; WF-16 |
| QA-088 | 18. Public and customer self-service | Post-job feedback submit | A | customer | WF-49; beta 10.14–10.16 |
| QA-089 | 19. Settings | Read + update tenant settings | A | owner | SET-01; beta 14.1–14.2 |
| QA-090 | 19. Settings | Terminology / AI approval / deposit rules | A | owner | beta 14.4–14.7 |
| QA-091 | 19. Settings | Templates + price book (catalog CRUD) | A | owner | CAT-01; beta 14.12–14.14 |
| QA-092 | 19. Settings | Team invite Dispatcher + Technician | A | owner→dispatcher/tech | beta 16.13–16.20 |
| QA-093 | 19. Settings | Current-user profile + mode switch | A | owner | ME-01 |
| QA-094 | 20. Google Calendar | Connect Google OAuth (auth URL) | A | owner | WF-50; CAL-01 |
| QA-095 | 20. Google Calendar | Appointment create/assign → synced event | A | owner | WF-50; SCH-01 |
| QA-096 | 20. Google Calendar | Disconnect clears integration | A | owner | WF-50 |
| QA-097 | 21. Multi-tenant isolation and security | Cross-tenant reads blocked | B | owner | ISO-01; beta 17.5–17.13; WF-04 |
| QA-098 | 21. Multi-tenant isolation and security | Cross-tenant writes blocked | B | owner | ISO-01; beta 17.14–17.17 |
| QA-099 | 21. Multi-tenant isolation and security | Technician RBAC | A | technician | beta 17.18–17.24 |
| QA-100 | 21. Multi-tenant isolation and security | Public token isolation / no internal IDs | A/B | anonymous | beta 17.25–17.28; PORT-01/02 |
| QA-101 | 21. Multi-tenant isolation and security | Twilio/Stripe webhook tenant routing | A/B | system | beta 17.29–17.32 |
| QA-102 | 21. Multi-tenant isolation and security | RLS with GUC + no-GUC fail-closed | A/B | qa_readonly | ISO-01; beta 17.33–17.35 |
| QA-103 | 21. Multi-tenant isolation and security | Estimate tenant isolation row | B | owner | EST-06 |
| QA-104 | 21. Multi-tenant isolation and security | Feature-flag admin platform-gated | A | owner | FLAG-01 |
| QA-105 | 22. Miscellaneous and hidden-route checks | Golden funnel intake→invoice issued | A | owner | JRN-03 |
| QA-106 | 22. Miscellaneous and hidden-route checks | Three-estimate billing journey (2 paid) | A | owner | JRN-02 |
| QA-107 | 22. Miscellaneous and hidden-route checks | Hidden routes + telephony gap documentation | A | owner | VOX-04; MC-01; RPT-02 |

## Full acceptance criteria

### QA-001 — Signup page loads with Rivet branding

- **Section:** 1. Authentication and access
- **Purpose:** Prove the unauthenticated signup surface loads without console errors.
- **Primary ref:** beta 1.1; WF-01
- **Tenant:** none
- **Role:** anonymous
- **Preconditions:** E2E_BASE_URL reachable; Web deploy healthy
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Open /signup in a clean browser profile
  1. Open DevTools console
  1. Confirm page render
- **Expected UI:** Rivet branding visible; No blank screen; No uncaught console errors
- **Expected API:** Static assets 200
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Page does not require auth
- **Negative assertions:** No Fieldly-only dead branding as sole title; No raw stack traces
- **Required evidence:** recording; screenshot of /signup; console log empty of errors
- **Cleanup:** —
- **PASS only if:**
  - Signup page loads
  - Brand signal present
  - Zero console errors
- **FAIL if:**
  - Blank page
  - Console errors
  - Redirect loop
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-002 — Fresh signup completes Clerk flow

- **Section:** 1. Authentication and access
- **Purpose:** Prove a disposable email can create an auth session via Clerk.
- **Primary ref:** beta 1.2; WF-01
- **Tenant:** C
- **Role:** owner
- **Preconditions:** Clerk test instance; Disposable inbox
- **Fixtures:** fresh email
- **External resources:** Clerk
- **Manual steps:**
  1. Sign up with fresh test email
  1. Complete Clerk verification
  1. Land in app
- **Expected UI:** No Clerk error screen; Redirect to /onboarding or /dashboard
- **Expected API:** Session cookie/JWT present
- **Expected DB:** tenants row created OR pending webhook
- **Expected workers/webhooks:** Clerk user.created webhook processed
- **Expected authz/isolation:** Authenticated after signup
- **Negative assertions:** No duplicate tenant for same email on first signup
- **Required evidence:** recording; redacted /api/me response
- **Cleanup:** Mark Tenant C disposable
- **PASS only if:**
  - Clerk flow completes
  - User session established
- **FAIL if:**
  - Error screen
  - Stuck on signup
  - No session
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-003 — /api/me returns tenantId after bootstrap

- **Section:** 1. Authentication and access
- **Purpose:** Prove Clerk webhook + Postgres tenant bootstrap succeeded.
- **Primary ref:** beta 1.4; ME-01; WF-01
- **Tenant:** A|C
- **Role:** owner
- **Preconditions:** Authenticated session
- **Fixtures:** —
- **External resources:** Clerk webhook
- **Manual steps:**
  1. Open DevTools Network
  1. Locate GET /api/me
  1. Confirm tenantId
- **Expected UI:** App shell loads
- **Expected API:** GET /api/me → 200 with tenantId
- **Expected DB:** tenants.id matches /api/me.tenantId
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** JWT tenant_id matches row
- **Negative assertions:** tenantId not null/empty
- **Required evidence:** recording; redacted api-response.json; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - /api/me 200
  - tenantId present
  - DB row exists
- **FAIL if:**
  - 401/500
  - Missing tenantId
  - No tenant row
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-004 — Session survives hard reload; logout lands on /login

- **Section:** 1. Authentication and access
- **Purpose:** Prove session persistence and clean logout.
- **Primary ref:** beta 1.5–1.6; WF-02
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Logged in
- **Fixtures:** —
- **External resources:** Clerk
- **Manual steps:**
  1. Hard reload (Ctrl+Shift+R)
  1. Confirm still logged in
  1. Sign out
  1. Confirm /login
- **Expected UI:** Still in app after reload; After logout: /login
- **Expected API:** /api/me 200 before logout; 401 after
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Session revoked after logout
- **Negative assertions:** No access to /customers after logout
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - Reload keeps session
  - Logout → /login
  - Protected routes blocked
- **FAIL if:**
  - Logged out after reload
  - Logout no-op
  - Still authenticated after logout
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-005 — Protected route redirects when logged out

- **Section:** 1. Authentication and access
- **Purpose:** Prove auth gate on /customers.
- **Primary ref:** beta 1.7; WF-03
- **Tenant:** none
- **Role:** anonymous
- **Preconditions:** Logged out
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Navigate to /customers while logged out
- **Expected UI:** Redirect to /login
- **Expected API:** GET /api/customers without auth → 401/403
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** No tenant data leaked
- **Negative assertions:** Customer list never rendered
- **Required evidence:** recording; screenshot of redirect
- **Cleanup:** —
- **PASS only if:**
  - Redirect to /login
  - API denies unauth
- **FAIL if:**
  - Customers page visible
  - API 200 without auth
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-006 — Land onboarding or dashboard after signup

- **Section:** 2. Onboarding and go-live
- **Purpose:** Prove post-signup routing is not a blank screen.
- **Primary ref:** beta 1.3; WF-06
- **Tenant:** C
- **Role:** owner
- **Preconditions:** Just completed signup
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Observe landing route after signup
- **Expected UI:** /onboarding or /dashboard; No blank screen
- **Expected API:** —
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Not stuck on /signup
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - Valid post-signup route
- **FAIL if:**
  - Blank screen
  - Error boundary
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-007 — Onboarding v2 identity→pack→phone→billing

- **Section:** 2. Onboarding and go-live
- **Purpose:** Prove onboarding wizard advances through core steps.
- **Primary ref:** WF-06; PROV-01
- **Tenant:** C
- **Role:** owner
- **Preconditions:** Fresh Tenant C; Onboarding incomplete
- **Fixtures:** business identity fields
- **External resources:** Twilio sandbox optional; Stripe test
- **Manual steps:**
  1. Complete identity
  1. Select trade pack
  1. Phone step (or skip if allowed)
  1. Billing/trial step
- **Expected UI:** Checklist advances; Steps marked complete
- **Expected API:** Onboarding status endpoints reflect progress
- **Expected DB:** tenant_settings updated; vertical pack active
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Owner only
- **Negative assertions:** Cannot skip required identity without validation
- **Required evidence:** recording; api status snapshots
- **Cleanup:** Keep Tenant C for later onboarding negatives
- **PASS only if:**
  - Wizard advances
  - Pack persisted
- **FAIL if:**
  - Step stuck
  - Progress not persisted after refresh
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-008 — HVAC pack activated via configure

- **Section:** 2. Onboarding and go-live
- **Purpose:** Prove HVAC vertical pack configuration.
- **Primary ref:** PROV-01
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Tenant A authenticated
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Call/configure services=["HVAC"] via onboarding or settings
  1. GET /api/settings and /api/verticals
- **Expected UI:** HVAC terminology/categories present
- **Expected API:** Verticals report hvac
- **Expected DB:** Pack active for tenant
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Tenant-scoped
- **Negative assertions:** Plumbing-only terms not sole active set
- **Required evidence:** api-response.json; recording
- **Cleanup:** —
- **PASS only if:**
  - HVAC pack active
  - Settings report hvac
- **FAIL if:**
  - Wrong pack
  - No pack
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-009 — Plumbing pack distinct from HVAC

- **Section:** 2. Onboarding and go-live
- **Purpose:** Prove plumbing pack is distinct.
- **Primary ref:** PROV-02
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Can activate plumbing
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Activate plumbing pack
  1. Compare categories to HVAC
- **Expected UI:** Plumbing service types appear
- **Expected API:** Verticals report plumbing
- **Expected DB:** Pack row
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Not identical to HVAC catalog
- **Required evidence:** api-response.json; recording
- **Cleanup:** Restore HVAC as primary if needed
- **PASS only if:**
  - Plumbing distinct and active
- **FAIL if:**
  - Same as HVAC
  - Activation fails
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-010 — Twilio subaccount provisions phone

- **Section:** 2. Onboarding and go-live
- **Purpose:** Prove async telephony provisioning for a tenant.
- **Primary ref:** beta 16.6–16.10; WF-07
- **Tenant:** A
- **Role:** owner+system
- **Preconditions:** Twilio credentials on Railway; Worker running
- **Fixtures:** —
- **External resources:** Twilio
- **Manual steps:**
  1. Trigger provision
  1. Wait ≤2 min
  1. Inspect tenant_integrations
- **Expected UI:** Phone number shown in settings if exposed
- **Expected API:** Integration status full_readiness
- **Expected DB:** tenant_integrations.twilio with subaccount_sid + phoneE164
- **Expected workers/webhooks:** Provisioning worker completes
- **Expected authz/isolation:** Number exclusive to tenant
- **Negative assertions:** No second number on replay
- **Required evidence:** database-assertion.txt; recording; provider receipt redacted
- **Cleanup:** —
- **PASS only if:**
  - phoneE164 present
  - status full_readiness
  - Call routes to tenant
- **FAIL if:**
  - Stuck t0_requested
  - failed
  - Shared number across tenants
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-011 — Create customer (UI + API)

- **Section:** 3. CRM and customers
- **Purpose:** Create a customer under Tenant A with phone/email.
- **Primary ref:** CUST-01; WF-11; beta 2.1–2.5
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Logged in as Tenant A owner
- **Fixtures:** QA customer name/phone/email
- **External resources:** —
- **Manual steps:**
  1. /customers → New
  1. Fill fields
  1. Save
  1. Open detail
- **Expected UI:** Customer in list; Detail shows fields
- **Expected API:** POST /api/customers → 201
- **Expected DB:** customers.tenant_id = A
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Tenant A only
- **Negative assertions:** Not visible to Tenant B
- **Required evidence:** recording; api-response.json; database-assertion.txt
- **Cleanup:** Keep as fixture customer
- **PASS only if:**
  - 201
  - List shows customer
  - DB row tenant-scoped
- **FAIL if:**
  - UI success without row
  - Wrong tenant
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-012 — Primary + second service location

- **Section:** 3. CRM and customers
- **Purpose:** Attach two locations and select primary on jobs.
- **Primary ref:** LOC-01; beta 2.3, 2.6–2.8
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Customer from QA-011
- **Fixtures:** two addresses
- **External resources:** —
- **Manual steps:**
  1. Add primary location
  1. Add second location
  1. Verify labels
- **Expected UI:** Both locations on profile; Primary labeled
- **Expected API:** Locations CRUD 2xx
- **Expected DB:** two service_locations rows
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Locations not swapped silently
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Two locations persist
  - Primary labeled
- **FAIL if:**
  - Second location missing
  - Primary unlabeled
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-013 — Customer notes CRUD + surface on job

- **Section:** 3. CRM and customers
- **Purpose:** Notes persist and appear on job context.
- **Primary ref:** NOTE-01; beta 2.9–2.12
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Customer exists
- **Fixtures:** note text
- **External resources:** —
- **Manual steps:**
  1. Add note
  1. Reload
  1. Edit note
  1. Open related job later
- **Expected UI:** Note persists; Updated text shown; Visible on job
- **Expected API:** Notes endpoints 2xx
- **Expected DB:** notes row
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Note not lost on reload
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - CRUD works
  - Surfaces on job
- **FAIL if:**
  - Note disappears
  - Edit fails
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-014 — Edit phone + search by last name

- **Section:** 3. CRM and customers
- **Purpose:** Customer edit and search.
- **Primary ref:** WF-12; beta 2.17–2.18
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Customer exists
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Edit phone
  1. Save
  1. Search by last name
- **Expected UI:** Updated phone; Search hit
- **Expected API:** PATCH customer 200
- **Expected DB:** primary_phone updated
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording; api-response.json
- **Cleanup:** —
- **PASS only if:**
  - Phone updated
  - Search finds customer
- **FAIL if:**
  - Stale phone
  - Search miss
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-015 — Archive customer drops from active list

- **Section:** 3. CRM and customers
- **Purpose:** Archive soft-hides customer.
- **Primary ref:** CUST-03; beta 2.19
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Disposable customer OR restore after
- **Fixtures:** archive-target customer
- **External resources:** —
- **Manual steps:**
  1. Archive
  1. Confirm absent from active list
  1. Restore if needed
- **Expected UI:** Gone from active list
- **Expected API:** Archive endpoint 2xx
- **Expected DB:** is_archived true
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Hard delete did not occur
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** Restore primary fixture customer
- **PASS only if:**
  - Archived flag set
  - Hidden from active list
- **FAIL if:**
  - Still in active list
  - Row deleted
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-016 — Customer history shows job/estimate/invoice

- **Section:** 3. CRM and customers
- **Purpose:** History tabs link lifecycle entities to same location.
- **Primary ref:** beta 2.13–2.16; JRN-03
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Job, estimate, invoice exist for customer
- **Fixtures:** lifecycle entities
- **External resources:** —
- **Manual steps:**
  1. Open customer detail history tabs
  1. Verify three entity types
  1. Check location link
- **Expected UI:** Job/estimate/invoice listed
- **Expected API:** History endpoints include entities
- **Expected DB:** Same location_id
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** No blank/mismatched location
- **Required evidence:** recording; final-state.png
- **Cleanup:** —
- **PASS only if:**
  - All three history entries
  - Same location
- **FAIL if:**
  - Missing entity
  - Wrong location
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-017 — Manual lead create + note

- **Section:** 4. Leads and conversion
- **Purpose:** Create a lead with note.
- **Primary ref:** LEAD-01; beta 3.1–3.4; WF-14
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Logged in
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. /leads → New
  1. Fill fields
  1. Save
  1. Add note
- **Expected UI:** Lead in list; Note saved
- **Expected API:** POST /api/leads 201
- **Expected DB:** leads row
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording; api-response.json
- **Cleanup:** —
- **PASS only if:**
  - Lead created
  - Note persists
- **FAIL if:**
  - Not created
  - Note lost
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-018 — Public intake → lead with source tag

- **Section:** 4. Leads and conversion
- **Purpose:** Unauthenticated intake creates a lead.
- **Primary ref:** beta 3.5–3.8; WF-16; JRN-03
- **Tenant:** A
- **Role:** anonymous
- **Preconditions:** Public /intake enabled for tenant
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Incognito /intake
  1. Complete form
  1. Submit
  1. Verify in /leads
- **Expected UI:** Success on intake; Lead appears in app
- **Expected API:** POST public intake 2xx
- **Expected DB:** lead source = intake
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Public path only creates for target tenant
- **Negative assertions:** No auth required; Source not blank
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Lead created
  - Source tagged intake
- **FAIL if:**
  - No lead
  - Wrong tenant
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-019 — Lead stage progression (won-guard)

- **Section:** 4. Leads and conversion
- **Purpose:** Kanban/stage moves persist with won guards.
- **Primary ref:** LEAD-01
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Open lead
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Move lead across stages
  1. Reload
- **Expected UI:** Stage badge updates
- **Expected API:** Stage PATCH 2xx
- **Expected DB:** stage persisted
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Invalid won transition blocked if applicable
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - Stage persists
- **FAIL if:**
  - Stage reverts
  - Invalid transition allowed silently
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-020 — Lead lost with reason

- **Section:** 4. Leads and conversion
- **Purpose:** Mark lead lost with reason.
- **Primary ref:** LEAD-02
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Disposable lead
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Mark lost
  1. Enter reason
  1. Save
- **Expected UI:** Status lost; Reason visible
- **Expected API:** Lost endpoint 2xx
- **Expected DB:** lost reason stored
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Cannot convert lost without reopen if guarded
- **Required evidence:** recording; api-response.json
- **Cleanup:** —
- **PASS only if:**
  - Lost + reason persisted
- **FAIL if:**
  - Lost without reason accepted when required
  - Status wrong
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-021 — Convert lead → customer (link preserved)

- **Section:** 4. Leads and conversion
- **Purpose:** Conversion creates customer and preserves link.
- **Primary ref:** beta 3.9–3.12; WF-15; JRN-03
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Convertible lead
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Convert to customer
  1. Open customer
  1. Check lead status
- **Expected UI:** Customer created; Lead status Converted
- **Expected API:** Convert 2xx
- **Expected DB:** customer linked to lead
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Lead not deleted
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Customer exists
  - Lead converted
  - Link preserved
- **FAIL if:**
  - Re-entry required for contact fields
  - Lead deleted
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-022 — Create job on primary location

- **Section:** 5. Jobs
- **Purpose:** Create job bound to primary service location.
- **Primary ref:** JOB-01; WF-17; beta 4.1–4.6
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Customer + two locations
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. /jobs/new
  1. Select customer + primary location
  1. Save
- **Expected UI:** Job in list; Detail links customer + location
- **Expected API:** POST /api/jobs 201
- **Expected DB:** jobs.location_id = primary
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Not attached to second location
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Job created
  - Primary location linked
- **FAIL if:**
  - Wrong location
  - No job row
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-023 — Job lifecycle new→scheduled→in_progress→completed

- **Section:** 5. Jobs
- **Purpose:** Valid status transitions update UI + DB.
- **Primary ref:** JOB-01; WF-18; beta 4.7–4.10
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Open job
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Transition through lifecycle
  1. Verify list badge
- **Expected UI:** Badge updates each step
- **Expected API:** transition endpoints 2xx
- **Expected DB:** status final = completed; audit events
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - All transitions succeed
  - Final status completed
- **FAIL if:**
  - Stuck status
  - List stale after refresh
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-024 — Invalid job transition rejected

- **Section:** 5. Jobs
- **Purpose:** Illegal transitions return 4xx and do not persist.
- **Primary ref:** JOB-02
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Job in draft/new
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Attempt illegal transition via API
- **Expected UI:** Error toast if via UI
- **Expected API:** 4xx
- **Expected DB:** status unchanged
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** No silent status change
- **Required evidence:** api-response.json; database-assertion.txt; recording
- **Cleanup:** —
- **PASS only if:**
  - 4xx
  - DB unchanged
- **FAIL if:**
  - 200 with illegal transition
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-025 — Job photos upload + render

- **Section:** 5. Jobs
- **Purpose:** Photo upload persists and renders.
- **Primary ref:** beta 4.14–4.16
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Job exists; Object storage configured or local stub
- **Fixtures:** small test image
- **External resources:** storage
- **Manual steps:**
  1. Upload photo on job
  1. Reload
  1. Confirm thumbnail
- **Expected UI:** Photo visible
- **Expected API:** Upload 2xx
- **Expected DB:** attachment metadata
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Upload does not crash page
- **Required evidence:** recording; final-state.png
- **Cleanup:** —
- **PASS only if:**
  - Photo persists after refresh
- **FAIL if:**
  - Crash
  - Missing after refresh
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-026 — Job notes persist + customer activity

- **Section:** 5. Jobs
- **Purpose:** Job notes persist and appear in activity.
- **Primary ref:** NOTE-01; beta 4.17–4.19
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Job exists
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Add job note
  1. Reload
  1. Check customer activity
- **Expected UI:** Note visible
- **Expected API:** Notes 2xx
- **Expected DB:** note row
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - Note persists
- **FAIL if:**
  - Note lost
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-027 — Calendar loads; create appointment

- **Section:** 6. Scheduling
- **Purpose:** Create appointment on schedule.
- **Primary ref:** SCH-01; WF-19; beta 7.1–7.5
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Job exists
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Open /schedule
  1. Create appointment
  1. Save
- **Expected UI:** Appointment on calendar
- **Expected API:** POST /api/appointments 201
- **Expected DB:** appointment row
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording; api-response.json
- **Cleanup:** —
- **PASS only if:**
  - Appointment visible + DB row
- **FAIL if:**
  - UI-only appointment
  - Timezone wrong day
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-028 — Reschedule via API/UI (version bump)

- **Section:** 6. Scheduling
- **Purpose:** Reschedule updates window and version.
- **Primary ref:** SCH-01; WF-20; beta 7.8–7.10
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Appointment exists
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Reschedule to new slot
  1. Hard refresh
- **Expected UI:** New time shown
- **Expected API:** PATCH/reschedule 2xx
- **Expected DB:** window updated; version incremented
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** No duplicate appointment
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - New time persisted
  - Single assignment
- **FAIL if:**
  - Stale time
  - Duplicate rows
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-029 — Overlap conflict indicator

- **Section:** 6. Scheduling
- **Purpose:** Overlapping assignments surface conflict UI.
- **Primary ref:** beta 7.6–7.7, 7.9
- **Tenant:** A
- **Role:** owner/dispatcher
- **Preconditions:** Tech with existing appointment
- **Fixtures:** overlapping slot attempt
- **External resources:** —
- **Manual steps:**
  1. Attempt overlapping assign
  1. Observe warning/block
- **Expected UI:** Conflict indicator
- **Expected API:** Conflict response or feasibility warning
- **Expected DB:** No illegal double book if constrained
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Silent double-book not allowed when exclusion active
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - Conflict visible or blocked
- **FAIL if:**
  - Silent overlap created
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-030 — Appointment status lifecycle confirm→complete

- **Section:** 6. Scheduling
- **Purpose:** Appointment status transitions.
- **Primary ref:** SCH-04
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Appointment scheduled
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Confirm
  1. Complete
  1. Refresh
- **Expected UI:** Status badges update
- **Expected API:** Status endpoints 2xx
- **Expected DB:** final status complete
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - Lifecycle persists
- **FAIL if:**
  - Illegal skip without error
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-031 — Running-late delay notice (virtual status)

- **Section:** 6. Scheduling
- **Purpose:** Delay notice updates virtual status / notify path.
- **Primary ref:** SCH-05; beta 7.14–7.18
- **Tenant:** A
- **Role:** owner/dispatcher
- **Preconditions:** Active appointment
- **Fixtures:** —
- **External resources:** SMS optional
- **Manual steps:**
  1. Mark running late
  1. Observe status + notification
- **Expected UI:** Running-late indicator
- **Expected API:** Delay endpoint 2xx
- **Expected DB:** Event/log row
- **Expected workers/webhooks:** Notification dispatch if configured
- **Expected authz/isolation:** —
- **Negative assertions:** Idempotent re-mark does not spam
- **Required evidence:** recording; api-response.json
- **Cleanup:** —
- **PASS only if:**
  - Delay recorded
  - UI reflects
- **FAIL if:**
  - No-op
  - Duplicate spam notifications
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-032 — GET /api/dispatch/board responds

- **Section:** 7. Dispatch
- **Purpose:** Dispatch board API/UI loads.
- **Primary ref:** beta §8; WF-23
- **Tenant:** A
- **Role:** owner/dispatcher
- **Preconditions:** Appointments exist
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Open /dispatch
  1. Observe board
- **Expected UI:** Board renders
- **Expected API:** GET /api/dispatch/board 200
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Requires dispatch permission
- **Negative assertions:** Technician without permission denied
- **Required evidence:** recording; api-response.json
- **Cleanup:** —
- **PASS only if:**
  - Board 200 + UI
- **FAIL if:**
  - 404/500
  - Blank board crash
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-033 — Assign / reassign technician lane

- **Section:** 7. Dispatch
- **Purpose:** Drag/assign updates assignment.
- **Primary ref:** WF-23–24; beta 7.11
- **Tenant:** A
- **Role:** dispatcher
- **Preconditions:** Unassigned appointment; Technician user
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Assign to tech lane
  1. Reassign
  1. Refresh
- **Expected UI:** Card moves lanes
- **Expected API:** Assign 2xx
- **Expected DB:** assignment row updated
- **Expected workers/webhooks:** Proposal path if required
- **Expected authz/isolation:** Dispatcher/owner
- **Negative assertions:** —
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Assignment persists
- **FAIL if:**
  - UI move without DB update
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-034 — Feasibility / conflict warnings

- **Section:** 7. Dispatch
- **Purpose:** Feasibility preview surfaces warnings.
- **Primary ref:** WF-24; PROP-04
- **Tenant:** A
- **Role:** dispatcher
- **Preconditions:** Conflicting assign available
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Drag into conflict
  1. Read warnings
  1. Confirm or cancel
- **Expected UI:** Warning chips/dialog
- **Expected API:** Feasibility preview includes warnings
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Warnings not silently dropped
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - Warnings visible before confirm
- **FAIL if:**
  - No warning on clear conflict
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-035 — Technician GPS ping stored

- **Section:** 7. Dispatch
- **Purpose:** Tech location ping persists.
- **Primary ref:** beta 8.8–8.10
- **Tenant:** A
- **Role:** technician
- **Preconditions:** Technician session; GPS permission
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Emit GPS ping from tech view
  1. Verify stored
- **Expected UI:** Optional map/location indicator
- **Expected API:** Ping endpoint 2xx
- **Expected DB:** location/ping row
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Tech scoped to tenant
- **Negative assertions:** —
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Ping stored
- **FAIL if:**
  - Endpoint 404/500
  - No row
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-036 — /technician/day shows assigned work

- **Section:** 8. Technician workflows
- **Purpose:** Tech day view lists assignments.
- **Primary ref:** WF-26; beta 12.1–12.3
- **Tenant:** A
- **Role:** technician
- **Preconditions:** Technician JWT/role C; Assigned appointment
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Login as tech
  1. Open /technician/day
- **Expected UI:** Assigned jobs visible; ≥44px tap targets
- **Expected API:** Day appointments 200
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Only own assignments
- **Negative assertions:** No other tech jobs
- **Required evidence:** recording; mobile viewport screenshot
- **Cleanup:** —
- **PASS only if:**
  - Assigned work listed
- **FAIL if:**
  - Empty when assigned
  - 500
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-037 — Tech status CTA updates job

- **Section:** 8. Technician workflows
- **Purpose:** Tech CTAs change job status.
- **Primary ref:** WF-27; beta 12.6; JOB-01
- **Tenant:** A
- **Role:** technician
- **Preconditions:** Assigned job
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Tap en-route/in-progress CTA
  1. Refresh
- **Expected UI:** Status updates
- **Expected API:** Transition 2xx
- **Expected DB:** job status updated
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Tech can transition assigned job
- **Negative assertions:** Cannot transition unassigned foreign job
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Status persisted
- **FAIL if:**
  - CTA no-op
  - UI-only change
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-038 — Clock-in → clock-out time entry

- **Section:** 8. Technician workflows
- **Purpose:** Time entries record duration.
- **Primary ref:** TIME-01; WF-22; beta 4.11–4.13
- **Tenant:** A
- **Role:** technician/owner
- **Preconditions:** Job exists
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Clock in
  1. Clock out
  1. Verify entry
- **Expected UI:** Time entry listed
- **Expected API:** Time entry endpoints 2xx
- **Expected DB:** time_entries row with duration
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** No negative duration
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - In/out persisted
- **FAIL if:**
  - Missing entry
  - Open-ended stuck without record
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-039 — Tech voice note appears on job

- **Section:** 8. Technician workflows
- **Purpose:** Voice note from tech lands on job.
- **Primary ref:** beta 12.4–12.5
- **Tenant:** A
- **Role:** technician
- **Preconditions:** Mic available or upload path; STT optional
- **Fixtures:** —
- **External resources:** STT if live
- **Manual steps:**
  1. Record/upload voice note
  1. Open job notes
- **Expected UI:** Note/transcript present or graceful placeholder
- **Expected API:** Upload 2xx
- **Expected DB:** note/attachment row
- **Expected workers/webhooks:** Transcription worker if keyed
- **Expected authz/isolation:** —
- **Negative assertions:** No silent discard without error
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - Artifact on job
- **FAIL if:**
  - Silent no-op
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-040 — Create draft estimate (integer cents)

- **Section:** 9. Estimates
- **Purpose:** Draft estimate totals match billing engine cents.
- **Primary ref:** EST-01/04; WF-28; beta 5.1–5.7
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Job exists
- **Fixtures:** line items
- **External resources:** —
- **Manual steps:**
  1. Create estimate with line items
  1. Save draft
- **Expected UI:** Totals display with cents
- **Expected API:** POST /api/estimates 201; totals integer cents
- **Expected DB:** status=draft; total_cents match
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** No float money columns
- **Required evidence:** recording; api-response.json; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - 201
  - DB totals match API
- **FAIL if:**
  - Float drift
  - UI success without row
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-041 — Validation errors on invalid create

- **Section:** 9. Estimates
- **Purpose:** Invalid payload rejected without persist.
- **Primary ref:** EST-02
- **Tenant:** A
- **Role:** owner
- **Preconditions:** —
- **Fixtures:** invalid payload
- **External resources:** —
- **Manual steps:**
  1. POST invalid estimate
- **Expected UI:** Validation message if UI
- **Expected API:** 4xx
- **Expected DB:** no new row
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** No partial row
- **Required evidence:** api-response.json; database-assertion.txt; recording
- **Cleanup:** —
- **PASS only if:**
  - 4xx + no row
- **FAIL if:**
  - 201 on invalid
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-042 — Edit draft + revise sent (versioned)

- **Section:** 9. Estimates
- **Purpose:** Draft edit and sent revision versioning.
- **Primary ref:** EST-03; EST-R1
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Draft estimate
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. PATCH draft
  1. Send
  1. Revise
  1. Verify version
- **Expected UI:** Updated totals; Revision indicator
- **Expected API:** PATCH/revise 2xx
- **Expected DB:** version/total updated
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Edits persist
  - Revision versioned
- **FAIL if:**
  - Overwrite without version when required
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-043 — Mixed line items create→send→accept

- **Section:** 9. Estimates
- **Purpose:** Labor/material/equipment estimate lifecycle.
- **Primary ref:** JRN-01; WF-29–30
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Job + catalog items
- **Fixtures:** mixed line items
- **External resources:** —
- **Manual steps:**
  1. Create mixed estimate
  1. Send
  1. Accept via public or API
- **Expected UI:** Status draft→sent→accepted
- **Expected API:** Lifecycle 2xx
- **Expected DB:** status accepted; totals match engine
- **Expected workers/webhooks:** Dispatch send
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Full lifecycle
  - Totals correct
- **FAIL if:**
  - Stuck sent
  - Total mismatch
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-044 — Send estimate SMS + public approve

- **Section:** 9. Estimates
- **Purpose:** Customer receives link and approves on /e/:token.
- **Primary ref:** PORT-01; WF-29–30; beta 5.8–5.16
- **Tenant:** A
- **Role:** owner+customer
- **Preconditions:** SMS consent; Twilio/SendGrid
- **Fixtures:** sent estimate token
- **External resources:** Twilio or email inbox
- **Manual steps:**
  1. Send estimate
  1. Open public token
  1. Approve with signature
- **Expected UI:** Public page loads; Accepted confirmation
- **Expected API:** Send 2xx; Public accept 2xx
- **Expected DB:** status accepted; token row
- **Expected workers/webhooks:** Outbound SMS/email
- **Expected authz/isolation:** Token scoped
- **Negative assertions:** Invalid token safe error
- **Required evidence:** recording; provider receipt; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Delivery evidence
  - Accepted in DB
  - UI after refresh
- **FAIL if:**
  - UI-only accept
  - No provider evidence when claimed sent
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-045 — Convert estimate → invoice (linked)

- **Section:** 9. Estimates
- **Purpose:** Conversion preserves line items and estimate_id.
- **Primary ref:** EST-05; WF-31; beta 6.1–6.4
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Accepted or convertible estimate
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Convert to invoice
  1. Open invoice
- **Expected UI:** Invoice shows same lines
- **Expected API:** Convert 2xx
- **Expected DB:** invoice.estimate_id set; line items preserved
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** No re-keyed totals drift
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Linked invoice
  - Items preserved
- **FAIL if:**
  - Unlinked
  - Totals differ unexpectedly
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-046 — Invoice issue → void lifecycle

- **Section:** 10. Invoices and payments
- **Purpose:** Issue and void invoice states.
- **Primary ref:** INV-01; INV-CR-01
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Draft invoice
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Issue
  1. Void
  1. Refresh
- **Expected UI:** Status badges
- **Expected API:** Issue/void 2xx
- **Expected DB:** status void
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Cannot pay voided
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Issue then void persisted
- **FAIL if:**
  - Illegal state
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-047 — Invalid invoice transition rejected

- **Section:** 10. Invoices and payments
- **Purpose:** Guard illegal invoice transitions.
- **Primary ref:** INV-02
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Invoice in terminal/wrong state
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Attempt illegal transition
- **Expected UI:** Error
- **Expected API:** 4xx
- **Expected DB:** unchanged
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** api-response.json; recording
- **Cleanup:** —
- **PASS only if:**
  - 4xx + unchanged
- **FAIL if:**
  - Allowed illegal transition
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-048 — Issue + delivery (email/SMS)

- **Section:** 10. Invoices and payments
- **Purpose:** Issued invoice delivery creates dispatch evidence.
- **Primary ref:** INV-03; WF-32; beta 6.10–6.12
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Recipient channel available
- **Fixtures:** —
- **External resources:** SendGrid/Twilio
- **Manual steps:**
  1. Issue/send invoice
  1. Confirm customer message
- **Expected UI:** Issued status
- **Expected API:** Send 2xx
- **Expected DB:** issued_at set; dispatch log
- **Expected workers/webhooks:** Notification worker
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording; provider receipt; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Issued + delivery evidence
- **FAIL if:**
  - Issued without dispatch when send claimed
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-049 — Public pay via Stripe test card

- **Section:** 10. Invoices and payments
- **Purpose:** Customer pays on /pay/:token with Stripe test mode.
- **Primary ref:** PORT-02; WF-33; beta 6.13–6.19
- **Tenant:** A
- **Role:** customer
- **Preconditions:** Stripe test mode; Open invoice token
- **Fixtures:** 4242 card
- **External resources:** Stripe
- **Manual steps:**
  1. Open /pay/:token
  1. Pay with test card
  1. Wait webhook
- **Expected UI:** Paid confirmation
- **Expected API:** Payment intent/session success
- **Expected DB:** invoice paid; payment row
- **Expected workers/webhooks:** Stripe webhook handler
- **Expected authz/isolation:** Token scoped
- **Negative assertions:** No live charges
- **Required evidence:** recording; Stripe receipt redacted; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Paid in DB after webhook
  - UI paid after refresh
- **FAIL if:**
  - UI paid without webhook/DB
  - Production key used
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-050 — Partial → full pay + overpay guard

- **Section:** 10. Invoices and payments
- **Purpose:** Partial payments then full; overpay rejected.
- **Primary ref:** PAY-01; WF-34
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Issued invoice
- **Fixtures:** —
- **External resources:** Stripe test optional
- **Manual steps:**
  1. Record/partial pay
  1. Complete pay
  1. Attempt overpay
- **Expected UI:** partially_paid then paid
- **Expected API:** Overpay 4xx
- **Expected DB:** amount_due=0 on paid
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Overpay not applied
- **Required evidence:** recording; api-response.json; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Partial→paid
  - Overpay rejected
- **FAIL if:**
  - Overpay accepted
  - amount_due wrong
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-051 — Deposit credit on first invoice

- **Section:** 10. Invoices and payments
- **Purpose:** Deposit applied correctly in cents.
- **Primary ref:** PAY-02
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Estimate with deposit paid
- **Fixtures:** —
- **External resources:** Stripe test
- **Manual steps:**
  1. Convert/create invoice
  1. Verify deposit credit
- **Expected UI:** Deposit line/credit shown
- **Expected API:** Totals include credit
- **Expected DB:** integer cents credit
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** No double credit
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Deposit credited once
- **FAIL if:**
  - Missing credit
  - Double credit
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-052 — Stripe webhook paid + idempotency

- **Section:** 10. Invoices and payments
- **Purpose:** Webhook marks paid; replay does not duplicate.
- **Primary ref:** INV-05/06; beta 17.31–17.32
- **Tenant:** A
- **Role:** system
- **Preconditions:** Stripe CLI or dashboard replay
- **Fixtures:** evt_qa_*
- **External resources:** Stripe
- **Manual steps:**
  1. Deliver checkout.session.completed
  1. Replay same event
- **Expected UI:** Invoice paid
- **Expected API:** Webhook 200 both times
- **Expected DB:** one payment row
- **Expected workers/webhooks:** Webhook handler
- **Expected authz/isolation:** Signature validated
- **Negative assertions:** No duplicate payment
- **Required evidence:** recording or CLI log; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Paid once
  - Replay idempotent
- **FAIL if:**
  - Duplicate payment
  - Unsigned accepted
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-053 — Create maintenance contract

- **Section:** 11. Contracts
- **Purpose:** Create contract linked to customer/location.
- **Primary ref:** MC-01; beta 13.1–13.4
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Customer + location
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. /contracts → New
  1. Save
  1. Open detail
- **Expected UI:** Contract listed; Detail correct
- **Expected API:** POST contracts/agreements 201
- **Expected DB:** contract row
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording; api-response.json
- **Cleanup:** —
- **PASS only if:**
  - Contract persists
- **FAIL if:**
  - Route 404
  - UI mock only
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-054 — Contract visible on customer profile

- **Section:** 11. Contracts
- **Purpose:** Customer profile shows active contract.
- **Primary ref:** beta 13.5
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Contract exists
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Open customer detail
- **Expected UI:** Active contract visible
- **Expected API:** —
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording; final-state.png
- **Cleanup:** —
- **PASS only if:**
  - Contract shown on customer
- **FAIL if:**
  - Missing
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-055 — Recurring agreement pause→resume→cancel

- **Section:** 11. Contracts
- **Purpose:** Agreement state machine.
- **Primary ref:** AGR-01/02
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Active agreement
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Pause
  1. Resume
  1. Cancel
  1. Refresh
- **Expected UI:** Status updates
- **Expected API:** State transitions 2xx/4xx correctly
- **Expected DB:** final canceled
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Illegal transitions rejected
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - States persist
- **FAIL if:**
  - Illegal transition allowed
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-056 — Money dashboard after paid revenue

- **Section:** 12. Reports and reconciliation
- **Purpose:** Money dashboard reflects paid invoice.
- **Primary ref:** RPT-01; PAY-03; WF-35
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Paid invoice
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Open /reports/money
  1. Compare totals
- **Expected UI:** Revenue includes payment
- **Expected API:** Money dashboard 200
- **Expected DB:** Matches payment sum
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Owner
- **Negative assertions:** Tenant B revenue not included
- **Required evidence:** recording; api-response.json
- **Cleanup:** —
- **PASS only if:**
  - Totals match paid cents
- **FAIL if:**
  - Zero after payment
  - Cross-tenant bleed
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-057 — Revenue-by-source report

- **Section:** 12. Reports and reconciliation
- **Purpose:** Revenue-by-source route works.
- **Primary ref:** RPT-02
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Payments with sources
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Open /reports/revenue-by-source
- **Expected UI:** Report renders
- **Expected API:** 200
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - Report loads with data or empty state
- **FAIL if:**
  - 500
  - Blank crash
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-058 — Time-given-back report

- **Section:** 12. Reports and reconciliation
- **Purpose:** Time-given-back report endpoint/UI.
- **Primary ref:** RPT-03
- **Tenant:** A
- **Role:** owner
- **Preconditions:** —
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Open report or call API
- **Expected UI:** Renders
- **Expected API:** 200
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording; api-response.json
- **Cleanup:** —
- **PASS only if:**
  - 200 + render
- **FAIL if:**
  - 500
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-059 — Overdue invoice → job money_state

- **Section:** 12. Reports and reconciliation
- **Purpose:** Overdue cron/worker updates money state.
- **Primary ref:** PAY-04; INV-07; WF-35
- **Tenant:** A
- **Role:** owner+worker
- **Preconditions:** Past-due invoice fixture; Worker/cron
- **Fixtures:** overdue invoice
- **External resources:** —
- **Manual steps:**
  1. Advance/trigger overdue job
  1. Inspect invoice/job
- **Expected UI:** Overdue badge
- **Expected API:** —
- **Expected DB:** money_state/overdue flag
- **Expected workers/webhooks:** Overdue worker ran
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording; worker log redacted; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Overdue reflected after worker
- **FAIL if:**
  - Never updates
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-060 — Proposal create + draft reject guard

- **Section:** 13. Proposals
- **Purpose:** Reject draft proposal without side effects.
- **Primary ref:** PROP-01; WF-36–37
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Draft proposal
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Reject proposal
  1. Verify no entity created
- **Expected UI:** Rejected status
- **Expected API:** Reject 2xx
- **Expected DB:** status rejected; no result entity
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** No appointment/customer created
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Rejected, no side effects
- **FAIL if:**
  - Entity created on reject
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-061 — Proposal inbox prioritization

- **Section:** 13. Proposals
- **Purpose:** Inbox lists and prioritizes proposals.
- **Primary ref:** PROP-02; WF-41
- **Tenant:** A
- **Role:** owner
- **Preconditions:** ≥1 proposal
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Open /inbox
- **Expected UI:** Proposals listed; Priority/markers if present
- **Expected API:** GET /api/proposals 200
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - Inbox loads proposals
- **FAIL if:**
  - Empty when rows exist
  - 500
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-062 — Cross-tenant proposal denial

- **Section:** 13. Proposals
- **Purpose:** Tenant B cannot approve/read Tenant A proposal.
- **Primary ref:** PROP-03
- **Tenant:** B
- **Role:** owner
- **Preconditions:** Tenant A proposal id known
- **Fixtures:** cross-tenant ids
- **External resources:** —
- **Manual steps:**
  1. As B, GET/approve A proposal id
- **Expected UI:** Not listed
- **Expected API:** 403/404
- **Expected DB:** A proposal unchanged
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Denied
- **Negative assertions:** No execution
- **Required evidence:** api-response.json; recording
- **Cleanup:** —
- **PASS only if:**
  - Denied + unchanged
- **FAIL if:**
  - 200 or executed
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-063 — Approve booking proposal executes

- **Section:** 13. Proposals
- **Purpose:** Approve creates appointment via executor.
- **Primary ref:** WF-36; SCH-02
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Booking proposal; Worker running
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Approve
  1. Wait execution
  1. Verify appointment
- **Expected UI:** Executed / appointment exists
- **Expected API:** Approve 2xx
- **Expected DB:** proposal executed; appointment row; result_entity_id
- **Expected workers/webhooks:** Proposal executor
- **Expected authz/isolation:** —
- **Negative assertions:** Not auto-executed before approve
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Executed + appointment
- **FAIL if:**
  - Stuck approved
  - No entity
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-064 — Edit proposal before approve

- **Section:** 13. Proposals
- **Purpose:** Edited payload is what executes.
- **Primary ref:** WF-38
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Editable proposal
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Edit field
  1. Approve
  1. Verify result uses edit
- **Expected UI:** Edit form
- **Expected API:** Patch+approve 2xx
- **Expected DB:** result reflects edit
- **Expected workers/webhooks:** Executor
- **Expected authz/isolation:** —
- **Negative assertions:** Original unedited payload not used
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Executed with edits
- **FAIL if:**
  - Edits ignored
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-065 — Conversation + message thread

- **Section:** 14. Communications and interactions
- **Purpose:** Comms inbox thread works.
- **Primary ref:** CONV-01
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Customer phone/email
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Open /comms-inbox
  1. Open thread
  1. Send reply if allowed
- **Expected UI:** Thread renders
- **Expected API:** Messages 200
- **Expected DB:** conversation/messages
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - Thread loads
- **FAIL if:**
  - 500
  - Empty crash
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-066 — Interactions show SMS/email dispatches

- **Section:** 14. Communications and interactions
- **Purpose:** Interactions log shows outbound dispatches.
- **Primary ref:** beta 9.1–9.3; SMS-01
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Prior send
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Open /interactions
  1. Find dispatch
- **Expected UI:** Dispatch entry
- **Expected API:** Interactions 200
- **Expected DB:** dispatch rows
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - Dispatch visible
- **FAIL if:**
  - Missing after send
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-067 — Customer comms history links entities

- **Section:** 14. Communications and interactions
- **Purpose:** Customer timeline links messages to entities.
- **Primary ref:** beta 9.5–9.7
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Messages tied to estimate/invoice
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Open customer timeline
- **Expected UI:** Linked entities clickable
- **Expected API:** —
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - Links work
- **FAIL if:**
  - Orphan messages only
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-068 — Dispatch idempotency window

- **Section:** 14. Communications and interactions
- **Purpose:** Re-send within window does not duplicate.
- **Primary ref:** beta 9.4; SMS-01
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Recent successful send
- **Fixtures:** —
- **External resources:** Twilio/SendGrid
- **Manual steps:**
  1. Trigger duplicate send
  1. Count provider messages
- **Expected UI:** Idempotent success or guarded message
- **Expected API:** 2xx without duplicate side effect
- **Expected DB:** single dispatch or dedup key
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** No duplicate SMS within window
- **Required evidence:** recording; provider receipt count
- **Cleanup:** —
- **PASS only if:**
  - No duplicate delivery
- **FAIL if:**
  - Two messages for one action
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-069 — Assistant chat loads + grounded answers

- **Section:** 15. Assistant and in-app voice
- **Purpose:** Assistant chat round-trip works.
- **Primary ref:** AST-01–06; beta 11.1–11.4; WF-39
- **Tenant:** A
- **Role:** owner
- **Preconditions:** AI_PROVIDER_API_KEY
- **Fixtures:** —
- **External resources:** LLM
- **Manual steps:**
  1. Open /assistant
  1. Ask grounded question
  1. Observe reply
- **Expected UI:** Reply rendered
- **Expected API:** Assistant 2xx
- **Expected DB:** conversation messages
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** No silent empty success
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - Reply present
- **FAIL if:**
  - 500
  - Empty thread wipe
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-070 — Create customer via assistant

- **Section:** 15. Assistant and in-app voice
- **Purpose:** Assistant creates customer proposal → execute.
- **Primary ref:** AST-01; CUST-02
- **Tenant:** A
- **Role:** owner
- **Preconditions:** LLM key
- **Fixtures:** —
- **External resources:** LLM
- **Manual steps:**
  1. Ask to create customer
  1. Approve proposal
  1. Verify customer
- **Expected UI:** Proposal card; Customer exists
- **Expected API:** Proposal approve 2xx
- **Expected DB:** customer row; proposal executed
- **Expected workers/webhooks:** Executor
- **Expected authz/isolation:** —
- **Negative assertions:** Not auto-executed
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Customer created via approval
- **FAIL if:**
  - No proposal
  - Auto-exec
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-071 — Create/revise estimate via assistant

- **Section:** 15. Assistant and in-app voice
- **Purpose:** Estimate proposals catalog-grounded.
- **Primary ref:** AST-02/03
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Catalog items; LLM
- **Fixtures:** —
- **External resources:** LLM
- **Manual steps:**
  1. Ask create/revise estimate
  1. Approve
  1. Verify cents
- **Expected UI:** Proposal with line items
- **Expected API:** 2xx
- **Expected DB:** estimate row; catalog-grounded prices
- **Expected workers/webhooks:** Executor
- **Expected authz/isolation:** —
- **Negative assertions:** Uncatalogued high-confidence auto-approve blocked
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Estimate executed with grounded prices
- **FAIL if:**
  - Invented prices trusted
  - No estimate
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-072 — In-app voice bar / mic transcript

- **Section:** 15. Assistant and in-app voice
- **Purpose:** Voice bar captures transcript path.
- **Primary ref:** WF-40/45; beta 11.7–11.8
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Mic or upload
- **Fixtures:** —
- **External resources:** STT optional
- **Manual steps:**
  1. Use voice bar
  1. Confirm transcript/proposal/nav
- **Expected UI:** Transcript or clear error
- **Expected API:** Voice session 2xx
- **Expected DB:** session row optional
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** No silent no-op
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - Transcript or explicit failure
- **FAIL if:**
  - Silent failure
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-073 — Conversation history persists across tabs

- **Section:** 15. Assistant and in-app voice
- **Purpose:** Assistant history survives navigation.
- **Primary ref:** beta 11.5–11.6
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Prior assistant messages
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Send message
  1. Navigate away
  1. Return
- **Expected UI:** History intact
- **Expected API:** GET conversation includes messages
- **Expected DB:** messages persisted
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Thread does not self-wipe
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - History persists
- **FAIL if:**
  - Self-wipe
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-074 — Live Twilio call connects + greets

- **Section:** 16. Inbound voice calls
- **Purpose:** Inbound call answers with business greeting.
- **Primary ref:** beta 15.1–15.2; WF-08/42
- **Tenant:** A
- **Role:** caller
- **Preconditions:** Tenant Twilio number; Voice stack live
- **Fixtures:** —
- **External resources:** Twilio
- **Manual steps:**
  1. Call tenant number
  1. Listen to greeting
- **Expected UI:** N/A live call
- **Expected API:** Voice webhook 200
- **Expected DB:** interaction/session started
- **Expected workers/webhooks:** Media streams
- **Expected authz/isolation:** Routes to correct tenant
- **Negative assertions:** Not dead air; Not wrong tenant
- **Required evidence:** recording of call workflow + webhook evidence
- **Cleanup:** —
- **PASS only if:**
  - Call connects
  - Greeting uses business name
- **FAIL if:**
  - Busy/dead
  - Wrong tenant
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-075 — Identify customer + book proposal

- **Section:** 16. Inbound voice calls
- **Purpose:** Caller identified; booking proposal created.
- **Primary ref:** SCH-02; CUST-02; WF-42
- **Tenant:** A
- **Role:** caller→owner
- **Preconditions:** Known customer phone; LLM+voice
- **Fixtures:** customer phone
- **External resources:** Twilio; LLM
- **Manual steps:**
  1. Call from/as known customer
  1. Request booking
  1. Approve proposal
- **Expected UI:** Proposal in inbox
- **Expected API:** —
- **Expected DB:** session; proposal; appointment after approve
- **Expected workers/webhooks:** Voice + executor
- **Expected authz/isolation:** —
- **Negative assertions:** No silent guess on ambiguous entity
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Proposal + executed appointment
- **FAIL if:**
  - No proposal
  - Wrong customer
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-076 — Emergency triage escalation

- **Section:** 16. Inbound voice calls
- **Purpose:** Emergency utterance escalates.
- **Primary ref:** VOX-01; WF-43; beta 15.7
- **Tenant:** A
- **Role:** caller
- **Preconditions:** Voice live
- **Fixtures:** —
- **External resources:** Twilio; LLM
- **Manual steps:**
  1. Say emergency phrase
  1. Observe escalation
- **Expected UI:** Escalation in interactions/inbox
- **Expected API:** —
- **Expected DB:** escalation state
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Does not continue normal booking
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Escalation path taken
- **FAIL if:**
  - Normal booking continues
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-077 — Spanish / i18n voice response

- **Section:** 16. Inbound voice calls
- **Purpose:** Spanish utterance gets Spanish-capable response path.
- **Primary ref:** VOX-02
- **Tenant:** A
- **Role:** caller
- **Preconditions:** Voice live
- **Fixtures:** —
- **External resources:** Twilio; LLM
- **Manual steps:**
  1. Speak Spanish request
  1. Observe response language/path
- **Expected UI:** Interaction notes language
- **Expected API:** —
- **Expected DB:** session language marker if stored
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - Spanish path engaged (soft language check ok)
- **FAIL if:**
  - Hard failure / hangup
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-078 — Voice→estimate/invoice proposals

- **Section:** 16. Inbound voice calls
- **Purpose:** Voice can draft estimate/invoice proposals.
- **Primary ref:** VOX-05–08, VOX-11
- **Tenant:** A
- **Role:** caller→owner
- **Preconditions:** Voice+LLM; Customer/job context
- **Fixtures:** —
- **External resources:** Twilio; LLM
- **Manual steps:**
  1. Request estimate/invoice via voice
  1. Approve in inbox
- **Expected UI:** Proposals in inbox
- **Expected API:** —
- **Expected DB:** proposals + entities after approve
- **Expected workers/webhooks:** Executor
- **Expected authz/isolation:** —
- **Negative assertions:** Prices catalog-grounded
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Proposals execute to entities
- **FAIL if:**
  - No proposal
  - Ungrounded prices auto-approved
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-079 — Session in interactions + DB artifacts

- **Section:** 16. Inbound voice calls
- **Purpose:** Call transcript/session linked in interactions.
- **Primary ref:** VOX-09/10; WF-44; beta 15.8–15.9
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Completed call
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Open /interactions
  1. Open transcript
- **Expected UI:** Transcript drawer
- **Expected API:** Interactions 200
- **Expected DB:** session linked to customer if known
- **Expected workers/webhooks:** Recording webhook
- **Expected authz/isolation:** —
- **Negative assertions:** Not blank/[inaudible] throughout when audio present
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Interaction + transcript/session artifacts
- **FAIL if:**
  - Missing interaction
  - 500 drawer
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-080 — Outbound SMS dispatch + entity_type CHECK

- **Section:** 17. Notifications and compliance
- **Purpose:** SMS send writes valid dispatch row.
- **Primary ref:** SMS-01; beta 7.12–7.13
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Twilio; consenting customer
- **Fixtures:** —
- **External resources:** Twilio
- **Manual steps:**
  1. Trigger appointment/estimate SMS
  1. Inspect dispatch
- **Expected UI:** Sent indicator
- **Expected API:** Send 2xx
- **Expected DB:** dispatch entity_type valid
- **Expected workers/webhooks:** SMS worker
- **Expected authz/isolation:** —
- **Negative assertions:** CHECK constraint not violated
- **Required evidence:** recording; database-assertion.txt; provider receipt
- **Cleanup:** —
- **PASS only if:**
  - SMS sent + valid row
- **FAIL if:**
  - DB error
  - No provider message
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-081 — SMS consent / DNC gating

- **Section:** 17. Notifications and compliance
- **Purpose:** DNC/consent suppresses outbound SMS.
- **Primary ref:** SMS-02; VOX-03
- **Tenant:** A
- **Role:** owner
- **Preconditions:** DNC or no-consent fixture
- **Fixtures:** DNC phone
- **External resources:** Twilio
- **Manual steps:**
  1. Attempt SMS
  1. Confirm suppressed
- **Expected UI:** Suppressed reason
- **Expected API:** Send blocked or no-op with reason
- **Expected DB:** no outbound sent
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** No SMS delivered
- **Required evidence:** recording; database-assertion.txt; provider: zero messages
- **Cleanup:** —
- **PASS only if:**
  - Suppressed with evidence
- **FAIL if:**
  - SMS delivered to DNC
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-082 — Appointment confirmation SMS natural copy

- **Section:** 17. Notifications and compliance
- **Purpose:** Confirmation SMS uses natural language copy.
- **Primary ref:** beta 7.12–7.13
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Consenting customer; Appointment
- **Fixtures:** —
- **External resources:** Twilio
- **Manual steps:**
  1. Trigger confirmation
  1. Read message body
- **Expected UI:** —
- **Expected API:** —
- **Expected DB:** dispatch body stored/redacted
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Not raw JSON
- **Required evidence:** recording; redacted message body
- **Cleanup:** —
- **PASS only if:**
  - Natural copy delivered
- **FAIL if:**
  - Raw JSON SMS
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-083 — Delay notice idempotency

- **Section:** 17. Notifications and compliance
- **Purpose:** Repeated delay notice does not spam.
- **Primary ref:** SCH-05; beta 7.18
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Running-late state
- **Fixtures:** —
- **External resources:** Twilio
- **Manual steps:**
  1. Trigger delay twice quickly
  1. Count SMS
- **Expected UI:** —
- **Expected API:** —
- **Expected DB:** dedup key
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** ≤1 customer SMS
- **Required evidence:** provider count; recording
- **Cleanup:** —
- **PASS only if:**
  - Idempotent
- **FAIL if:**
  - Duplicate SMS
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-084 — Public estimate approve/reject + re-open

- **Section:** 18. Public and customer self-service
- **Purpose:** Public estimate token flows.
- **Primary ref:** PORT-01; WF-30; beta 10.1–10.4
- **Tenant:** A
- **Role:** customer
- **Preconditions:** Valid estimate token
- **Fixtures:** /e/:token
- **External resources:** —
- **Manual steps:**
  1. Open token
  1. Approve or reject
  1. Invalid token check
- **Expected UI:** Estimate details; Success state
- **Expected API:** Public endpoints 2xx/4xx
- **Expected DB:** status updated
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Token only
- **Negative assertions:** Invalid token safe copy, no raw upstream JSON
- **Required evidence:** recording; final-state.png
- **Cleanup:** —
- **PASS only if:**
  - Valid flow works
  - Invalid safe
- **FAIL if:**
  - Mock data leak
  - Raw error JSON
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-085 — Public invoice view + paid state

- **Section:** 18. Public and customer self-service
- **Purpose:** Public invoice page reflects paid state.
- **Primary ref:** PORT-02; beta 10.5–10.7
- **Tenant:** A
- **Role:** customer
- **Preconditions:** Invoice token
- **Fixtures:** /pay/:token
- **External resources:** Stripe test
- **Manual steps:**
  1. Open pay page
  1. Pay or view paid
- **Expected UI:** Amount correct; Paid state after settlement
- **Expected API:** —
- **Expected DB:** paid
- **Expected workers/webhooks:** Webhook
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - Correct amount + paid persistence
- **FAIL if:**
  - Wrong cents
  - Stale unpaid
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-086 — Customer portal token-scoped data

- **Section:** 18. Public and customer self-service
- **Purpose:** Portal tabs only show token tenant/customer data.
- **Primary ref:** WF-47; beta 10.8–10.10
- **Tenant:** A
- **Role:** customer
- **Preconditions:** Portal token
- **Fixtures:** /portal/:token
- **External resources:** —
- **Manual steps:**
  1. Open portal tabs
  1. Attempt foreign ids
- **Expected UI:** Own data only
- **Expected API:** Foreign ids 404/403
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Token scoped
- **Negative assertions:** No Tenant B data
- **Required evidence:** recording; api-response.json
- **Cleanup:** —
- **PASS only if:**
  - Scoped data only
- **FAIL if:**
  - Cross-customer leak
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-087 — Intake form vertical fields

- **Section:** 18. Public and customer self-service
- **Purpose:** Intake shows active vertical fields.
- **Primary ref:** beta 10.11–10.13; WF-16
- **Tenant:** A
- **Role:** anonymous
- **Preconditions:** Active pack
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Open /intake
  1. Inspect service types
- **Expected UI:** Vertical-specific options
- **Expected API:** —
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - Vertical options present
- **FAIL if:**
  - Empty/wrong vertical
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-088 — Post-job feedback submit

- **Section:** 18. Public and customer self-service
- **Purpose:** Feedback token submits rating.
- **Primary ref:** WF-49; beta 10.14–10.16
- **Tenant:** A
- **Role:** customer
- **Preconditions:** Feedback token
- **Fixtures:** /public/feedback/:token
- **External resources:** —
- **Manual steps:**
  1. Submit stars + comment
- **Expected UI:** Thank you / review gate
- **Expected API:** Submit 2xx
- **Expected DB:** feedback row
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Invalid token safe
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Rating persisted
- **FAIL if:**
  - No row
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-089 — Read + update tenant settings

- **Section:** 19. Settings
- **Purpose:** Business profile persists.
- **Primary ref:** SET-01; beta 14.1–14.2
- **Tenant:** A
- **Role:** owner
- **Preconditions:** —
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Edit company name
  1. Save
  1. Hard reload
- **Expected UI:** Updated name
- **Expected API:** PUT settings 200
- **Expected DB:** settings row
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Owner
- **Negative assertions:** Does not wipe vertical packs
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Persists after reload
- **FAIL if:**
  - Reverts
  - Pack wipe
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-090 — Terminology / AI approval / deposit rules

- **Section:** 19. Settings
- **Purpose:** Rule sheets persist.
- **Primary ref:** beta 14.4–14.7
- **Tenant:** A
- **Role:** owner
- **Preconditions:** —
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Update terminology
  1. AI approval threshold
  1. Deposit rules
  1. Reload
- **Expected UI:** Values persist
- **Expected API:** Settings endpoints 200
- **Expected DB:** values stored
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording
- **Cleanup:** —
- **PASS only if:**
  - All three persist
- **FAIL if:**
  - Any reverts
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-091 — Templates + price book (catalog CRUD)

- **Section:** 19. Settings
- **Purpose:** Templates and price book edit prices in cents.
- **Primary ref:** CAT-01; beta 14.12–14.14
- **Tenant:** A
- **Role:** owner
- **Preconditions:** —
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Edit template
  1. Edit price book item
  1. Use in estimate
- **Expected UI:** Updated values
- **Expected API:** CRUD 2xx
- **Expected DB:** integer cents
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Edits prefill new estimate
- **FAIL if:**
  - Mock-only save
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-092 — Team invite Dispatcher + Technician

- **Section:** 19. Settings
- **Purpose:** Invites join existing tenant with roles.
- **Primary ref:** beta 16.13–16.20
- **Tenant:** A
- **Role:** owner→dispatcher/tech
- **Preconditions:** Clerk invites enabled
- **Fixtures:** invite emails
- **External resources:** Clerk
- **Manual steps:**
  1. Invite dispatcher
  1. Invite technician
  1. Accept as invitee
  1. GET /api/me
- **Expected UI:** Pending then accepted
- **Expected API:** /api/me role correct
- **Expected DB:** invitation accepted; same tenant_id
- **Expected workers/webhooks:** Clerk webhook
- **Expected authz/isolation:** Role permissions enforced
- **Negative assertions:** Invite does not bootstrap new tenant
- **Required evidence:** recording; redacted /api/me
- **Cleanup:** —
- **PASS only if:**
  - Both roles join Tenant A
- **FAIL if:**
  - New tenant created
  - Wrong role
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-093 — Current-user profile + mode switch

- **Section:** 19. Settings
- **Purpose:** GET /api/me and supervisor/tech mode switch.
- **Primary ref:** ME-01
- **Tenant:** A
- **Role:** owner
- **Preconditions:** —
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Open profile/home
  1. Switch mode if available
  1. Confirm /api/me
- **Expected UI:** Mode-aware nav
- **Expected API:** GET /api/me 200 with role/mode
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording; api-response.json
- **Cleanup:** —
- **PASS only if:**
  - /api/me correct
  - Mode switch persists if supported
- **FAIL if:**
  - Wrong tenant/role
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-094 — Connect Google OAuth (auth URL)

- **Section:** 20. Google Calendar
- **Purpose:** Calendar connect returns OAuth URL.
- **Primary ref:** WF-50; CAL-01
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Google OAuth client configured
- **Fixtures:** disposable Google account
- **External resources:** Google
- **Manual steps:**
  1. POST connect
  1. Complete OAuth
  1. Confirm integration stored
- **Expected UI:** Connected state in settings
- **Expected API:** connect returns auth URL; callback 2xx
- **Expected DB:** calendar integration row
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Per-user
- **Negative assertions:** No token printed in UI/logs
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Integration stored
- **FAIL if:**
  - Missing OAuth client
  - Tokens leaked
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-095 — Appointment create/assign → synced event

- **Section:** 20. Google Calendar
- **Purpose:** Appointment push creates external event.
- **Primary ref:** WF-50; SCH-01
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Google connected
- **Fixtures:** —
- **External resources:** Google Calendar
- **Manual steps:**
  1. Create/assign appointment
  1. Verify Google event
  1. Check appointment_calendar_events
- **Expected UI:** Synced indicator if any
- **Expected API:** Optional test-push 2xx
- **Expected DB:** status='synced'; external_event_id set
- **Expected workers/webhooks:** Calendar sync
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording; Google event screenshot redacted; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Synced event exists
- **FAIL if:**
  - No external_event_id
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-096 — Disconnect clears integration

- **Section:** 20. Google Calendar
- **Purpose:** Disconnect removes integration.
- **Primary ref:** WF-50
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Connected
- **Fixtures:** —
- **External resources:** Google
- **Manual steps:**
  1. Disconnect
  1. Confirm cleared
- **Expected UI:** Disconnected
- **Expected API:** Disconnect 2xx
- **Expected DB:** integration cleared
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Integration cleared
- **FAIL if:**
  - Stale tokens remain usable
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-097 — Cross-tenant reads blocked

- **Section:** 21. Multi-tenant isolation and security
- **Purpose:** Tenant B cannot read Tenant A entities.
- **Primary ref:** ISO-01; beta 17.5–17.13; WF-04
- **Tenant:** B
- **Role:** owner
- **Preconditions:** Tenant A entity ids; Tenant B token
- **Fixtures:** cross-tenant ids
- **External resources:** —
- **Manual steps:**
  1. As B, GET A customer/job/estimate/invoice/appointments/proposals/settings
- **Expected UI:** Empty lists
- **Expected API:** 404/403 or empty
- **Expected DB:** A unchanged
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Denied
- **Negative assertions:** No A ids in B list
- **Required evidence:** api-response.json matrix; recording
- **Cleanup:** —
- **PASS only if:**
  - All reads denied/empty
- **FAIL if:**
  - Any A entity returned
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-098 — Cross-tenant writes blocked

- **Section:** 21. Multi-tenant isolation and security
- **Purpose:** Tenant B cannot write using Tenant A parent ids.
- **Primary ref:** ISO-01; beta 17.14–17.17
- **Tenant:** B
- **Role:** owner
- **Preconditions:** A ids
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. POST notes/appointments/estimates with A parent ids
- **Expected UI:** —
- **Expected API:** 400/403/404
- **Expected DB:** No new A rows from B
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Denied
- **Negative assertions:** Parent ownership validated
- **Required evidence:** api-response.json; database-assertion.txt; recording
- **Cleanup:** —
- **PASS only if:**
  - Writes blocked
- **FAIL if:**
  - Child created under A
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-099 — Technician RBAC

- **Section:** 21. Multi-tenant isolation and security
- **Purpose:** Technician lacks estimates/invoices/settings; can view jobs.
- **Primary ref:** beta 17.18–17.24
- **Tenant:** A
- **Role:** technician
- **Preconditions:** Technician JWT
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. As tech: GET estimates/invoices/settings/invites → deny; GET jobs → allow; transition assigned job
- **Expected UI:** Nav hides forbidden
- **Expected API:** 403 on forbidden; 200 on jobs
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** RBAC enforced
- **Negative assertions:** Cannot invite users
- **Required evidence:** api-response.json; recording
- **Cleanup:** —
- **PASS only if:**
  - RBAC matrix matches
- **FAIL if:**
  - Tech reads invoices/settings
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-100 — Public token isolation / no internal IDs

- **Section:** 21. Multi-tenant isolation and security
- **Purpose:** Public pages do not leak internal ids or other tenants.
- **Primary ref:** beta 17.25–17.28; PORT-01/02
- **Tenant:** A/B
- **Role:** anonymous
- **Preconditions:** Valid + invalid tokens
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Alter tokens
  1. Open pages
  1. Inspect payload
- **Expected UI:** Safe error copy
- **Expected API:** 401/404
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** No raw upstream JSON; No foreign tenant data
- **Required evidence:** recording; api-response.json
- **Cleanup:** —
- **PASS only if:**
  - Safe failures
- **FAIL if:**
  - Data leak
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-101 — Twilio/Stripe webhook tenant routing

- **Section:** 21. Multi-tenant isolation and security
- **Purpose:** Provider webhooks route to owning tenant only.
- **Primary ref:** beta 17.29–17.32
- **Tenant:** A/B
- **Role:** system
- **Preconditions:** Two numbers or stripe metadata
- **Fixtures:** —
- **External resources:** Twilio; Stripe
- **Manual steps:**
  1. Send SMS to A vs B numbers
  1. Replay stripe with A invoice metadata as B context if applicable
- **Expected UI:** —
- **Expected API:** Webhooks 200
- **Expected DB:** Events only on owning tenant
- **Expected workers/webhooks:** Webhook handlers
- **Expected authz/isolation:** —
- **Negative assertions:** No cross-tenant apply
- **Required evidence:** database-assertion.txt; recording/logs redacted
- **Cleanup:** —
- **PASS only if:**
  - Tenant-correct routing
- **FAIL if:**
  - Cross-tenant write
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-102 — RLS with GUC + no-GUC fail-closed

- **Section:** 21. Multi-tenant isolation and security
- **Purpose:** NOSUPERUSER NOBYPASSRLS role enforces RLS.
- **Primary ref:** ISO-01; beta 17.33–17.35
- **Tenant:** A/B
- **Role:** qa_readonly
- **Preconditions:** qa_readonly role; SET app.tenant_id
- **Fixtures:** —
- **External resources:** Postgres
- **Manual steps:**
  1. SELECT with GUC for A
  1. SELECT with GUC for B
  1. SELECT without GUC
- **Expected UI:** —
- **Expected API:** —
- **Expected DB:** Only tenant rows with GUC; 0 rows without GUC
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** RLS
- **Negative assertions:** Service role not used for this proof
- **Required evidence:** database-assertion.txt; recording of SQL session
- **Cleanup:** —
- **PASS only if:**
  - GUC scopes
  - no-GUC empty/fail-closed
- **FAIL if:**
  - Bypass RLS
  - Cross-tenant rows
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-103 — Estimate tenant isolation row

- **Section:** 21. Multi-tenant isolation and security
- **Purpose:** Tenant B cannot read Tenant A estimate.
- **Primary ref:** EST-06
- **Tenant:** B
- **Role:** owner
- **Preconditions:** A estimate id
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. GET A estimate as B
- **Expected UI:** —
- **Expected API:** 403/404
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Denied
- **Negative assertions:** —
- **Required evidence:** api-response.json; recording
- **Cleanup:** —
- **PASS only if:**
  - Denied
- **FAIL if:**
  - 200 with A estimate
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-104 — Feature-flag admin platform-gated

- **Section:** 21. Multi-tenant isolation and security
- **Purpose:** Platform admin flags not tenant-writable.
- **Primary ref:** FLAG-01
- **Tenant:** A
- **Role:** owner
- **Preconditions:** —
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Attempt admin flag mutation as tenant owner
- **Expected UI:** Forbidden or hidden
- **Expected API:** 403
- **Expected DB:** unchanged
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** Platform-gated
- **Negative assertions:** —
- **Required evidence:** api-response.json; recording
- **Cleanup:** —
- **PASS only if:**
  - Tenant cannot elevate flags
- **FAIL if:**
  - Owner mutates platform flags
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-105 — Golden funnel intake→invoice issued

- **Section:** 22. Miscellaneous and hidden-route checks
- **Purpose:** End-to-end golden funnel.
- **Primary ref:** JRN-03
- **Tenant:** A
- **Role:** owner
- **Preconditions:** Clean funnel fixtures
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Intake→lead→customer→job→estimate→invoice issued
- **Expected UI:** Each stage visible
- **Expected API:** Each step 2xx
- **Expected DB:** Linked chain
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording spanning funnel; entity id chain
- **Cleanup:** —
- **PASS only if:**
  - Full chain linked
- **FAIL if:**
  - Broken link
  - Missing stage
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-106 — Three-estimate billing journey (2 paid)

- **Section:** 22. Miscellaneous and hidden-route checks
- **Purpose:** Create three estimates; invoice+pay two; leave one.
- **Primary ref:** JRN-02
- **Tenant:** A
- **Role:** owner
- **Preconditions:** —
- **Fixtures:** —
- **External resources:** Stripe test
- **Manual steps:**
  1. Create 3 estimates
  1. Invoice+pay 2
  1. Leave 1
- **Expected UI:** Two paid invoices; One uninvoiced estimate
- **Expected API:** —
- **Expected DB:** 2 paid invoices; 1 estimate without invoice
- **Expected workers/webhooks:** Webhooks
- **Expected authz/isolation:** —
- **Negative assertions:** —
- **Required evidence:** recording; database-assertion.txt
- **Cleanup:** —
- **PASS only if:**
  - Exact 2 paid + 1 left
- **FAIL if:**
  - Counts wrong
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)

### QA-107 — Hidden routes + telephony gap documentation

- **Section:** 22. Miscellaneous and hidden-route checks
- **Purpose:** Hidden routes load; VOX-04 telephony-only gaps documented if not drivable.
- **Primary ref:** VOX-04; MC-01; RPT-02
- **Tenant:** A
- **Role:** owner
- **Preconditions:** —
- **Fixtures:** —
- **External resources:** —
- **Manual steps:**
  1. Open /contracts
  1. /reports/revenue-by-source
  1. Document VOX-04 cases
- **Expected UI:** Routes render
- **Expected API:** 200
- **Expected DB:** —
- **Expected workers/webhooks:** —
- **Expected authz/isolation:** —
- **Negative assertions:** Not testable ≠ PASS — document FAIL until drivability restored
- **Required evidence:** recording; notes.md for VOX-04
- **Cleanup:** —
- **PASS only if:**
  - Routes work
  - Telephony gaps either executed or FAIL with exact missing resource
- **FAIL if:**
  - ASSUMED/SKIPPED without FAIL
  - Workflow not executed, inferred only from unit tests/source, or evidence incomplete
  - Item is not testable (counts as FAIL)
