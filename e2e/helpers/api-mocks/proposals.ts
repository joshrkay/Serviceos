/**
 * Stateful proposal mocks for the hermetic money-loop approve → execute spec.
 *
 * Seeds a ready_for_review draft_estimate, serves GET /api/proposals/inbox,
 * handles POST approve (→ approved), and advances to executed when the test
 * calls `advanceExecution()` (simulates the execution worker after the 5s
 * undo window — no multi-minute sleeps).
 */

import type { Page, Route } from '@playwright/test';
import {
  ProposalType,
  proposalResponseSchema,
  estimateResponseSchema,
} from '@ai-service-os/shared';
import { E2E_TENANT_ID } from './shell';

export const ESTIMATE_PROPOSAL_ID = '11111111-1111-4111-8111-111111111101';
export const RESULT_ESTIMATE_ID = '22222222-2222-4222-8222-222222222201';

export type ProposalLifecycleStatus =
  | 'ready_for_review'
  | 'approved'
  | 'executed'
  | 'rejected'
  | 'undone';

export interface ProposalMockState {
  id: string;
  status: ProposalLifecycleStatus;
  summary: string;
  proposalType: string;
  resultEntityId?: string;
  approvedAt?: string;
  payload: Record<string, unknown>;
}

export interface ProposalMockTrackers {
  approvePosts: Array<{ id: string; at: string }>;
  getDetailHits: number;
}

export function createEstimateProposalState(): ProposalMockState {
  return {
    id: ESTIMATE_PROPOSAL_ID,
    status: 'ready_for_review',
    summary: 'Replace water heater — 50 gallon electric',
    proposalType: ProposalType.DRAFT_ESTIMATE,
    payload: {
      _meta: { overallConfidence: 'medium' },
      lineItems: [
        {
          id: 'li-1',
          description: '50 gallon electric water heater',
          quantity: 1,
          unitPriceCents: 89_900,
          totalCents: 89_900,
          pricingSource: 'catalog',
        },
        {
          id: 'li-2',
          description: 'Labor — install',
          quantity: 2,
          unitPriceCents: 12_500,
          totalCents: 25_000,
          pricingSource: 'catalog',
        },
      ],
      jobId: '33333333-3333-4333-8333-333333333301',
    },
  };
}

function toProposalResponse(state: ProposalMockState) {
  const now = new Date().toISOString();
  return proposalResponseSchema.parse({
    id: state.id,
    tenantId: E2E_TENANT_ID,
    proposalType: state.proposalType,
    status: state.status,
    summary: state.summary,
    explanation: 'AI-drafted from voice note; prices grounded in catalog.',
    confidenceScore: 0.72,
    payload: state.payload,
    resultEntityId: state.resultEntityId,
    // The approval stamp must ride the response, exactly as the real route
    // does (`res.json({ ...result, … })` spreads the domain proposal, which
    // carries `approvedAt`). This mock previously stamped `state.approvedAt`
    // and then dropped it here, so the approve response carried NO server
    // timing at all — the undo toast only appeared because the client hook
    // invented a fresh 5s window when none rode. Removing that invented
    // fallback (review J3) exposed the gap: the spec asserted an affordance
    // the mocked contract never justified.
    approvedAt: state.approvedAt,
    createdBy: 'ai',
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Mirrors the undo window both real implementations use — the API's
 * `UNDO_WINDOW_MS` (packages/api/src/proposals/lifecycle.ts) and the web
 * hook's (packages/web/src/hooks/useUndoableApproval.ts). Duplicated here
 * rather than imported because neither is exported through
 * `@ai-service-os/shared`, which is the only package this root-level e2e
 * helper resolves; the exact value does not matter to the assertions (they
 * check that a window RODE, not its length), only that one is present.
 */
const UNDO_WINDOW_MS = 5000;

/**
 * The approve response as the REAL route builds it — the proposal plus the
 * two additive undo-window fields (`routes/proposals.ts`, "Finding 2"/N11).
 * `undoRemainingMs` is deliberately outside `proposalResponseSchema`: the
 * server adds it to the JSON body only, never to the stored proposal.
 */
function toApproveResponse(state: ProposalMockState) {
  const proposal = toProposalResponse(state);
  if (!state.approvedAt) return proposal;
  const approvedMs = Date.parse(state.approvedAt);
  return {
    ...proposal,
    undoExpiresAt: new Date(approvedMs + UNDO_WINDOW_MS).toISOString(),
    undoRemainingMs: Math.max(0, approvedMs + UNDO_WINDOW_MS - Date.now()),
  };
}

function inboxEnvelope(state: ProposalMockState) {
  // Inbox only lists ready_for_review; approved/executed drop out.
  if (state.status !== 'ready_for_review') {
    return {
      data: [],
      summary: {
        totalCount: 0,
        criticalCount: 0,
        highCount: 0,
        normalCount: 0,
        lowCount: 0,
        truncated: false,
      },
      expired: [],
      failed: [],
    };
  }
  return {
    data: [
      {
        proposal: {
          id: state.id,
          proposalType: state.proposalType,
          summary: state.summary,
          status: state.status,
          createdAt: new Date().toISOString(),
          confidenceScore: 0.72,
          payload: state.payload,
        },
        urgency: 'normal' as const,
        reason: 'Awaiting review',
      },
    ],
    summary: {
      totalCount: 1,
      criticalCount: 0,
      highCount: 0,
      normalCount: 1,
      lowCount: 0,
      truncated: false,
    },
    expired: [],
    failed: [],
  };
}

/**
 * Simulate the execution worker claiming the approved proposal after the
 * undo window. Sets status=executed and stamps resultEntityId.
 */
export function advanceExecution(state: ProposalMockState): void {
  if (state.status !== 'approved') {
    throw new Error(`advanceExecution requires status=approved, got ${state.status}`);
  }
  state.status = 'executed';
  state.resultEntityId = RESULT_ESTIMATE_ID;
}

export async function installProposalMocks(
  page: Page,
  state: ProposalMockState,
  trackers: ProposalMockTrackers,
  trackMutation?: (method: string, path: string, body: unknown) => void,
): Promise<void> {
  // Inbox — preferred surface for W1-1.
  await page.route('**/api/proposals/inbox', async (route: Route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(inboxEnvelope(state)),
    });
  });

  // Pending badge poller — keep in sync with inbox state.
  await page.route(/\/api\/proposals(\?|$)/, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    // Let /inbox and /:id/approve etc. fall through to more specific handlers
    // when this regex also matches — but Playwright matches exact registered
    // routes; /inbox is a separate registration. This catches list GETs.
    if (url.pathname !== '/api/proposals') {
      await route.fallback();
      return;
    }
    if (req.method() !== 'GET') {
      await route.fallback();
      return;
    }
    const ready =
      state.status === 'ready_for_review'
        ? [toProposalResponse(state)]
        : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: ready, total: ready.length }),
    });
  });

  // Detail GET — journey asserts status=executed here.
  await page.route(`**/api/proposals/${state.id}`, async (route: Route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    trackers.getDetailHits += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(toProposalResponse(state)),
    });
  });

  await page.route(`**/api/proposals/${state.id}/approve`, async (route: Route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    trackMutation?.('POST', `/api/proposals/${state.id}/approve`, null);
    trackers.approvePosts.push({ id: state.id, at: new Date().toISOString() });
    state.status = 'approved';
    state.approvedAt = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // UNWRAPPED, matching the real route: the single-proposal mutations in
      // `routes/proposals.ts` all `res.json(result)` — only the LIST endpoints
      // carry a `{ data, total }` envelope. `InboxPage.approveOrReject` reads
      // `undoExpiresAt`/`undoRemainingMs` off the TOP level of this body, so a
      // `{ data: … }` wrapper hides them one level down.
      body: JSON.stringify(toApproveResponse(state)),
    });
  });

  await page.route(`**/api/proposals/${state.id}/reject`, async (route: Route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    trackMutation?.('POST', `/api/proposals/${state.id}/reject`, null);
    state.status = 'rejected';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // Unwrapped, as the real route returns it (see the approve mock).
      body: JSON.stringify(toProposalResponse(state)),
    });
  });

  await page.route(`**/api/proposals/${state.id}/undo`, async (route: Route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    trackMutation?.('POST', `/api/proposals/${state.id}/undo`, null);
    state.status = 'ready_for_review';
    state.approvedAt = undefined;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // Unwrapped, as the real route returns it (see the approve mock).
      body: JSON.stringify(toProposalResponse(state)),
    });
  });

  // Estimates list — after execution the journey may navigate here.
  await page.route(/\/api\/estimates(\?|$)/, async (route: Route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/estimates') {
      await route.fallback();
      return;
    }
    const now = new Date().toISOString();
    const data =
      state.status === 'executed'
        ? [
            estimateResponseSchema.parse({
              id: RESULT_ESTIMATE_ID,
              tenantId: E2E_TENANT_ID,
              jobId: '33333333-3333-4333-8333-333333333301',
              estimateNumber: 'EST-9001',
              status: 'sent',
              lineItems: [
                {
                  id: 'eli-1',
                  description: '50 gallon electric water heater',
                  category: 'material',
                  quantity: 1,
                  unitPriceCents: 89_900,
                  totalCents: 89_900,
                  sortOrder: 0,
                  taxable: true,
                  pricingSource: 'catalog',
                },
              ],
              totals: {
                subtotalCents: 114_900,
                discountCents: 0,
                taxRateBps: 0,
                taxableSubtotalCents: 114_900,
                taxCents: 0,
                totalCents: 114_900,
              },
              version: 1,
              createdBy: 'ai',
              createdAt: now,
              updatedAt: now,
              customer: {
                id: '44444444-4444-4444-8444-444444444401',
                displayName: 'Dana Diaz',
                firstName: 'Dana',
                lastName: 'Diaz',
              },
            }),
          ]
        : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data, total: data.length }),
    });
  });
}
