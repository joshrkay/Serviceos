import { test, expect } from '@playwright/test';
import { setupClerkTestingToken, hasClerkTestingCreds } from '../helpers/clerk-testing';
import {
  createOnboardingMockState,
  installOnboardingV2ApiMocks,
  signUpAndReachOnboarding,
  createOnboardingConversationMockState,
  installOnboardingConversationApiMocks,
  ONBOARDING_CONVERSATION_USER_MESSAGES,
  ONBOARDING_CONVERSATION_OPENING_PROMPT,
} from '../helpers/onboarding-v2-mock';

/**
 * Journey — B1.19 conversational onboarding ("talk it through").
 *
 * Covers:
 *   - AC-2: mid-conversation page refresh resumes the SAME session with
 *     transcript history intact (session id is client-managed and
 *     persisted client-side — see useOnboardingConversation.ts).
 *   - AC-8: a fresh-signup → "CRM unlocked" run, 10-15 exchanges,
 *     text-injected transcripts (mocked gateway via
 *     installOnboardingConversationApiMocks — no real mic required in CI),
 *     covering all six capture states with at least one clarification.
 *
 * Requires Clerk testing-token creds (see helpers/clerk-testing.ts) — the
 * signup itself is real Clerk, only the onboarding-conversation and
 * onboarding-status endpoints are mocked (same pattern as
 * onboarding-v2.spec.ts's identity/pack mocks).
 */

test.describe('Journey — B1.19 conversational onboarding', () => {
  test.skip(
    !hasClerkTestingCreds(),
    'Clerk testing-token creds not set. See e2e/helpers/clerk-testing.ts.',
  );
  test.skip(
    process.env.VITE_ONBOARDING_V2_ENABLED !== 'true',
    'VITE_ONBOARDING_V2_ENABLED=true required.',
  );

  test('AC-2 resumability: reloading mid-conversation keeps the same session and transcript', async ({
    page,
  }) => {
    await setupClerkTestingToken(page);
    const status = createOnboardingMockState();
    await installOnboardingV2ApiMocks(page, status);
    const conv = createOnboardingConversationMockState();
    await installOnboardingConversationApiMocks(page, conv);

    await signUpAndReachOnboarding(page, 'v2conv-resume');

    await page.getByRole('button', { name: /talk it through instead/i }).click();
    await expect(page.getByText(ONBOARDING_CONVERSATION_OPENING_PROMPT)).toBeVisible();

    // First exchange.
    await page.getByLabel('Your answer').fill(ONBOARDING_CONVERSATION_USER_MESSAGES[0]);
    await page.getByRole('button', { name: /^send$/i }).click();
    await expect(page.getByText(ONBOARDING_CONVERSATION_USER_MESSAGES[0])).toBeVisible();
    await expect(page.getByText('Got it. What kinds of services do you offer?')).toBeVisible();

    // Second exchange, so there's more than one turn of history to lose.
    await page.getByLabel('Your answer').fill(ONBOARDING_CONVERSATION_USER_MESSAGES[1]);
    await page.getByRole('button', { name: /^send$/i }).click();
    await expect(
      page.getByText('Do you also handle emergency or after-hours calls?'),
    ).toBeVisible();

    // Reload — the shell remounts from scratch. The session id and
    // transcript are persisted client-side (localStorage), and the
    // shell itself remembers it was in conversation mode, so the panel
    // reopens with the SAME session and full history intact rather than
    // dropping the user back into the empty form.
    await page.reload();

    await expect(page.getByText(ONBOARDING_CONVERSATION_OPENING_PROMPT)).toBeVisible();
    await expect(page.getByText(ONBOARDING_CONVERSATION_USER_MESSAGES[0])).toBeVisible();
    await expect(page.getByText('Got it. What kinds of services do you offer?')).toBeVisible();
    await expect(page.getByText(ONBOARDING_CONVERSATION_USER_MESSAGES[1])).toBeVisible();
    await expect(
      page.getByText('Do you also handle emergency or after-hours calls?'),
    ).toBeVisible();

    // The conversation continues from where it left off — the resumed
    // session doesn't reset to profile_capture (a duplicate opening
    // prompt would prove the resume silently started a NEW session).
    expect(await page.getByText(ONBOARDING_CONVERSATION_OPENING_PROMPT).count()).toBe(1);
  });

  test('AC-8: 10-15 exchange scripted conversation reaches completion and opens the B1.20 soft-gate', async ({
    page,
  }) => {
    await setupClerkTestingToken(page);
    const status = createOnboardingMockState();
    await installOnboardingV2ApiMocks(page, status);
    const conv = createOnboardingConversationMockState();
    const sentUserMessages: string[] = [];
    await installOnboardingConversationApiMocks(page, conv, {
      sentUserMessages,
      // The conversation FSM completing is what the identity extraction
      // proposal (once approved) would eventually reflect in real data;
      // the mocked status endpoint stands in for that here so the
      // B1.20 guard's identityDone check has something to key off.
      onCompleted: () => {
        status.identityDone = true;
      },
    });

    await signUpAndReachOnboarding(page, 'v2conv-full');

    await page.getByRole('button', { name: /talk it through instead/i }).click();
    await expect(page.getByText(ONBOARDING_CONVERSATION_OPENING_PROMPT)).toBeVisible();
    await expect(page.getByText('Business profile')).toBeVisible();

    // Tracks the state label as each of the six capture states is
    // entered, so the assertion below can confirm all six were visited
    // over the run instead of only checking the final one.
    const seenStateLabels = new Set<string>();
    const trackStateLabel = async () => {
      for (const label of [
        'Business profile',
        'Services offered',
        'Pricing',
        'Team',
        'Schedule',
        'Tools',
      ]) {
        if (await page.getByText(label, { exact: true }).isVisible().catch(() => false)) {
          seenStateLabels.add(label);
        }
      }
    };
    await trackStateLabel();

    for (const message of ONBOARDING_CONVERSATION_USER_MESSAGES) {
      await page.getByLabel('Your answer').fill(message);
      await page.getByRole('button', { name: /^send$/i }).click();
      await expect(page.getByText(message)).toBeVisible();
      await trackStateLabel();
    }

    // AC-8 — all six capture states covered over the run.
    expect([...seenStateLabels].sort()).toEqual(
      ['Business profile', 'Pricing', 'Schedule', 'Services offered', 'Team', 'Tools'].sort(),
    );

    // AC-8 — exchange count lands in [10, 15]. Each loop iteration above
    // is one exchange (one POST /api/onboarding/conversation/turn with a
    // userMessage); the opening prompt (no userMessage) doesn't count.
    expect(sentUserMessages.length).toBeGreaterThanOrEqual(10);
    expect(sentUserMessages.length).toBeLessThanOrEqual(15);

    // The conversation reached its terminal state.
    await expect(page.getByRole('button', { name: /continue setup/i })).toBeVisible();
    await page.getByRole('button', { name: /continue setup/i }).click();

    // AC-8 — the B1.20 soft-gate opens: the CRM ("/") no longer bounces
    // back to /onboarding now that identity is done (OnboardingGuard,
    // ProtectedRoute.tsx). Navigating directly proves the guard itself
    // re-evaluated, not just that the shell chose to stop rendering the
    // conversation panel.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page).not.toHaveURL(/\/onboarding/);
  });
});
