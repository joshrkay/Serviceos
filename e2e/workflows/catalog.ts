/**
 * Canonical catalog of the 50 user workflows (WF-01 … WF-50).
 *
 * Source: docs/superpowers/specs/2026-05-24-platform-assessment-and-e2e-qa-50-workflows.md
 *
 * Specs in e2e/workflows/*.spec.ts reference rows by `id`. The `automation`
 * field documents where the authoritative test lives when this suite delegates.
 */

export type WorkflowPriority = 'P0' | 'P1' | 'P2';
export type WorkflowAutomation =
  | 'workflow' // implemented in e2e/workflows/
  | 'smoke'
  | 'journey'
  | 'matrix'
  | 'sweep'
  | 'manual'
  | 'api-test';

export interface WorkflowDef {
  id: string;
  title: string;
  priority: WorkflowPriority;
  automation: WorkflowAutomation;
  /** Matrix row id, journey spec, or runbook pointer when delegated. */
  delegate?: string;
  passCriteria: string;
}

export const WORKFLOWS: WorkflowDef[] = [
  // §4.1 Foundation & access
  { id: 'WF-01', title: 'Sign up → Clerk webhook bootstraps tenant', priority: 'P0', automation: 'journey', delegate: 'e2e/journeys/signup-to-first-estimate.spec.ts', passCriteria: 'Tenant + settings rows; /api/me returns tenantId' },
  { id: 'WF-02', title: 'Sign in → land on home (or onboarding guard)', priority: 'P0', automation: 'workflow', passCriteria: 'Authenticated shell loads; no console errors' },
  { id: 'WF-03', title: 'Unauthenticated / redirects to login', priority: 'P0', automation: 'smoke', delegate: 'e2e/smoke.spec.ts', passCriteria: '302 to /login' },
  { id: 'WF-04', title: 'Cross-tenant API isolation', priority: 'P0', automation: 'matrix', delegate: 'ISO-01', passCriteria: 'Tenant B cannot read Tenant A entities (403/404)' },
  { id: 'WF-05', title: 'API health + readiness', priority: 'P0', automation: 'smoke', delegate: 'e2e/smoke.spec.ts', passCriteria: '/health and /ready 200' },

  // §4.2 Onboarding & go-live
  { id: 'WF-06', title: 'Onboarding v2: identity → pack → phone → billing', priority: 'P0', automation: 'journey', delegate: 'e2e/journeys/onboarding-v2.spec.ts', passCriteria: 'Checklist advances; pack active in /api/verticals' },
  { id: 'WF-07', title: 'Twilio subaccount provision (async worker)', priority: 'P0', automation: 'manual', delegate: 'PROV', passCriteria: 'Phone number assigned; voice endpoint reachable' },
  { id: 'WF-08', title: 'Test call step confirms agent answers', priority: 'P0', automation: 'manual', passCriteria: 'Inbound test call completes FSM greeting' },
  { id: 'WF-09', title: 'Stripe subscription / trial start', priority: 'P1', automation: 'manual', delegate: 'BILL', passCriteria: 'Subscription row; billing portal session' },
  { id: 'WF-10', title: 'Onboarding guard blocks app until complete (v2 flag)', priority: 'P1', automation: 'sweep', delegate: 'COVERAGE_SWEEP /onboarding', passCriteria: 'Incomplete tenant redirected to /onboarding' },

  // §4.3 CRM
  { id: 'WF-11', title: 'Create customer (UI + API)', priority: 'P0', automation: 'matrix', delegate: 'CUS-01', passCriteria: 'Customer in list + DB under tenant' },
  { id: 'WF-12', title: 'Edit customer + service location', priority: 'P1', automation: 'matrix', delegate: 'CUS-02', passCriteria: 'Updated fields persist; dedupe holds' },
  { id: 'WF-13', title: 'Search / open customer timeline', priority: 'P1', automation: 'sweep', delegate: '/customers/:id', passCriteria: 'Timeline loads comms + jobs' },
  { id: 'WF-14', title: 'Create lead + move kanban stage', priority: 'P1', automation: 'sweep', delegate: '/leads', passCriteria: 'Stage change persists' },
  { id: 'WF-15', title: 'Convert lead → customer', priority: 'P1', automation: 'manual', passCriteria: 'Customer linked; lead marked won' },
  { id: 'WF-16', title: 'Public intake form submit → lead/customer', priority: 'P0', automation: 'workflow', passCriteria: 'POST /public/intake + row visible in leads' },

  // §4.4 Jobs & scheduling
  { id: 'WF-17', title: 'Create job from customer', priority: 'P0', automation: 'matrix', delegate: 'SCH-01', passCriteria: 'Job row + appears on /jobs' },
  { id: 'WF-18', title: 'Job lifecycle: scheduled → in progress → complete', priority: 'P0', automation: 'sweep', delegate: '/jobs/:id', passCriteria: 'Status transitions audit-logged' },
  { id: 'WF-19', title: 'Create appointment on schedule calendar', priority: 'P0', automation: 'matrix', delegate: 'SCH-01', passCriteria: 'Appointment visible week view' },
  { id: 'WF-20', title: 'Reschedule appointment (UI + API)', priority: 'P0', automation: 'matrix', delegate: 'SCH-02', passCriteria: 'Window + version update; single assignment' },
  { id: 'WF-21', title: 'Cancel appointment', priority: 'P1', automation: 'matrix', delegate: 'SCH-03', passCriteria: 'Status canceled; dispatch event' },
  { id: 'WF-22', title: 'Clock in / out time entry on job', priority: 'P1', automation: 'sweep', delegate: '/technician/day', passCriteria: 'Time entry rows; weekly hours API' },

  // §4.5 Dispatch & field (P1 for solo launch)
  { id: 'WF-23', title: 'Dispatch: drag unassigned → technician lane', priority: 'P1', automation: 'manual', delegate: '/dispatch', passCriteria: 'Assignment proposal or direct assign' },
  { id: 'WF-24', title: 'Feasibility preview before confirm', priority: 'P1', automation: 'manual', passCriteria: 'Overlap/travel warnings surface' },
  { id: 'WF-25', title: 'Approve schedule proposal from dispatch', priority: 'P1', automation: 'manual', delegate: '/inbox', passCriteria: 'Proposal executed; calendar updates' },
  { id: 'WF-26', title: 'Technician day view: arrival + status SMS', priority: 'P1', automation: 'sweep', delegate: '/technician/day', passCriteria: 'Status update + optional customer notify' },
  { id: 'WF-27', title: 'Tech job view ?view=tech status CTAs', priority: 'P1', automation: 'sweep', passCriteria: 'Mobile CTAs change job state' },

  // §4.6 Money loop
  { id: 'WF-28', title: 'Draft estimate with line items (billing engine totals)', priority: 'P0', automation: 'matrix', delegate: 'EST-01', passCriteria: 'Integer cents correct in API + DB' },
  { id: 'WF-29', title: 'Send estimate to customer (SMS/email)', priority: 'P0', automation: 'journey', delegate: 'JRN-01', passCriteria: 'Status sent; dispatch log row' },
  { id: 'WF-30', title: 'Customer approves estimate on /e/:token', priority: 'P0', automation: 'matrix', delegate: 'PORT-01', passCriteria: 'Status accepted; deposit if configured' },
  { id: 'WF-31', title: 'Convert estimate → invoice (no re-key)', priority: 'P0', automation: 'matrix', delegate: 'BILL-01', passCriteria: 'estimate_id link; line items preserved' },
  { id: 'WF-32', title: 'Issue invoice + delivery', priority: 'P0', automation: 'matrix', delegate: 'BILL-02', passCriteria: 'Issued timestamp; customer receives link' },
  { id: 'WF-33', title: 'Customer pays on /pay/:id (Stripe)', priority: 'P0', automation: 'journey', delegate: 'e2e/journeys/invoice-to-payment.spec.ts', passCriteria: 'checkout.session.completed → invoice paid' },
  { id: 'WF-34', title: 'Partial payment → full pay + overpay guard', priority: 'P1', automation: 'matrix', delegate: 'PAY-01', passCriteria: 'partially_paid → paid; overpay rejected' },
  { id: 'WF-35', title: 'Money dashboard + overdue state', priority: 'P1', automation: 'matrix', delegate: 'PAY-03', passCriteria: 'Revenue reflects payments; overdue job state' },

  // §4.7 AI proposals & assistant
  { id: 'WF-36', title: 'Inbox: approve booking proposal', priority: 'P0', automation: 'manual', delegate: '/inbox', passCriteria: 'Executor runs; appointment exists' },
  { id: 'WF-37', title: 'Inbox: reject proposal (no side effect)', priority: 'P0', automation: 'manual', passCriteria: 'Status rejected; no duplicate entity' },
  { id: 'WF-38', title: 'Inbox: edit proposal payload before approve', priority: 'P1', automation: 'manual', passCriteria: 'Edited fields in execution result' },
  { id: 'WF-39', title: 'Assistant chat → create estimate proposal', priority: 'P1', automation: 'matrix', delegate: 'AST-02', passCriteria: 'Proposal card → approve → estimate row' },
  { id: 'WF-40', title: 'Voice bar command → proposal or navigation', priority: 'P1', automation: 'sweep', passCriteria: 'Transcript routed; no silent failure' },
  { id: 'WF-41', title: 'Proposal toast → review in inbox', priority: 'P1', automation: 'sweep', delegate: '/inbox', passCriteria: 'Toast navigates to /inbox' },

  // §4.8 Inbound voice
  { id: 'WF-42', title: 'Inbound call: identify → book appointment proposal', priority: 'P0', automation: 'matrix', delegate: 'SCH-02 / CUST-02', passCriteria: 'Session + proposal; approve → appointment' },
  { id: 'WF-43', title: 'Emergency utterance → escalation path', priority: 'P0', automation: 'matrix', delegate: 'VOX-01', passCriteria: 'Escalation state; human handoff context' },
  { id: 'WF-44', title: 'Recording webhook → transcript → interaction log', priority: 'P1', automation: 'matrix', delegate: 'VOICE-01', passCriteria: 'Interaction visible on /interactions' },
  { id: 'WF-45', title: 'In-app voice session (WebSocket)', priority: 'P1', automation: 'manual', passCriteria: 'Session completes; proposals optional' },
  { id: 'WF-46', title: 'View call transcript drawer', priority: 'P1', automation: 'sweep', delegate: '/interactions', passCriteria: 'Transcript loads without 5xx' },

  // §4.9 Public & customer self-service
  { id: 'WF-47', title: 'Customer portal token: view jobs/estimates/invoices', priority: 'P0', automation: 'matrix', delegate: 'PORTAL-01', passCriteria: 'Tabs load token-scoped data only' },
  { id: 'WF-48', title: 'Portal request service → creates lead/job proposal', priority: 'P1', automation: 'manual', passCriteria: 'Request recorded; operator notified' },
  { id: 'WF-49', title: 'Post-job feedback /public/feedback/:token', priority: 'P1', automation: 'sweep', passCriteria: 'Rating persisted; dashboard chart updates' },

  // §4.10 Integrations
  { id: 'WF-50', title: 'Google Calendar connect → appointment push → verify event', priority: 'P1', automation: 'api-test', delegate: 'calendar-integrations.route.test.ts', passCriteria: 'OAuth + appointment_calendar_events synced' },
];

export const P0_WORKFLOW_IDS = WORKFLOWS.filter((w) => w.priority === 'P0').map((w) => w.id);

export function workflow(id: string): WorkflowDef {
  const w = WORKFLOWS.find((row) => row.id === id);
  if (!w) throw new Error(`Unknown workflow id: ${id}`);
  return w;
}
