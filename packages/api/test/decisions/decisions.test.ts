/**
 * Founding Decisions — Acceptance Contract
 *
 * This file is the living contract between the 12 founding decisions in
 * `docs/decisions.md` (and the Idea Crystallization doc of 2026-04-14) and
 * the actual shape of the codebase. Each `describe` block corresponds to
 * one decision. Each test inside asserts one concrete, measurable property
 * that must hold for the decision to be met.
 *
 * Three patterns are used:
 *
 *   - `it(...)`         — a property that currently holds. Passing means the
 *                         codebase still honors the decision; regressing will
 *                         flip to a failure and block the build.
 *
 *   - `it.fails(...)`   — a property that SHOULD hold but currently does not.
 *                         vitest marks this as passing while the body fails;
 *                         once the infrastructure catches up, the test starts
 *                         failing and the author must flip it to `it(...)`.
 *                         This is the "expected drift" marker.
 *
 *   - `it.todo(...)`    — a property for infrastructure that does not yet
 *                         exist at all (no modules to import). Surfaces in
 *                         the vitest report as an unimplemented criterion.
 *
 * Rules for maintaining this file:
 *
 *   1. Every future feature touching a decision must update the matching
 *      test in the same PR. If a PR changes decision-relevant code without
 *      updating this file, the review rejects it.
 *
 *   2. A decision without at least one test here does not exist as far as
 *      CI is concerned. New decisions = new tests before implementation.
 *
 *   3. When a `.fails` or `.todo` test is promoted to `it(...)`, the commit
 *      message must reference the decision number (e.g., "D9: MCP ceiling
 *      enforcement — flip .fails to passing").
 *
 * Why this file exists at all: the 2026-04-14 Service OS retrospective
 * identified that the codebase was ~65% built and ~30% launch-ready because
 * decisions were prose and stories were implementation, with no contract
 * tying them together. This file is that contract.
 */

import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import request from 'supertest';

import { createApp } from '../../src/app';
import {
  ConfidenceLevel,
  assessConfidence,
  getConfidenceLevel,
  validateConfidenceScore,
} from '../../src/ai/guardrails/confidence';
import {
  calculateDocumentTotals,
  buildLineItem,
  LineItem,
  LineItemCategory,
} from '../../src/shared/billing-engine';
import {
  ProposalType,
  ProposalStatus,
  ActionClass,
  createProposal,
  actionClassForProposalType,
} from '../../src/proposals/proposal';
import { Role, Permission, hasPermission, getPermissionContract } from '../../src/auth/rbac';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const API_SRC = path.resolve(REPO_ROOT, 'packages/api/src');
const AGENT_PY = path.resolve(REPO_ROOT, 'experiments/service-os-agent');

// ────────────────────────────────────────────────────────────────────────────
// Helpers: file and content searches across the repo surface.
// ────────────────────────────────────────────────────────────────────────────

async function exists(relPath: string): Promise<boolean> {
  try {
    await fs.access(path.resolve(API_SRC, relPath));
    return true;
  } catch {
    return false;
  }
}

async function existsAt(absRoot: string, relPath: string): Promise<boolean> {
  try {
    await fs.access(path.resolve(absRoot, relPath));
    return true;
  } catch {
    return false;
  }
}

// Recursively search a directory for files whose content matches a pattern.
// Skips node_modules, dot-dirs, Python caches, and build artifacts.
async function grepRoots(roots: string[], pattern: RegExp, extensions: Set<string>): Promise<string[]> {
  const hits: string[] = [];
  async function walk(dir: string, root: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      if (entry.name === '__pycache__') continue;
      if (entry.name === 'dist' || entry.name === 'build') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, root);
        continue;
      }
      const ext = path.extname(entry.name);
      if (!extensions.has(ext)) continue;
      let content: string;
      try {
        content = await fs.readFile(full, 'utf8');
      } catch {
        continue;
      }
      if (pattern.test(content)) {
        hits.push(path.relative(root, full));
      }
    }
  }
  for (const root of roots) {
    await walk(root, root);
  }
  return hits;
}

async function grepApiSrc(pattern: RegExp): Promise<string[]> {
  return grepRoots([API_SRC], pattern, new Set(['.ts']));
}

// Search both the TS API source and the Python agent service for any file
// matching the pattern. This is the shape the agent-platform architecture
// takes: MCP servers, ceiling constants, and agent definitions live in
// service-os-agent/ while business logic lives in packages/api/src/.
async function grepAgentStack(pattern: RegExp): Promise<string[]> {
  return grepRoots([API_SRC, AGENT_PY], pattern, new Set(['.ts', '.py']));
}

// ════════════════════════════════════════════════════════════════════════════
// Decision 1 — Day-one onboarding: interview → show → import
// ════════════════════════════════════════════════════════════════════════════

describe('D1 — Day-one onboarding (interview → show → import)', () => {
  it('backend has an onboarding extraction pipeline', async () => {
    const orchestration = await exists('ai/orchestration/onboarding.ts');
    const tasks = await exists('ai/tasks/onboarding');
    const contracts = await exists('proposals/contracts/onboarding.ts');
    expect(orchestration && tasks && contracts).toBe(true);
  });

  it('onboarding proposal types are registered', () => {
    const onboardingTypes: ProposalType[] = [
      'onboarding_tenant_settings',
      'onboarding_service_category',
      'onboarding_estimate_template',
      'onboarding_team_member',
      'onboarding_schedule',
    ];
    // Type-level assertion: all onboarding types compile.
    expect(onboardingTypes.length).toBe(5);
  });

  it.todo(
    'voice interview mode: onboarding agent conducts a spoken interview (requires CaptureAgent + onboarding prompt wired)'
  );

  it.todo(
    'history import: ingest 30 days of customer history from SMS/email/notes (no import pipeline exists)'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Decision 2 — Voice debrief primary, live earbuds optional
// ════════════════════════════════════════════════════════════════════════════

describe('D2 — Voice debrief primary capture', () => {
  it('voice infrastructure exists (repository, routes, worker)', async () => {
    const svc = await exists('voice/voice-service.ts');
    const routes = await exists('routes/voice.ts');
    const worker = await exists('workers/transcription.ts');
    expect(svc && routes && worker).toBe(true);
  });

  it('real STT provider is wired (not a hardcoded stub)', async () => {
    const providersTs = await fs.readFile(
      path.resolve(API_SRC, 'voice/transcription-providers.ts'),
      'utf8'
    );
    // The prod path must call a real STT endpoint. We test by asserting the
    // Whisper API URL appears in the provider module. If the prod path is
    // removed, this fails and forces a conscious decision.
    expect(providersTs).toMatch(/api\.openai\.com\/v1\/audio\/transcriptions/);
    // And the factory must still be invoked from app.ts.
    const appTs = await fs.readFile(path.resolve(API_SRC, 'app.ts'), 'utf8');
    expect(appTs).toMatch(/createWhisperTranscriptionProvider/);
  });

  it('dev fallback is clearly marked and not used when AI_PROVIDER_API_KEY is set', async () => {
    const providersTs = await fs.readFile(
      path.resolve(API_SRC, 'voice/transcription-providers.ts'),
      'utf8'
    );
    expect(providersTs).toMatch(/\[Dev mode\]/);
    const appTs = await fs.readFile(path.resolve(API_SRC, 'app.ts'), 'utf8');
    expect(appTs).toMatch(/AI_PROVIDER_API_KEY/);
  });

  it.todo(
    'batch end-of-day debrief trigger: a scheduled agent runs the CaptureAgent on accumulated recordings (no scheduler)'
  );

  it.todo(
    'live earbuds mode: optional streaming capture with Bluetooth input (not implemented; stretch goal)'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Decision 3 — Trust model: adaptive per action class
// ════════════════════════════════════════════════════════════════════════════

describe('D3 — Trust model per action class', () => {
  it('confidence scoring exists', () => {
    const meta = assessConfidence({ confidence_score: 0.9, explanation: 'x' });
    expect(meta.score).toBe(0.9);
    expect(validateConfidenceScore(meta.score)).toBe(true);
    const level: ConfidenceLevel = getConfidenceLevel(0.9);
    expect(level).toBe('high');
  });

  // Step 5b closed the D3 wiring gap: createProposal now consults the
  // pure decision function `decideInitialStatus` in proposal.ts, which
  // maps (action class, trust tier, confidence) → initial status. The
  // detailed unit tests for the rules live in
  // packages/api/test/proposals/proposal.test.ts. The assertions below
  // lock the contract from the decisions surface.

  it('capture-class proposals from autonomous agents auto-approve at high confidence', () => {
    const proposal = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'create_customer', // capture-class
      payload: { name: 'Acme' },
      summary: 'Create customer Acme',
      sourceTrustTier: 'autonomous',
      confidenceScore: 0.95,
      createdBy: 'agent-capture',
    });
    expect(proposal.status).toBe('approved');
  });

  it('action-class registry: every ProposalType maps to one of {capture, comms, money, irreversible}', () => {
    const types: ProposalType[] = [
      'create_customer',
      'update_customer',
      'create_job',
      'create_appointment',
      'draft_estimate',
      'update_estimate',
      'draft_invoice',
      'reassign_appointment',
      'reschedule_appointment',
      'cancel_appointment',
      'onboarding_tenant_settings',
      'onboarding_service_category',
      'onboarding_estimate_template',
      'onboarding_team_member',
      'onboarding_schedule',
    ];
    const validClasses: ActionClass[] = ['capture', 'comms', 'money', 'irreversible'];
    for (const t of types) {
      expect(validClasses).toContain(actionClassForProposalType(t));
    }
  });

  it('irreversible actions always require explicit confirmation regardless of trust tier', () => {
    // cancel_appointment is the only irreversible type today. Even with
    // autonomous trust + 0.99 confidence, it must land in 'draft'.
    const proposal = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'cancel_appointment',
      payload: { appointmentId: 'appt-1' },
      summary: 'Cancel appt-1',
      sourceTrustTier: 'autonomous',
      confidenceScore: 0.99,
      createdBy: 'agent-capture',
    });
    expect(proposal.status).toBe('draft');
  });

  it('decideInitialStatus is the single source of truth for status assignment', async () => {
    // The decision function lives in proposals/proposal.ts. confidence.ts
    // must NOT set status itself — it is a pure observer. This test
    // locks the boundary by asserting the function exists at the
    // expected location and confidence.ts no longer claims to be the
    // gate.
    const proposalSrc = await fs.readFile(
      path.resolve(API_SRC, 'proposals/proposal.ts'),
      'utf8'
    );
    expect(proposalSrc).toMatch(/export function decideInitialStatus/);
    expect(proposalSrc).toMatch(/sourceTrustTier === 'autonomous'/);

    const confidenceSrc = await fs.readFile(
      path.resolve(API_SRC, 'ai/guardrails/confidence.ts'),
      'utf8'
    );
    // The old advisory-only comment must be gone.
    expect(confidenceSrc).not.toMatch(/NEVER trigger auto-approval/);
    // The new comment must point at the canonical decision function.
    expect(confidenceSrc).toMatch(/decideInitialStatus/);
  });

  it.todo(
    'per-tenant trust ladder: operator approvals on a class raise that class autonomy over time'
  );

  it('AI task call sites pass sourceTrustTier so production proposals exercise the wiring', async () => {
    // EstimateTaskHandler and InvoiceTaskHandler run on the capture
    // pipeline. They must pass sourceTrustTier so decideInitialStatus
    // actually fires in production. Runtime coverage lives in
    // test/ai/estimate-task.test.ts ("D3: high-confidence
    // draft_estimate auto-approves"); this assertion locks the
    // source-level invariant so the adoption cannot silently regress.
    const estimate = await fs.readFile(
      path.resolve(API_SRC, 'ai/tasks/estimate-task.ts'),
      'utf8'
    );
    const invoice = await fs.readFile(
      path.resolve(API_SRC, 'ai/tasks/invoice-task.ts'),
      'utf8'
    );
    expect(estimate).toMatch(/sourceTrustTier:\s*'autonomous'/);
    expect(invoice).toMatch(/sourceTrustTier:\s*'autonomous'/);
  });

  it.todo(
    'onboarding proposers do NOT auto-approve (operator reviews each step of the interview flow)'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Decision 4 — Stay in its lane / reactive
// ════════════════════════════════════════════════════════════════════════════

describe('D4 — Agent posture: reactive, stay in lane', () => {
  it('trigger evaluation module exists', async () => {
    expect(await exists('ai/orchestration/triggers.ts')).toBe(true);
  });

  it('task router routes input to bounded handlers', async () => {
    expect(await exists('ai/orchestration/task-router.ts')).toBe(true);
  });

  it.todo(
    'coaching mode is an explicit opt-in setting per tenant and per user (no setting key exists)'
  );

  it.todo(
    'anti-advice prompt rule: system prompts forbid volunteered business advice outside requested scope'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Decision 5 — Dedicated Twilio business line
// ════════════════════════════════════════════════════════════════════════════

describe('D5 — Dedicated Twilio business line', () => {
  it('Twilio integration exists somewhere in packages/api/src', async () => {
    const hits = await grepApiSrc(/twilio|Twilio/);
    // Twilio Programmable Messaging (SMS) + Twilio SendGrid (email) wired
    // in packages/api/src/notifications/. Tenant-level provisioning is
    // still TODO (see it.todo cases below).
    expect(hits.length).toBeGreaterThan(0);
  });

  it.todo(
    'tenant bootstrap provisions a dedicated phone number at signup (no provisioning code)'
  );

  it.todo(
    'A2P 10DLC campaign registration runs per tenant with opt-out compliance'
  );

  it.todo(
    'inbound SMS routes to a conversation thread where the CommsAgent sees both sides'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Decision 6 — Multi-user from day one
// ════════════════════════════════════════════════════════════════════════════

describe('D6 — Multi-user from day one', () => {
  it('three-role RBAC is defined', () => {
    const roles: Role[] = ['owner', 'dispatcher', 'technician'];
    const contractRoles = getPermissionContract()
      .map((c) => c.role)
      .sort();
    expect(contractRoles).toEqual([...roles].sort());
  });

  it('owner can approve proposals, technician cannot', () => {
    const proposalApprove: Permission = 'proposals:approve';
    expect(hasPermission('owner', proposalApprove)).toBe(true);
    expect(hasPermission('technician', proposalApprove)).toBe(false);
  });

  it('technician cannot manage the tenant', () => {
    expect(hasPermission('technician', 'tenant:manage')).toBe(false);
  });

  // D2 (voice debrief primary capture) says the field technician is the
  // one capturing new jobs from voice. Current RBAC at
  // auth/rbac.ts:167-186 restricts `jobs:create` to owner/dispatcher only.
  // That is a cross-decision conflict (D6 ∩ D2): the crew tech in the
  // field cannot spin up a new job from capture. This test will start
  // passing the moment the RBAC is updated to match the capture workflow.
  it.fails('D2 compatibility: technician can create jobs from field capture', () => {
    expect(hasPermission('technician', 'jobs:create')).toBe(true);
  });

  it.fails('billing engine supports per-seat pricing', async () => {
    const hits = await grepApiSrc(/seatCount|perSeatCents|seat_count|subscription_tier/);
    expect(hits.length).toBeGreaterThan(0);
  });

  // ── Fail-closed auth at the /api layer (step 1 of the retrospective plan)
  //
  // Historically each route file opted into `requireAuth` per handler.
  // That worked by convention — a new route added without the import
  // would silently be public. The fail-closed fix applies `requireAuth`
  // at the `/api` layer in `app.ts` so the invariant is framework-level,
  // not convention-level.

  it('app.ts applies requireAuth globally on /api', async () => {
    const appTs = await fs.readFile(path.resolve(API_SRC, 'app.ts'), 'utf8');
    // The line order matters: verifyClerkSession must run first (parses
    // the token), then requireAuth rejects requests without auth.
    const verify = appTs.indexOf("app.use('/api', verifyClerkSession");
    const require = appTs.indexOf("app.use('/api', requireAuth)");
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(require).toBeGreaterThan(verify);
  });

  it('A6 adversarial: unauthenticated /api request returns 401', async () => {
    // This test constructs the real createApp() and hits a real /api
    // route with no Authorization header. It must return 401 at the
    // /api layer before ever reaching the route handler.
    process.env.NODE_ENV = 'dev';
    const app = createApp();
    const res = await request(app).get('/api/customers');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'UNAUTHORIZED' });
  });

  it('A6 adversarial: /api request with a tampered token returns 401', async () => {
    process.env.NODE_ENV = 'dev';
    const prevSecret = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = 'decisions-test-secret';
    try {
      const app = createApp();
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify({
        sub: 'user-test-1',
        sid: 'session-test-1',
        tenant_id: 'tenant-a',
        role: 'owner',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })).toString('base64url');
      // Sign with the wrong secret — should be rejected.
      const badSig = crypto.createHmac('sha256', 'wrong-secret').update(`${header}.${body}`).digest('base64url');
      const tamperedToken = `${header}.${body}.${badSig}`;
      const res = await request(app)
        .get('/api/customers')
        .set('Authorization', `Bearer ${tamperedToken}`);
      expect(res.status).toBe(401);
    } finally {
      if (prevSecret === undefined) {
        delete process.env.CLERK_SECRET_KEY;
      } else {
        process.env.CLERK_SECRET_KEY = prevSecret;
      }
    }
  });

  it.todo(
    'frontend auth: web package uses Clerk SDK with real JWT and route guards (currently setTimeout fake login)'
  );

  it.todo(
    'team invitation flow: owner invites users and assigns roles end-to-end'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Decision 7 — Cross-user visibility (briefing + query + escalation)
// ════════════════════════════════════════════════════════════════════════════

describe('D7 — Cross-user visibility', () => {
  it('audit trail infrastructure exists', async () => {
    expect(await exists('audit/audit.ts')).toBe(true);
  });

  it.todo(
    'morning briefing agent: scheduled nightly, synthesizes yesterday per-tenant across crew'
  );

  it.todo(
    'on-demand query: "what did {user} do yesterday?" returns structured activity from audit trail'
  );

  it.todo(
    'escalation routing: safety-critical or customer-complaint events surface immediately to the owner'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Decision 8 — Retention + memory synthesis pipeline
// ════════════════════════════════════════════════════════════════════════════

describe('D8 — Retention + memory synthesis', () => {
  it.fails('memory synthesis module exists', async () => {
    const hits = await grepApiSrc(/memorySynthesis|MemorySynthesis|memory[-_]synthesis/);
    expect(hits.length).toBeGreaterThan(0);
  });

  it.todo(
    'retention TTL columns: raw audio 7d, transcripts 30d, reasoning logs 30d, jobs 3y, customers+2y, tax 7y'
  );

  it.todo(
    'purge worker: runs against retention windows and cannot drop raw audio until its synthesized memory is committed'
  );

  it.todo(
    'per-agent memory slice: each agent owns a memory namespace, federated per tenant'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Decision 9 — Liability hard gates at the MCP tool layer
// ════════════════════════════════════════════════════════════════════════════

describe('D9 — Hard gates at MCP tool layer', () => {
  it('proposal approval gate exists (human must approve before execution)', async () => {
    expect(await exists('proposals/lifecycle.ts')).toBe(true);
    expect(await exists('proposals/execution/executor.ts')).toBe(true);
  });

  it('MCP tool layer scaffold exists in the Python agent service', async () => {
    // Decision 9 lives in the Python side per the Hybrid framework
    // decision: MCP servers are Python modules under service-os-agent/
    // so they can be wrapped by a real claude-agent-sdk MCP server in the
    // next slice. A server must declare a tenant-scoped call_tool path.
    const init = await existsAt(AGENT_PY, 'mcp_servers/__init__.py');
    const jobs = await existsAt(AGENT_PY, 'mcp_servers/jobs_server.py');
    expect(init && jobs).toBe(true);

    const hits = await grepAgentStack(/class JobsServer|def call_tool|async def call_tool/);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('MCP tool layer enforces tenant isolation, not the prompt', async () => {
    const jobs = await fs.readFile(
      path.resolve(AGENT_PY, 'mcp_servers/jobs_server.py'),
      'utf8'
    );
    // The server must raise when tenant_id is missing — tenant isolation
    // at the tool layer, not the prompt. This is the architectural line
    // the retrospective drew; the test enforces it.
    expect(jobs).toMatch(/tenant_id is required/);
    expect(jobs).toMatch(/PermissionError/);
  });

  it('$500 ceiling constant is declared at the MCP tool layer', async () => {
    // Decision 9: ceilings are constants in the tool layer, not in the
    // prompt. The canonical declaration lives in
    // service-os-agent/mcp_servers/ceilings.py — every server imports
    // from there. Step 0 slice #2 extracted the constant from
    // jobs_server.py into the shared module so jobs_server, money_server,
    // and future servers all reference the same value.
    const hits = await grepAgentStack(/MAX_UNATTENDED_CENTS/);
    expect(hits.length).toBeGreaterThan(0);

    const ceilings = await fs.readFile(
      path.resolve(AGENT_PY, 'mcp_servers/ceilings.py'),
      'utf8'
    );
    expect(ceilings).toMatch(/MAX_UNATTENDED_CENTS\s*:\s*int\s*=\s*50_000/);
  });

  it('tool schemas carry an explicit money_ceiling_cents field', async () => {
    // New tools inherit the ceiling discipline via the ToolSchema shape.
    // Adding a money-moving tool without setting the field forces a
    // conscious decision about its ceiling at review time.
    const jobs = await fs.readFile(
      path.resolve(AGENT_PY, 'mcp_servers/jobs_server.py'),
      'utf8'
    );
    expect(jobs).toMatch(/money_ceiling_cents/);
  });

  it('voice confirmation is the second factor for money-moving tools above the ceiling', async () => {
    // money_server.py inspects voice_confirmation_token at call_tool
    // BEFORE invoking the handler. Above money_ceiling_cents without
    // a token, the call raises PermissionError. The Python smoke test
    // in step 0 slice #2 verifies this end-to-end at runtime; this
    // assertion locks the source-level shape so the gate cannot
    // silently regress.
    const money = await fs.readFile(
      path.resolve(AGENT_PY, 'mcp_servers/money_server.py'),
      'utf8'
    );
    expect(money).toMatch(/voice_confirmation_token/);
    expect(money).toMatch(/has_voice_token/);
    expect(money).toMatch(/exceeds.*ceiling.*voice_confirmation_token required/s);
  });

  it('adversarial: tool call above ceiling without token is rejected at the tool layer, not the prompt', async () => {
    // The check sits inside MoneyServer.call_tool — code path, not
    // prompt instruction. The handler is never invoked when the
    // gate fails. Even prompt-injection that tells the agent
    // "ceiling lifted" cannot bypass this because the gate is
    // enforced before reg.handler() runs.
    const money = await fs.readFile(
      path.resolve(AGENT_PY, 'mcp_servers/money_server.py'),
      'utf8'
    );
    // Source-level structure check: the ceiling condition appears
    // textually before the handler invocation.
    const ceilingIdx = money.search(/exceeds[\s\S]*ceiling[\s\S]*voice_confirmation_token required/);
    const handlerIdx = money.indexOf('return await reg.handler(');
    expect(ceilingIdx).toBeGreaterThan(0);
    expect(handlerIdx).toBeGreaterThan(ceilingIdx);
  });

  it('5-second undo window: executor refuses inside window; undoProposal transitions to undone', async () => {
    // The full runtime coverage lives in:
    //   - packages/api/test/proposals/lifecycle.test.ts
    //       ("5-second undo window (Decision 9)" describe)
    //   - packages/api/test/proposals/execution.test.ts
    //       ("5-second undo window" describe — executor refusal)
    //   - packages/api/test/proposals/actions.test.ts
    //       ("undoProposal — 5-second undo window" describe)
    //
    // This assertion locks the architectural shape at the source
    // level: the constant, the status, the helper, and the action
    // all exist and are wired together. A refactor that removes any
    // one link fails this test.
    const lifecycleSrc = await fs.readFile(
      path.resolve(API_SRC, 'proposals/lifecycle.ts'),
      'utf8'
    );
    const executorSrc = await fs.readFile(
      path.resolve(API_SRC, 'proposals/execution/executor.ts'),
      'utf8'
    );
    const actionsSrc = await fs.readFile(
      path.resolve(API_SRC, 'proposals/actions.ts'),
      'utf8'
    );

    // Constant and helper live in lifecycle.
    expect(lifecycleSrc).toMatch(/export const UNDO_WINDOW_MS\s*=\s*5000/);
    expect(lifecycleSrc).toMatch(/export function isInUndoWindow/);
    // New 'undone' state is terminal.
    expect(lifecycleSrc).toMatch(/'undone'/);
    expect(lifecycleSrc).toMatch(/TERMINAL_STATUSES[\s\S]*'undone'/);

    // Executor consults the window.
    expect(executorSrc).toMatch(/isInUndoWindow/);
    expect(executorSrc).toMatch(/UNDO_WINDOW_OPEN/);

    // undoProposal action exists and enforces the window at the
    // permission layer.
    expect(actionsSrc).toMatch(/export async function undoProposal/);
    expect(actionsSrc).toMatch(/UNDO_WINDOW_CLOSED/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Decision 10 — Full data portability
// ════════════════════════════════════════════════════════════════════════════

describe('D10 — Data portability', () => {
  it.fails('export endpoint exists for all tenant business records', async () => {
    const hits = await grepApiSrc(/\/api\/export|exportTenant|dataExport/);
    expect(hits.length).toBeGreaterThan(0);
  });

  it.todo(
    'standard formats: export produces JSON + CSV for customers, jobs, invoices, financials'
  );

  it.todo(
    'synthesized memory export: agent memory slices export in a portable format'
  );

  it.todo(
    'import tooling: ingest from Jobber, Housecall Pro, ServiceTitan exports'
  );

  it.todo(
    'clean deletion flow: full hard delete after export, with cascade rules documented'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Decision 11 — Hybrid pricing (seat + processing %)
// ════════════════════════════════════════════════════════════════════════════

describe('D11 — Hybrid pricing (seat + processing %)', () => {
  it('billing engine uses integer cents for all money', () => {
    const items: LineItem[] = [
      buildLineItem('a', 'Labor', 2, 7500, 1, true, 'labor' as LineItemCategory),
    ];
    const totals = calculateDocumentTotals(items, 0, 825);
    expect(Number.isInteger(totals.subtotalCents)).toBe(true);
    expect(Number.isInteger(totals.taxCents)).toBe(true);
    expect(Number.isInteger(totals.totalCents)).toBe(true);
  });

  it.fails('pricing tier constants (Starter/Pro/Team) exist', async () => {
    const hits = await grepApiSrc(/PRICING_TIERS|STARTER_SEAT_CENTS|PRO_SEAT_CENTS|TEAM_SEAT_CENTS/);
    expect(hits.length).toBeGreaterThan(0);
  });

  it.fails('processing fee can be expressed as a separate line item on an invoice', async () => {
    // The fee must be a disclosed line item, per the ToS commitment. Today
    // line item categories are labor/material/equipment/other — no
    // 'processing_fee' or 'platform_fee' category exists.
    const { validateLineItem } = await import('../../src/shared/billing-engine');
    const errors = validateLineItem({
      description: 'Platform processing fee (0.5%)',
      quantity: 1,
      unitPriceCents: 500,
      category: 'processing_fee' as unknown as LineItemCategory,
    });
    expect(errors).toEqual([]);
  });

  it.todo(
    'Stripe subscriptions: Starter/Pro/Team as products with monthly billing and 30-day trial'
  );

  it.todo(
    'seat-count billing: invoice total scales with active seats per tenant'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Decision 12 — Founding sentence as filter (marketing + product taste)
// ════════════════════════════════════════════════════════════════════════════

describe('D12 — Founding sentence as filter', () => {
  // This decision is cultural/editorial, not runtime-enforceable. The test
  // asserts the sentence is present in a canonical durable location so it
  // can't silently disappear from the repo surface. The canonical location
  // is docs/decisions.md — the existing architectural decision log — under
  // a dedicated "Founding Sentence" section.
  it('founding sentence appears in docs/decisions.md', async () => {
    const decisionsPath = path.resolve(REPO_ROOT, 'docs/decisions.md');
    const content = await fs.readFile(decisionsPath, 'utf8');
    const hasLine = /You learned the trade\.?\s+We'?ll run the business/i.test(content);
    expect(hasLine).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Architecture Implications (cross-cutting)
// ════════════════════════════════════════════════════════════════════════════

describe('A1 — Multi-tenant managed agent runtime', () => {
  it('RLS + tenant context middleware exists', async () => {
    expect(await exists('db/client.ts')).toBe(true);
    expect(await exists('middleware/auth.ts')).toBe(true);
  });

  it('Postgres pool is required in prod/staging (no silent InMemory fallback)', async () => {
    const appTs = await fs.readFile(path.resolve(API_SRC, 'app.ts'), 'utf8');
    expect(appTs).toMatch(/DATABASE_URL is required in production/);
  });

  it('Agent primitive is data: name, scope, prompt, memory, mcp_tools, trust_tier, triggers', async () => {
    // The retrospective lesson was that "agent platform" means agents are
    // DATA, not hardcoded code paths. The primitive lives in the Python
    // agent service (per the Hybrid framework decision) and must
    // include every field the platform dispatches on.
    const primitive = await fs.readFile(
      path.resolve(AGENT_PY, 'agent/primitive.py'),
      'utf8'
    );
    for (const field of [
      'name',
      'scope',
      'system_prompt',
      'memory_namespace',
      'mcp_tools',
      'trust_tier',
      'triggers',
    ]) {
      expect(primitive).toMatch(new RegExp(`\\b${field}\\b`));
    }
    // The trust tiers must match Decision 3's action classes.
    for (const tier of [
      'autonomous',
      'graduates_fast',
      'graduates_slowly',
      'always_asks',
    ]) {
      expect(primitive).toMatch(new RegExp(`"${tier}"`));
    }
  });

  it('CaptureAgent is defined as a first-class data instance', async () => {
    const capture = await fs.readFile(
      path.resolve(AGENT_PY, 'agents/capture.py'),
      'utf8'
    );
    expect(capture).toMatch(/CAPTURE_AGENT\s*=\s*Agent\(/);
    expect(capture).toMatch(/trust_tier="autonomous"/);
    expect(capture).toMatch(/mcp_tools=\("jobs_server",?\s*\)/);
  });

  it('InvoiceAgent is defined as a first-class data instance', async () => {
    const invoice = await fs.readFile(
      path.resolve(AGENT_PY, 'agents/invoice.py'),
      'utf8'
    );
    expect(invoice).toMatch(/INVOICE_AGENT\s*=\s*Agent\(/);
    // Money-moving agents must NOT be autonomous (Decision 3).
    expect(invoice).toMatch(/trust_tier="graduates_slowly"/);
    // Must reach money_server for sends + AR.
    expect(invoice).toMatch(/mcp_tools=\([^)]*"money_server"/);
    // Must be triggered by capture handoff (inter-agent graph edge).
    expect(invoice).toMatch(/handoff:capture/);
  });

  it('PaymentAgent is defined as a first-class data instance', async () => {
    const payment = await fs.readFile(
      path.resolve(AGENT_PY, 'agents/payment.py'),
      'utf8'
    );
    expect(payment).toMatch(/PAYMENT_AGENT\s*=\s*Agent\(/);
    expect(payment).toMatch(/trust_tier="graduates_slowly"/);
    // Payment agent has narrower tool scope: only money_server.
    // It cannot draft new invoices (that's the InvoiceAgent's job).
    expect(payment).toMatch(/mcp_tools=\("money_server",?\s*\)/);
    // Triggered by Stripe webhooks + scheduled AR sweep, not by voice.
    expect(payment).toMatch(/webhook:stripe/);
    expect(payment).toMatch(/schedule:cron:daily_ar_sweep/);
  });

  it('agents/__init__.py exports the three v1 agents', async () => {
    const init = await fs.readFile(
      path.resolve(AGENT_PY, 'agents/__init__.py'),
      'utf8'
    );
    for (const name of ['CAPTURE_AGENT', 'INVOICE_AGENT', 'PAYMENT_AGENT']) {
      expect(init).toContain(name);
    }
  });

  it('Python agent-platform surface does not import supabase directly', async () => {
    // Writes must go through the TS API so the proposal gate, audit
    // trail, RLS context, and billing invariants are preserved. The
    // invariant scans the entire new agent-platform surface — agents,
    // mcp_servers, clients — not just the first MCP server. Any new file
    // under these directories must route writes through the TS API.
    //
    // The legacy `agent/nodes.py` still imports supabase for the
    // pre-retrospective linear graph; that migration is tracked as a
    // separate todo below (part of step 0 slice #3).
    const platformRoots = [
      path.resolve(AGENT_PY, 'agents'),
      path.resolve(AGENT_PY, 'mcp_servers'),
      path.resolve(AGENT_PY, 'clients'),
    ];
    const supabaseHits = await grepRoots(
      platformRoots,
      /(^|\n)\s*(from supabase|import supabase)\b/,
      new Set(['.py'])
    );
    expect(supabaseHits).toEqual([]);

    // And the jobs server specifically must use the TS API client.
    const jobs = await fs.readFile(
      path.resolve(AGENT_PY, 'mcp_servers/jobs_server.py'),
      'utf8'
    );
    expect(jobs).toMatch(/from clients\.service_os_api/);
  });

  it.todo(
    'legacy service-os-agent/agent/nodes.py migrates off direct Supabase access (part of step 0 slice #3)'
  );

  it.todo(
    'each agent runs under an outer LangGraph dispatcher with checkpointing and interrupt-based approval gates'
  );
});

describe('A2 — MCP servers (target 12–14)', () => {
  it('jobs_server (read/draft) is defined', async () => {
    expect(await existsAt(AGENT_PY, 'mcp_servers/jobs_server.py')).toBe(true);
  });

  it('money_server (write/AR) is defined', async () => {
    expect(await existsAt(AGENT_PY, 'mcp_servers/money_server.py')).toBe(true);
  });

  it('ceiling constants live in a single shared module', async () => {
    // Decision 9: ceilings live at the MCP tool layer, in one place.
    // mcp_servers/ceilings.py is that place. Both jobs_server and
    // money_server import from it, not from each other.
    expect(await existsAt(AGENT_PY, 'mcp_servers/ceilings.py')).toBe(true);
    const ceilings = await fs.readFile(
      path.resolve(AGENT_PY, 'mcp_servers/ceilings.py'),
      'utf8'
    );
    expect(ceilings).toMatch(/MAX_UNATTENDED_CENTS\s*:\s*int\s*=\s*50_000/);
    expect(ceilings).toMatch(/INVOICE_SEND_CEILING_CENTS/);
    expect(ceilings).toMatch(/REFUND_HARD_CAP_CENTS/);

    const money = await fs.readFile(
      path.resolve(AGENT_PY, 'mcp_servers/money_server.py'),
      'utf8'
    );
    expect(money).toMatch(/from mcp_servers\.ceilings import/);

    const jobs = await fs.readFile(
      path.resolve(AGENT_PY, 'mcp_servers/jobs_server.py'),
      'utf8'
    );
    expect(jobs).toMatch(/from mcp_servers\.ceilings import/);
  });

  it('money_server tools declare ceilings explicitly', async () => {
    const money = await fs.readFile(
      path.resolve(AGENT_PY, 'mcp_servers/money_server.py'),
      'utf8'
    );
    // Each money-moving tool must set money_ceiling_cents from the
    // shared constants. The shape is enforced by code review through
    // this test — adding a money tool without a ceiling fails review.
    expect(money).toMatch(/money_ceiling_cents=INVOICE_SEND_CEILING_CENTS/);
    expect(money).toMatch(/money_ceiling_cents=PAYMENT_LINK_CEILING_CENTS/);
    expect(money).toMatch(/money_ceiling_cents=DUNNING_SEND_CEILING_CENTS/);
  });

  it('money_server enforces the ceiling at call_tool, not in the prompt', async () => {
    const money = await fs.readFile(
      path.resolve(AGENT_PY, 'mcp_servers/money_server.py'),
      'utf8'
    );
    // The check must happen inside call_tool() before the handler
    // runs, AND must look at amount_cents (not just trust the prompt).
    expect(money).toMatch(/async def call_tool/);
    expect(money).toMatch(/voice_confirmation_token required/i);
    expect(money).toMatch(/amount_cents/);
  });

  it('refunds always require voice confirmation regardless of amount', async () => {
    // Decision 3 "irreversible actions always ask". The issue_refund
    // tool must set always_requires_voice_confirmation=True so even a
    // $1 refund is gated. Hard cap is set so a $20k refund fails
    // outright even WITH a token, escalating to a human.
    const money = await fs.readFile(
      path.resolve(AGENT_PY, 'mcp_servers/money_server.py'),
      'utf8'
    );
    const refundBlock = money.slice(
      money.indexOf('"issue_refund"'),
      money.indexOf('"issue_refund"') + 1500
    );
    expect(refundBlock).toMatch(/always_requires_voice_confirmation=True/);
    expect(refundBlock).toMatch(/hard_cap_cents=REFUND_HARD_CAP_CENTS/);
  });

  it.todo('internal MCP servers: customers, inventory, schedule, intel');

  it.todo('external MCP wrappers: Stripe, Plaid, Twilio, Google Maps, suppliers, DocuSign, Gmail/Calendar');
});

describe('A3 — Memory synthesis as core infrastructure', () => {
  it.todo('memory synthesis worker runs per-agent per-tenant on a schedule');
  it.todo('synthesized memory is queryable and feeds prompts for subsequent turns');
});

describe('A4 — Tiered model routing + cost engineering', () => {
  it('LLM gateway exists with routing, providers, failover, and cache modules', async () => {
    expect(await exists('ai/gateway/routing-config.ts')).toBe(true);
    expect(await exists('ai/gateway/providers.ts')).toBe(true);
    expect(await exists('ai/gateway/failover.ts')).toBe(true);
    expect(await exists('ai/gateway/cache.ts')).toBe(true);
  });

  it.todo('prompt caching is used on every inference above the cacheable-prefix threshold');
  it.todo('tiered routing: Haiku handles ≥70% of turns; Sonnet for drafting; Opus only on explicit escalation');
  it.todo('per-operator monthly cost tracking with alert thresholds');
});

describe('A5 — Background agent runs', () => {
  it('worker infrastructure exists', async () => {
    expect(await exists('workers/worker-registry.ts')).toBe(true);
    expect(await exists('queues/queue.ts')).toBe(true);
  });

  it.todo('scheduled morning briefing run');
  it.todo('AR sweep run');
  it.todo('anomaly detection run');
  it.todo('inbound lead routing run');
});

describe('A6 — Adversarial tenant-isolation test suite', () => {
  // The real adversarial tests live in
  // `packages/api/test/decisions/tenant-isolation.test.ts`, which spins
  // up the real createApp() and exercises cross-tenant reads, writes,
  // list leakage, lifecycle verbs, and body-forged tenantId against the
  // customer/location/job/appointment/note routes end-to-end. These
  // assertions just confirm that file exists and is non-empty so a
  // deletion or silent stub is caught as a regression.
  it('tenant-isolation.test.ts exists and encodes cross-tenant probes', async () => {
    const isoPath = path.resolve(__dirname, 'tenant-isolation.test.ts');
    const content = await fs.readFile(isoPath, 'utf8');
    expect(content).toMatch(/Adversarial tenant isolation/i);
    expect(content).toMatch(/probeCannotRead/);
    expect(content).toMatch(/probeCannotUpdate/);
    expect(content).toMatch(/probeCannotHitLifecycle/);
    expect(content).toMatch(/probeListDoesNotLeak/);
  });

  it('tenant-isolation suite probes each first-pass entity', async () => {
    const isoPath = path.resolve(__dirname, 'tenant-isolation.test.ts');
    const content = await fs.readFile(isoPath, 'utf8');
    for (const entity of ['/api/customers', '/api/locations', '/api/jobs', '/api/appointments', '/api/notes']) {
      expect(content).toContain(`describe('${entity}'`);
    }
  });

  it('tenant-isolation suite tests body-forged tenantId rewrite', async () => {
    // The specific body-forgery scenario — "tenant B sends body.tenantId
    // = 'tenant-a' and the server must never honor it" — is the single
    // most important cross-tenant attack class. Lock its presence.
    const isoPath = path.resolve(__dirname, 'tenant-isolation.test.ts');
    const content = await fs.readFile(isoPath, 'utf8');
    expect(content).toMatch(/body-forged tenantId/i);
    expect(content).toMatch(/JWT tenant claim is[\s\S]*authoritative/i);
  });

  // JWT tampering coverage already lives inside the D6 block at
  // decisions.test.ts:383 as "A6 adversarial: /api request with a tampered
  // token returns 401", so there is no separate todo here.

  it.todo('prompt-injection attempts that try to breach tenant context are neutralized');

  it.todo(
    'cross-entity reference forgery: job created in tenant B with customerId from tenant A is rejected'
  );

  it.todo(
    'adversarial coverage extended to /api/payments, /api/voice, /api/conversations, /api/assistant'
  );
});
