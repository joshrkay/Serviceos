/**
 * Baseline shell mocks — the API surface the authed app shell touches on
 * EVERY page, mocked so the app boots quietly with zero backend.
 *
 * What fires on any authed route (see the offline-app fixture header for the
 * full harness picture):
 *   - GET /api/me                      useMe (Shell) + AnalyticsIdentityBridge
 *                                      + TenantTimezoneProvider
 *   - GET /api/onboarding/status      ProtectedRoute → OnboardingGuard (30s poll)
 *   - GET /api/proposals?status=…     Shell badge poller (30s)
 *   - GET /api/settings               useWorkerTerm / useEstimateTerm
 *   - GET /api/escalations/events     EscalationPanelHost SSE (always mounted)
 *
 * Persona note: the MeResponse deliberately OMITS the `ai:run` permission.
 * The /api/ws WebSocket and the 10s /api/voice/sessions/active poller only
 * start when me.permissions includes 'ai:run'
 * (packages/web/src/hooks/useActiveSessions.ts) — omitting it keeps the
 * offline harness free of WebSocket traffic Playwright's page.route cannot
 * intercept. Nav visibility needs estimates:view / invoices:view /
 * settings:view (Shell.tsx `requires` tags), which the persona includes.
 */

import type { Page, Route } from '@playwright/test';
import type { MeResponse } from '@ai-service-os/shared';

export const OFFLINE_TENANT_ID = '00000000-0000-0000-0000-0000000000e2';
export const OFFLINE_USER_ID = 'user_e2e_stub';
export const OFFLINE_INTERNAL_USER_ID = '00000000-0000-0000-0000-0000000000a1';

/**
 * Signed-in persona for offline specs. Owner-shaped, minus `ai:run` (see
 * header). Permission strings mirror packages/api/src/auth/rbac.ts.
 */
export function buildMeResponse(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: OFFLINE_USER_ID,
    internal_user_id: OFFLINE_INTERNAL_USER_ID,
    tenant_id: OFFLINE_TENANT_ID,
    role: 'owner',
    can_field_serve: false,
    current_mode: 'supervisor',
    mode_changed_at: null,
    permissions: [
      'jobs:create',
      'jobs:assign',
      'jobs:view',
      'jobs:update',
      'estimates:view',
      'estimates:create',
      'estimates:update',
      'invoices:view',
      'invoices:create',
      'invoices:update',
      'settings:view',
      // 'ai:run' deliberately absent — see file header.
    ],
    backup_supervisor_user_id: null,
    timezone: 'America/New_York',
    unsupervised_proposal_routing: 'queue_only',
    ...overrides,
  };
}

/** §10 onboarding — fully complete, so OnboardingGuard never redirects. */
export function buildOnboardingComplete() {
  return {
    steps: [
      { id: 'signup', status: 'done' },
      { id: 'identity', status: 'done' },
      { id: 'pack', status: 'done' },
      { id: 'phone', status: 'done' },
      { id: 'billing', status: 'done' },
      { id: 'test_call', status: 'done' },
    ],
    currentStep: null,
    isComplete: true,
    tenantId: OFFLINE_TENANT_ID,
    subscriptionStatus: null,
  };
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/**
 * Install the baseline mocks. Registered AFTER the catch-all recorder (route
 * matching is last-registered-wins), so these win for their paths and
 * everything else lands in the recorder. Non-GET methods fall back to the
 * catch-all rather than hitting the network.
 */
export async function installShellMocks(
  page: Page,
  opts: { me?: MeResponse } = {},
): Promise<void> {
  const me = opts.me ?? buildMeResponse();

  await page.route(
    (url) => url.pathname === '/api/me',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await json(route, me);
    },
  );

  await page.route(
    (url) => url.pathname === '/api/onboarding/status',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await json(route, buildOnboardingComplete());
    },
  );

  await page.route(
    (url) => url.pathname === '/api/proposals',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await json(route, { data: [], total: 0 });
    },
  );

  await page.route(
    (url) => url.pathname === '/api/settings',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await json(route, { terminologyPreferences: {} });
    },
  );

  // Escalations SSE — always mounted (no permission gate). An empty
  // text/event-stream body ends the stream cleanly; useEscalationStream
  // reconnects on a growing backoff, which the idempotent handler absorbs.
  await page.route(
    (url) => url.pathname === '/api/escalations/events',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: '',
      });
    },
  );
}
