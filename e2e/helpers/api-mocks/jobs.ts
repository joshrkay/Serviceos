/**
 * Jobs domain mocks — stateful page.route handlers + schema-validated
 * fixtures for the /jobs list + detail flow.
 *
 * Honesty mechanism (see the offline-authed-e2e plan): every fixture is
 * built through `jobListItemSchema.parse` / `jobDetailResponseSchema.parse`
 * from @ai-service-os/shared — the SAME Zod contracts the product ships —
 * so a drifted contract fails fixture-build in Node with a named field
 * before the browser ever sees a stale shape.
 *
 * Handlers are stateful (the onboarding-v2-mock pattern): a transition
 * mutates `state`, so the UI's post-mutation refetch renders the new
 * status from the mock rather than a canned response. All GET handlers are
 * idempotent — StrictMode and pollers may refire them at any time.
 */

import type { Page, Route } from '@playwright/test';
import {
  jobListItemSchema,
  jobDetailResponseSchema,
  type JobListItem,
  type JobDetailResponse,
} from '@ai-service-os/shared';
import { OFFLINE_TENANT_ID } from './shell';
import type { ApiTrackerEntry } from '../offline-app';

export const JOB_A_ID = '11111111-1111-4111-8111-111111111111';
export const JOB_B_ID = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '33333333-3333-4333-8333-333333333333';
const LOCATION_ID = '44444444-4444-4444-8444-444444444444';

export interface JobsMockState {
  jobs: JobDetailResponse[];
}

export function buildJob(overrides: Partial<JobDetailResponse> = {}): JobDetailResponse {
  return jobDetailResponseSchema.parse({
    id: JOB_A_ID,
    tenantId: OFFLINE_TENANT_ID,
    customerId: CUSTOMER_ID,
    locationId: LOCATION_ID,
    jobNumber: '1042',
    summary: 'AC not cooling — upstairs unit',
    status: 'new',
    priority: 'normal',
    createdBy: 'user_e2e_stub',
    createdAt: '2026-07-01T14:00:00.000Z',
    updatedAt: '2026-07-01T14:00:00.000Z',
    customer: {
      id: CUSTOMER_ID,
      displayName: 'Nora Winters',
      primaryPhone: '+15550100042',
      email: 'nora@example.com',
    },
    location: {
      id: LOCATION_ID,
      street1: '12 Birch Lane',
      city: 'Riverton',
      state: 'NJ',
      postalCode: '08077',
    },
    ...overrides,
  });
}

export function createJobsMockState(): JobsMockState {
  return {
    jobs: [
      buildJob(),
      buildJob({
        id: JOB_B_ID,
        jobNumber: '1043',
        summary: 'Water heater pilot light out',
        status: 'scheduled',
        customer: { id: CUSTOMER_ID, displayName: 'Miguel Ortega' },
      }),
    ],
  };
}

/** List item = detail entity minus nothing the list needs; re-parse to pin the list contract too. */
const asListItem = (job: JobDetailResponse): JobListItem => jobListItemSchema.parse(job);

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const DETAIL_RE = /^\/api\/jobs\/([^/]+)$/;
const TRANSITION_RE = /^\/api\/jobs\/([^/]+)\/transition$/;

export async function installJobsMocks(
  page: Page,
  state: JobsMockState,
  tracker: ApiTrackerEntry[],
): Promise<void> {
  // List — implements the server-side status filter so tab switching
  // renders honestly filtered data.
  await page.route(
    (url) => url.pathname === '/api/jobs',
    async (route) => {
      const req = route.request();
      if (req.method() !== 'GET') return route.fallback();
      const url = new URL(req.url());
      const query = Object.fromEntries(url.searchParams.entries());
      tracker.push({ method: 'GET', path: '/api/jobs', query });
      const status = url.searchParams.get('status');
      const rows = state.jobs.filter((j) => !status || j.status === status).map(asListItem);
      await json(route, { data: rows, total: rows.length });
    },
  );

  // Detail — exact-id match only (photos/transition have their own routes).
  await page.route(
    (url) => DETAIL_RE.test(url.pathname),
    async (route) => {
      const req = route.request();
      if (req.method() !== 'GET') return route.fallback();
      const id = new URL(req.url()).pathname.match(DETAIL_RE)![1];
      const job = state.jobs.find((j) => j.id === id);
      if (!job) return json(route, { error: 'not found' }, 404);
      await json(route, job);
    },
  );

  // Status transition — the flow's key mutation. Records the exact body,
  // mutates state so the UI's refetch sees the new status.
  await page.route(
    (url) => TRANSITION_RE.test(url.pathname),
    async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      const path = new URL(req.url()).pathname;
      const id = path.match(TRANSITION_RE)![1];
      const body = req.postDataJSON() as { status?: string };
      tracker.push({ method: 'POST', path, body });
      const job = state.jobs.find((j) => j.id === id);
      if (!job) return json(route, { error: 'not found' }, 404);
      job.status = jobDetailResponseSchema.shape.status.parse(body.status);
      job.updatedAt = '2026-07-01T15:00:00.000Z';
      await json(route, job);
    },
  );

  // Detail-page satellites. Arrays, not `{}` — JobDetail maps over notes
  // and photos; time entries are Array.isArray-guarded but honest anyway.
  await page.route(
    (url) => url.pathname === '/api/time-entries' || url.pathname === '/api/notes',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await json(route, []);
    },
  );
  await page.route(
    (url) => /^\/api\/jobs\/[^/]+\/photos$/.test(url.pathname),
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await json(route, []);
    },
  );
}
