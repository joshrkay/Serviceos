import type { Page } from '@playwright/test';

/** Mirrors packages/web/src/types/onboarding.ts step ids. */
type OnboardingStepId =
  | 'signup'
  | 'identity'
  | 'pack'
  | 'phone'
  | 'billing'
  | 'test_call';

type OnboardingStepStatus = 'done' | 'current' | 'pending';

export interface OnboardingMockState {
  identityDone: boolean;
  packId: 'hvac' | 'plumbing' | null;
}

export interface OnboardingMockTrackers {
  identityPut: boolean;
  packPost: { packId: string } | null;
}

export function createOnboardingMockState(): OnboardingMockState {
  return { identityDone: false, packId: null };
}

function buildStatus(state: OnboardingMockState) {
  const order: OnboardingStepId[] = [
    'signup',
    'identity',
    'pack',
    'phone',
    'billing',
    'test_call',
  ];
  const done: Record<OnboardingStepId, boolean> = {
    signup: true,
    identity: state.identityDone,
    pack: state.packId !== null,
    phone: false,
    billing: false,
    test_call: false,
  };
  const firstNotDone = order.find((id) => !done[id]) ?? null;
  const steps = order.map((id) => {
    if (done[id]) return { id, status: 'done' as OnboardingStepStatus };
    if (id === firstNotDone) return { id, status: 'current' as OnboardingStepStatus };
    return { id, status: 'pending' as OnboardingStepStatus };
  });
  return {
    steps,
    currentStep: firstNotDone,
    isComplete: firstNotDone === null,
  };
}

/**
 * Intercepts onboarding API calls with derived status snapshots (same shape as
 * GET /api/onboarding/status). Use when the journey DB lacks migration 098 or
 * you need deterministic step transitions without seeding tenant_settings.
 */
export async function installOnboardingV2ApiMocks(
  page: Page,
  state: OnboardingMockState,
  trackers?: OnboardingMockTrackers,
): Promise<void> {
  await page.route('**/api/onboarding/status', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildStatus(state)),
    });
  });

  await page.route('**/api/onboarding/identity', async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.continue();
      return;
    }
    state.identityDone = true;
    if (trackers) trackers.identityPut = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route('**/api/onboarding/pack', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const body = route.request().postDataJSON() as { packId?: string };
    const packId = body.packId === 'plumbing' ? 'plumbing' : 'hvac';
    state.packId = packId;
    if (trackers) trackers.packPost = { packId };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ packId }),
    });
  });
}

/** Clerk testing-token signup through to /onboarding (v2 shell). */
export async function signUpAndReachOnboarding(
  page: Page,
  emailLocalPart: string,
): Promise<void> {
  await page.goto('/signup');
  const testEmail = `e2e+clerk_test+${emailLocalPart}+${Date.now()}@serviceos-test.com`;
  const emailInput = page.getByLabel(/email/i).first();
  await emailInput.waitFor({ state: 'visible', timeout: 15_000 });
  await emailInput.fill(testEmail);
  await page.getByLabel(/password/i).first().fill('Test1234!Test1234!');
  await page.getByRole('button', { name: /(continue|sign up)/i }).first().click();
  await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
}
