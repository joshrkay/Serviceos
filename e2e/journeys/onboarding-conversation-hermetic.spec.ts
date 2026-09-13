import { test, expect } from '@playwright/test';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { API_URL, bootstrapOwner, pollDbSnapshot, queryOne } from '../fixtures/onboarding-hermetic-lane';

/**
 * 1.9 — "I want to set this up by talking instead of filling a form,
 * because I'm doing it in the truck." Acceptance: up to 15 turns,
 * transcript/extractions/clarification counts round-trip through JSONB,
 * RLS is ENABLE+FORCE, cross-tenant reads are refused, and the form
 * wizard stays available as fallback/edit surface.
 *
 * `test/integration/onboarding-conversation*.test.ts` already prove the
 * JSONB round-trip, RLS and audit legs against real Postgres — but only by
 * calling the orchestrator directly with a SCRIPTED gateway double, never
 * through the real `/onboarding` browser UI's "Talk it through instead"
 * panel, and never with the app's own hermetic LLM fallback.
 *
 * This app boots `MockLLMProvider` (hermetic mode) whenever
 * `AI_PROVIDER_API_KEY` is unset — the SAME provider 1.8's AI-check spec
 * already proves is real, unmocked wiring. Its `scriptHermeticResponse()`
 * (packages/api/src/ai/providers/mock.ts) has no branch for this feature's
 * extractor task types (`extract_business_profile`, etc. —
 * packages/api/src/ai/tasks/onboarding/*.ts) and falls through to the
 * generic `{"ok":true,"mock":true,...}` catch-all, which every extractor
 * parses as "no usable data, low confidence." That is a REAL model-turn
 * limitation, not a test gap this spec should route around — it means a
 * hermetic run can prove every mechanical claim in the acceptance (turns
 * round-trip through JSONB, the state machine advances via
 * MAX_CLARIFICATIONS_PER_STATE and terminates via MAX_TURNS=15, RLS holds,
 * cross-tenant reads are refused, the form stays reachable) but CANNOT
 * prove the FSM reaching `completed` with genuinely-extracted business
 * details — only a real model call could produce that, which is exactly
 * the class of gap #1119 already parks. Pinned below with `test.fail()`
 * rather than faked.
 */

const REPORT_DIR = 'setup-8-1-r5';

test.describe('onboarding conversational path (1.9) — real Postgres, real /onboarding "Talk it through" panel', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !process.env.AI_PROVIDER_API_KEY;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), E2E_USE_TEST_DB=true with DATABASE_URL ' +
      'pointing at the test container, and AI_PROVIDER_API_KEY unset so the hermetic MockLLMProvider ' +
      'stays wired instead of a real (never-dialed-in-this-harness) model.',
  );

  test(
    'a fresh owner drives up to 15 turns through the real "Talk it through" panel; transcript, ' +
      'extractions and clarification counts round-trip through JSONB at real Postgres with RLS ' +
      'ENABLE+FORCE; a neighbour tenant cannot read this session (cross-tenant refused); the form ' +
      'wizard stays reachable throughout ("Switch back")',
    async ({ page, baseURL }, testInfo) => {
      testInfo.setTimeout(120_000);
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));

      const neighbour = await bootstrapOwner(page, 'convneighbour');
      const owner = await bootstrapOwner(page, 'convowner');

      await installClerkStub(page, { signedIn: true, sub: owner.sub, token: owner.jwt });
      await blockExternalHosts(page, baseURL!);
      await page.goto('/onboarding');

      // ── Enter conversation mode from the identity step. ──────────────────
      await expect(page.getByLabel('Business name')).toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: /talk it through instead/i }).click();
      await expect(page.getByRole('heading', { name: /talk it through/i })).toBeVisible({
        timeout: 15_000,
      });

      // ── The form wizard is STILL reachable, mid-conversation, before any
      //    turn is sent — proving AC-1's "never a replacement, always a
      //    fallback" holds from the very first render, not just at the end. ─
      await expect(page.getByRole('button', { name: /prefer the form\? switch back/i })).toBeVisible();

      // ── Drive real turns against the real route until the FSM goes
      //    terminal (completed/capped) or the 15-turn budget is exhausted —
      //    whichever the real, hermetic-mock-driven system reaches first.
      //    Content is deliberately generic: the hermetic mock cannot use it
      //    (see file header) — this loop is exercising the MECHANICS, not
      //    scripting a fake extraction result. ─────────────────────────────
      const answerInput = page.getByLabel('Your answer');
      const sendButton = page.getByRole('button', { name: /^send$/i });
      const continueButton = page.getByRole('button', { name: /continue setup/i });

      // Captured from the real turn responses rather than queried back from
      // Postgres by tenant + `ORDER BY created_at DESC LIMIT 1` — a stray
      // extra `onboarding_session` row (RED run: ConversationStep's initial
      // no-message "surface the opening prompt" effect fired twice under
      // Vite/React dev double-invoke, orphaning a turn_count=0 row whose
      // created_at sorted AFTER the real, 15-turn session) makes that query
      // pick the wrong row. The session id the BROWSER is actually driving
      // is unambiguous straight from its own responses.
      let turnsSent = 0;
      let sessionId: string | null = null;
      for (let i = 0; i < 16; i += 1) {
        if (await continueButton.isVisible({ timeout: 500 }).catch(() => false)) break;
        await expect(answerInput).toBeEnabled({ timeout: 15_000 });
        await answerInput.fill(`We run a home services business, turn ${i + 1}.`);
        const turnResponse = page.waitForResponse(
          (r) =>
            r.request().method() === 'POST' &&
            new URL(r.url()).pathname === '/api/onboarding/conversation/turn',
        );
        await sendButton.click();
        const res = await turnResponse;
        expect(res.status(), `turn ${i + 1} -> ${res.status()}`).toBeLessThan(300);
        const body = (await res.json()) as { sessionId?: string };
        if (body.sessionId) sessionId = body.sessionId;
        turnsSent += 1;
      }
      expect(turnsSent, 'at least one real turn was actually sent').toBeGreaterThan(0);
      expect(sessionId, 'captured the real session id from a turn response').toBeTruthy();

      await page.screenshot({
        path: 'docs/audit/lane-reports/setup-8-1-r5/1.9-conversation-terminal.png',
        fullPage: true,
      });

      // ── Terminal state, read back from real Postgres — the FSM must have
      //    gone terminal (completed or capped) within the 15-turn budget;
      //    the hermetic mock's non-matching extraction makes `capped` the
      //    realistic outcome (MAX_CLARIFICATIONS_PER_STATE force-advances
      //    each state, MAX_TURNS=15 force-caps the session), asserted as a
      //    fact rather than assumed. ─────────────────────────────────────
      pollDbSnapshot(
        REPORT_DIR,
        '1.9-session-terminal-state',
        `SELECT id, fsm_state, turn_count, jsonb_array_length(transcript_turns) AS turns, ` +
          `clarification_count_by_state FROM onboarding_session WHERE tenant_id = '${owner.tenantId}';`,
      );

      const fsmState = queryOne(
        `SELECT fsm_state FROM onboarding_session WHERE id = '${sessionId}';`,
      );
      expect(['completed', 'capped'], `FSM reached a terminal state, got '${fsmState}'`).toContain(
        String(fsmState).trim(),
      );

      const turnCount = Number(
        queryOne(`SELECT turn_count FROM onboarding_session WHERE id = '${sessionId}';`),
      );
      expect(turnCount, 'turn_count round-tripped through JSONB/Postgres and is within the 15-turn budget')
        .toBeGreaterThan(0);
      expect(turnCount).toBeLessThanOrEqual(15);

      const transcriptLen = Number(
        queryOne(
          `SELECT jsonb_array_length(transcript_turns) FROM onboarding_session WHERE id = '${sessionId}';`,
        ),
      );
      expect(transcriptLen, 'transcript_turns JSONB round-tripped with real content').toBeGreaterThan(0);

      const clarificationJson = queryOne(
        `SELECT clarification_count_by_state::text FROM onboarding_session WHERE id = '${sessionId}';`,
      );
      expect(clarificationJson, 'clarification_count_by_state JSONB round-tripped').toBeTruthy();

      // ── RLS — ENABLE + FORCE on the real table, not assumed from the
      //    migration source. ────────────────────────────────────────────
      const rlsFlags = queryOne(
        `SELECT relrowsecurity::text || ',' || relforcerowsecurity::text ` +
          `FROM pg_class WHERE relname = 'onboarding_session';`,
      );
      expect(rlsFlags, 'ENABLE + FORCE row level security on onboarding_session').toBe('true,true');
      const policyCount = queryOne(
        `SELECT count(*) FROM pg_policies WHERE tablename = 'onboarding_session';`,
      );
      expect(String(policyCount).trim()).not.toBe('0');

      // ── Cross-tenant reads refused — the neighbour, authenticated as
      //    ITSELF, tries to resume this tenant's real session id. RLS-aware
      //    404 ("simply doesn't exist"), not a 403 that would leak the id's
      //    existence, and definitely not the transcript. ────────────────
      const crossTenantRes = await page.request.post(`${API_URL}/api/onboarding/conversation/turn`, {
        headers: { 'content-type': 'application/json', ...neighbour.authHeaders },
        data: JSON.stringify({ sessionId, userMessage: 'trying to read someone else\'s session' }),
      });
      expect(crossTenantRes.status(), 'cross-tenant session read is refused').toBe(404);
      const crossTenantBody = (await crossTenantRes.json()) as { error?: string };
      expect(crossTenantBody.error).toBe('ONBOARDING_SESSION_NOT_FOUND');

      pollDbSnapshot(
        REPORT_DIR,
        '1.9-T1-neighbour-no-session',
        `SELECT count(*) FROM onboarding_session WHERE tenant_id = '${neighbour.tenantId}';`,
      );
      const neighbourSessions = queryOne(
        `SELECT count(*) FROM onboarding_session WHERE tenant_id = '${neighbour.tenantId}';`,
      );
      expect(String(neighbourSessions).trim(), 'neighbour has no session of its own (never entered conversation mode)').toBe('0');

      // ── Form wizard still available as fallback/edit surface — even
      //    after the conversation went terminal, "Switch back" (or, once
      //    terminal, "Continue setup") returns to the real form wizard. ────
      if (await continueButton.isVisible({ timeout: 500 }).catch(() => false)) {
        await continueButton.click();
      } else {
        await page.getByRole('button', { name: /prefer the form\? switch back/i }).click();
      }
      await expect(page.getByLabel('Business name').or(page.getByRole('heading', { name: /pick your trade/i })))
        .toBeVisible({ timeout: 15_000 });

      expect(pageErrors, 'no uncaught page errors during the conversational onboarding journey').toEqual([]);
    },
  );

  test(
    'PINNED GAP — a business name stated in plain English in the first turn is NOT genuinely ' +
      'extracted hermetically (needs a real model turn, #1119-class)',
    async ({ page, baseURL }) => {
      // KNOWN PRODUCT/HARNESS GAP, not a test bug: MockLLMProvider.scriptHermeticResponse()
      // (packages/api/src/ai/providers/mock.ts:223-232, the final catch-all) has no branch
      // for this feature's extractor task types (`extract_business_profile` etc. —
      // packages/api/src/ai/tasks/onboarding/*.ts) and returns the generic
      // {"ok":true,"mock":true,...} blob. BusinessProfileExtractor.buildExtraction() parses
      // that as "no business name, no verticals, low confidence"
      // (packages/api/src/ai/tasks/onboarding/business-profile-extractor.ts:78-90's
      // needsClarification branch), regardless of what the owner actually typed. Only a real
      // model call can produce genuine extraction — same class of gap the already-parked
      // #1119 decision covers. Reached as far as the real surface goes (this spec's main test
      // above proves every mechanical claim of the acceptance criteria); this test pins the
      // one sub-claim ("completes... with real extracted details") that a hermetic run cannot
      // prove, rather than faking it.
      test.fail(
        true,
        'MockLLMProvider has no extract_business_profile branch (mock.ts:223-232) — a stated ' +
          'business name is never actually captured into extraction_state hermetically; requires ' +
          'a real model turn (#1119-class gap).',
      );

      const owner = await bootstrapOwner(page, 'convextractgap');
      await installClerkStub(page, { signedIn: true, sub: owner.sub, token: owner.jwt });
      await blockExternalHosts(page, baseURL!);
      await page.goto('/onboarding');

      await expect(page.getByLabel('Business name')).toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: /talk it through instead/i }).click();
      await expect(page.getByRole('heading', { name: /talk it through/i })).toBeVisible({
        timeout: 15_000,
      });

      const answerInput = page.getByLabel('Your answer');
      await expect(answerInput).toBeEnabled({ timeout: 15_000 });
      await answerInput.fill(
        'Our business is called Acme Precision HVAC, based in Tempe Arizona. We do heating and cooling repair.',
      );
      const turnResponse = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          new URL(r.url()).pathname === '/api/onboarding/conversation/turn',
      );
      await page.getByRole('button', { name: /^send$/i }).click();
      await turnResponse;

      const extractedName = queryOne(
        `SELECT extraction_state->'businessProfile'->>'businessName' ` +
          `FROM onboarding_session WHERE tenant_id = '${owner.tenantId}' ORDER BY created_at DESC LIMIT 1;`,
      );
      // Desired (once a real model is wired): 'Acme Precision HVAC'. Actual today: null —
      // this assertion is the natural failure test.fail() above expects.
      expect(
        extractedName,
        'once a real model is wired, the stated business name should round-trip into extraction_state',
      ).toBe('Acme Precision HVAC');
    },
  );
});
