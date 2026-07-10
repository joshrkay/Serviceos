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
    createdBy: 'ai',
    createdAt: now,
    updatedAt: now,
  });
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
      body: JSON.stringify({ data: toProposalResponse(state) }),
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
      body: JSON.stringify({ data: toProposalResponse(state) }),
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
      body: JSON.stringify({ data: toProposalResponse(state) }),
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
