/**
 * Baseline shell API mocks for hermetic offline Playwright specs.
 *
 * Serves the minimum `/api/*` surface the authenticated Shell needs to boot
 * without pageerrors: /api/me (owner without ai:run — skips voice WS poller),
 * /api/onboarding/status (complete), /api/settings, empty list envelopes for
 * pollers, and a catch-all recorder for anything else.
 *
 * Domain mocks (proposals, jobs, …) register AFTER these so last-wins.
 */

import type { Page, Route } from '@playwright/test';
import type { MeResponse } from '@ai-service-os/shared';

export const E2E_TENANT_ID = '00000000-0000-4000-8000-0000000000e2';
export const E2E_USER_ID = '00000000-0000-4000-8000-0000000000u1';

/** Owner persona WITHOUT `ai:run` — keeps /api/ws + voice session poller off. */
export function buildMeResponse(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: 'user_e2e_stub',
    internal_user_id: E2E_USER_ID,
    tenant_id: E2E_TENANT_ID,
    role: 'owner',
    can_field_serve: true,
    current_mode: 'supervisor',
    mode_changed_at: null,
    // Deliberately omit ai:run — see useActiveSessions.ts permission gate.
    permissions: [
      'proposals:view',
      'proposals:approve',
      'proposals:edit',
      'jobs:view',
      'estimates:view',
      'estimates:create',
      'invoices:view',
      'customers:view',
      'settings:view',
      'conversations:view',
    ],
    backup_supervisor_user_id: null,
    timezone: 'America/New_York',
    unsupervised_proposal_routing: 'queue_and_sms',
    ...overrides,
  };
}

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
    tenantId: E2E_TENANT_ID,
    subscriptionStatus: null,
    // Established account — WelcomeWalkthrough stays hidden (not "new").
    accountCreatedAt: '2020-01-01T00:00:00.000Z',
  };
}

export function buildSettingsMinimal() {
  return {
    terminologyPreferences: {
      workerTerm: 'Technician',
      estimateTerm: 'Estimate',
    },
  };
}

export const isApiUrl = (url: URL): boolean => url.pathname.startsWith('/api/');

const LIST_PATHS = new Set([
  '/api/jobs',
  '/api/estimates',
  '/api/invoices',
  '/api/customers',
  '/api/leads',
  '/api/appointments',
]);

export interface UnmockedApiCall {
  method: string;
  path: string;
}

/**
 * Abort every request that leaves the app origin (analytics, fonts, CDNs).
 * Keeps page.goto deterministic under sandboxed/proxied runners.
 */
export async function blockExternalHosts(page: Page, baseURL: string): Promise<void> {
  const appOrigin = new URL(baseURL).origin;
  await page.route(
    (url) => url.origin !== appOrigin,
    (route) => route.abort(),
  );
}

/**
 * Catch-all `/api/*` → 200 with a safe empty body, recording unmocked hits.
 * Register FIRST; more-specific handlers registered later win.
 */
export async function installApiCatchAll(
  page: Page,
  unmocked: UnmockedApiCall[],
): Promise<void> {
  await page.route(isApiUrl, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    unmocked.push({ method: req.method(), path: url.pathname });

    const path = url.pathname;
    let body: unknown = {};
    if (LIST_PATHS.has(path) || path === '/api/proposals') {
      body = { data: [], total: 0 };
    } else if (path === '/api/escalations/events') {
      body = '';
    } else if (path === '/api/voice/sessions/active') {
      body = { sessions: [] };
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  });
}

/** Baseline Shell mocks — register AFTER the catch-all. */
export async function installShellMocks(page: Page): Promise<void> {
  await page.route('**/api/me', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildMeResponse()),
    });
  });

  await page.route('**/api/onboarding/status', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildOnboardingComplete()),
    });
  });

  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildSettingsMinimal()),
    });
  });

  // Pending-proposal badge poller (Shell) — empty until domain mocks override.
  await page.route('**/api/proposals?**', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [], total: 0 }),
    });
  });
}
