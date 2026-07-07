/**
 * Estimates domain mocks — schema-validated fixtures + stateful handlers for
 * the /estimates list + detail flow. Same honesty mechanism as jobs.ts: every
 * fixture parses under @ai-service-os/shared's `estimateResponseSchema`, and
 * the send mutation validates the intercepted body against the server's send
 * schema shape, so contract drift on either side fails the test.
 */

import { z } from 'zod';
import type { Page, Route } from '@playwright/test';
import {
  estimateResponseSchema,
  type EstimateResponse,
} from '@ai-service-os/shared';
import { OFFLINE_TENANT_ID } from './shell';
import type { ApiTrackerEntry } from '../offline-app';

export const ESTIMATE_A_ID = 'aaaaaaa1-1111-4111-8111-111111111111';
export const ESTIMATE_B_ID = 'bbbbbbb2-2222-4222-8222-222222222222';
const JOB_ID = 'ccccccc3-3333-4333-8333-333333333333';
const CUSTOMER_ID = 'ddddddd4-4444-4444-8444-444444444444';

/** Mirror of the server's estimate-send body schema (packages/api/src/routes/estimates.ts). */
const sendBodySchema = z.object({
  channel: z.enum(['sms', 'email', 'both']).default('sms'),
  recipientPhone: z.string().optional(),
  recipientEmail: z.string().optional(),
  customMessage: z.string().optional(),
});

export interface EstimatesMockState {
  estimates: EstimateResponse[];
}

function totals(subtotalCents: number) {
  return {
    subtotalCents,
    discountCents: 0,
    taxRateBps: 0,
    taxableSubtotalCents: subtotalCents,
    taxCents: 0,
    totalCents: subtotalCents,
  };
}

export function buildEstimate(overrides: Partial<EstimateResponse> = {}): EstimateResponse {
  return estimateResponseSchema.parse({
    id: ESTIMATE_A_ID,
    tenantId: OFFLINE_TENANT_ID,
    jobId: JOB_ID,
    estimateNumber: 'EST-2042',
    status: 'draft',
    lineItems: [
      {
        id: 'li-1',
        description: 'Condenser coil replacement',
        quantity: 1,
        unitPriceCents: 125000,
        totalCents: 125000,
        sortOrder: 0,
        taxable: true,
      },
    ],
    totals: totals(125000),
    version: 1,
    createdBy: 'user_e2e_stub',
    createdAt: '2026-07-01T14:00:00.000Z',
    updatedAt: '2026-07-01T14:00:00.000Z',
    customer: { id: CUSTOMER_ID, displayName: 'Priya Shah', primaryPhone: '+15550100200' },
    ...overrides,
  });
}

export function createEstimatesMockState(): EstimatesMockState {
  return {
    estimates: [
      buildEstimate(),
      buildEstimate({
        id: ESTIMATE_B_ID,
        estimateNumber: 'EST-2043',
        status: 'accepted',
        totals: totals(48000),
        lineItems: [
          {
            id: 'li-2',
            description: 'Thermostat install',
            quantity: 1,
            unitPriceCents: 48000,
            totalCents: 48000,
            sortOrder: 0,
            taxable: true,
          },
        ],
        customer: { id: CUSTOMER_ID, displayName: 'Dan Cole' },
      }),
    ],
  };
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const DETAIL_RE = /^\/api\/estimates\/([^/]+)$/;
const SEND_RE = /^\/api\/estimates\/([^/]+)\/send$/;
const HISTORY_RE = /^\/api\/estimates\/([^/]+)\/history$/;

export async function installEstimatesMocks(
  page: Page,
  state: EstimatesMockState,
  tracker: ApiTrackerEntry[],
): Promise<void> {
  // List with server-side status filter.
  await page.route(
    (url) => url.pathname === '/api/estimates',
    async (route) => {
      const req = route.request();
      if (req.method() !== 'GET') return route.fallback();
      const url = new URL(req.url());
      const query = Object.fromEntries(url.searchParams.entries());
      tracker.push({ method: 'GET', path: '/api/estimates', query });
      const status = url.searchParams.get('status');
      const rows = state.estimates.filter((e) => !status || e.status === status);
      await json(route, { data: rows, total: rows.length });
    },
  );

  // History (best-effort; detail hides the card on []).
  await page.route(
    (url) => HISTORY_RE.test(url.pathname),
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await json(route, []);
    },
  );

  // Send — the flow's key mutation. Validate the body against the server's
  // schema so a client/server contract drift fails here.
  await page.route(
    (url) => SEND_RE.test(url.pathname),
    async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      const path = new URL(req.url()).pathname;
      const id = path.match(SEND_RE)![1];
      const body = sendBodySchema.parse(req.postDataJSON());
      tracker.push({ method: 'POST', path, body });
      const est = state.estimates.find((e) => e.id === id);
      if (est) est.status = 'sent';
      await json(route, {
        viewUrl: `https://rivet.example/e/token-${id}`,
        viewToken: `token-${id}`,
      });
    },
  );

  // Line-item update — capture the optimistic-lock header + bump version.
  await page.route(
    (url) => DETAIL_RE.test(url.pathname),
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const id = path.match(DETAIL_RE)![1];
      if (req.method() === 'PUT') {
        tracker.push({
          method: 'PUT',
          path,
          body: req.postDataJSON(),
          query: { ifMatch: req.headers()['if-match'] ?? '' },
        });
        const est = state.estimates.find((e) => e.id === id);
        if (!est) return json(route, { error: 'not found' }, 404);
        est.version += 1;
        return json(route, est);
      }
      if (req.method() !== 'GET') return route.fallback();
      const est = state.estimates.find((e) => e.id === id);
      if (!est) return json(route, { error: 'not found' }, 404);
      await json(route, est);
    },
  );

  // Detail satellites — notes list, and the job-enrichment fetch (best-effort;
  // detail tolerates an empty/absent body). Mocked so unmockedApiCalls stays
  // clean.
  await page.route(
    (url) => url.pathname === '/api/notes',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await json(route, []);
    },
  );
  await page.route(
    (url) => /^\/api\/jobs\/[^/]+$/.test(url.pathname),
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await json(route, {});
    },
  );
}
