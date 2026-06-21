/**
 * Signed-in session + API mocks for the Expo mobile web export (ui-flow capture).
 */
import { expect, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { UI_FLOW_FIXTURE } from '../fixtures/ui-flow-ids';
import { setupClerkTestingToken, hasClerkTestingCreds } from './clerk-testing';
import {
  clerkTestUserEmail,
  clerkTestUserPassword,
  hasClerkUserPassword,
  installAuthedShellMocks,
} from './clerk-session';

const OWNER_CREDS_FILE = 'e2e/fixtures/.auth/owner-creds.json';

function resolveMobileCredentials(): { email: string; password: string } {
  if (hasClerkUserPassword()) {
    return { email: clerkTestUserEmail(), password: clerkTestUserPassword() };
  }
  if (existsSync(OWNER_CREDS_FILE)) {
    const parsed = JSON.parse(readFileSync(OWNER_CREDS_FILE, 'utf8')) as {
      email?: string;
      password?: string;
    };
    if (parsed.email && parsed.password) {
      return { email: parsed.email, password: parsed.password };
    }
  }
  return { email: clerkTestUserEmail(), password: clerkTestUserPassword() };
}

export async function installMobileDetailMocks(page: Page): Promise<void> {
  const { proposalId, customerId, threadId } = UI_FLOW_FIXTURE;

  await page.route('**/api/proposals/inbox**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: proposalId,
          proposalType: 'create_appointment',
          status: 'ready_for_review',
          summary: 'Book HVAC service for Dana Rivera',
          confidenceScore: 0.92,
        },
      ]),
    });
  });

  await page.route(`**/api/proposals/${proposalId}**`, async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: proposalId,
          proposalType: 'create_appointment',
          status: 'ready_for_review',
          summary: 'Book HVAC service for Dana Rivera',
          explanation: 'Customer asked to schedule a tune-up next Tuesday.',
          confidenceScore: 0.92,
          payload: { customerName: 'Dana Rivera', scheduledStart: '2026-06-24T14:00:00.000Z' },
          approvedAt: null,
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.route('**/api/customers**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = route.request().url();
    if (url.includes(customerId)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: customerId,
          firstName: 'Dana',
          lastName: 'Rivera',
          primaryPhone: '+15555550144',
          email: 'dana@example.com',
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: customerId, firstName: 'Dana', lastName: 'Rivera', primaryPhone: '+15555550144' },
      ]),
    });
  });

  await page.route(`**/api/conversations/${threadId}/messages**`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'msg-1',
          body: 'Can you come Tuesday afternoon?',
          senderRole: 'customer',
          createdAt: '2026-06-20T18:00:00.000Z',
          metadata: { direction: 'inbound' },
        },
        {
          id: 'msg-2',
          body: 'Absolutely — I will send a confirmation shortly.',
          senderRole: 'owner',
          createdAt: '2026-06-20T18:05:00.000Z',
          metadata: { direction: 'outbound' },
        },
      ]),
    });
  });
}

/** Sign in on the Expo web export (placeholder inputs + Sign in button). */
export async function signInMobileOwner(page: Page, mobileBaseUrl: string): Promise<void> {
  if (hasClerkTestingCreds()) {
    await setupClerkTestingToken(page);
  }
  await installAuthedShellMocks(page);
  await installMobileDetailMocks(page);
  await page.goto(`${mobileBaseUrl}/sign-in`);
  await expect(page.getByText('Sign in').first()).toBeVisible({ timeout: 15_000 });

  const { email, password } = resolveMobileCredentials();

  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Fresh +clerk_test users may need email code on mobile too.
  const codeInput = page.getByPlaceholder(/code/i);
  if (await codeInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await codeInput.fill('424242');
    await page.getByRole('button', { name: /continue|verify/i }).click();
  }

  await page.waitForURL(new RegExp(`${mobileBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`), {
    timeout: 30_000,
  });

  if (!hasClerkUserPassword()) {
    // Sign-up path on mobile when no fixed user — first attempt may fail; retry signup flow
    // is out of scope for capture — operator should set E2E_CLERK_USER_* for mobile authed capture.
  }
}
