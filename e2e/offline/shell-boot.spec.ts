import { offlineTest as test, expect } from '../helpers/offline-app';

/**
 * Harness self-test — proves the offline fixture boots the real signed-in
 * app shell cleanly with ONLY the baseline shell mocks.
 *
 * Target route is /assistant: with no conversationId in the URL or
 * localStorage the page fires no page-specific fetch on mount, so every
 * /api call here is shell traffic — which the baseline mocks must fully
 * cover. An empty `unmockedApiCalls` is therefore the proof that the
 * baseline set is complete; any future shell endpoint shows up loudly as a
 * recorded catch-all hit.
 */

test.describe('offline harness — shell boot', () => {
  test('signed-in boot lands on the page with the full nav and no unmocked calls', async ({
    page,
    offlineApp,
  }) => {
    await page.goto('/assistant');

    // The Shell nav renders with the permission-gated entries visible —
    // proves the /api/me persona's permission strings satisfy the
    // `requires` tags in Shell.tsx (estimates:view, invoices:view).
    await expect(page.getByRole('link', { name: /estimates/i }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /invoices/i }).first()).toBeVisible();

    // No auth exit, no onboarding redirect — the signed-in stub + complete
    // onboarding status hold the route.
    expect(new URL(page.url()).pathname).toBe('/assistant');
    expect((await offlineApp.clerkCounters()).signOutCalls).toBe(0);

    // Baseline completeness: every /api call the shell fired was claimed by
    // a specific mock. (The voice-sessions poller and /api/ws never start —
    // the persona omits `ai:run` — so their absence here also pins the
    // WebSocket-free posture of the harness.)
    expect(offlineApp.unmockedApiCalls, 'shell traffic fully covered by baseline mocks').toEqual(
      [],
    );
  });

  test('poller tick stays quiet — no voice poller, no unmocked traffic, no errors', async ({
    page,
    offlineApp,
  }) => {
    await page.goto('/assistant');
    await expect(page.getByRole('link', { name: /invoices/i }).first()).toBeVisible();

    // Ride past one voice-poll interval (10s when ai:run is granted) plus
    // slack. With the ai:run-less persona nothing new may fire: no
    // /api/voice/sessions/active, no /api/ws fallout, no page errors (the
    // fixture teardown asserts pageErrors — this wait gives pollers the
    // chance to misbehave before it runs).
    await page.waitForTimeout(11_000);

    expect(
      offlineApp.unmockedApiCalls.filter((c) => c.includes('/api/voice/')),
      'voice discovery poller must stay off without ai:run',
    ).toEqual([]);
    expect(offlineApp.unmockedApiCalls, 'no unmocked traffic after a poller tick').toEqual([]);
    expect(new URL(page.url()).pathname).toBe('/assistant');
  });
});
