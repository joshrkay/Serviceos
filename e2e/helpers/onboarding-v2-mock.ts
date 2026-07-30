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
    // Fields added by the launch-readiness pass. Faithful to
    // OnboardingStatusResponse so the funnel events fired from the shell
    // carry a real tenant_id and the past-due/activation banners stay
    // hidden in the happy-path journey.
    tenantId: '00000000-0000-0000-0000-0000000000e2',
    subscriptionStatus: null,
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

// ─── B1.19 — conversational onboarding mock ──────────────────────────────
//
// Mocks POST /api/onboarding/conversation/turn for the "talk it through"
// step (ConversationStep.tsx). The real route drives a stateful FSM
// server-side (packages/api/src/ai/orchestration/onboarding-conversation.ts)
// — this mock is a fixed, ordered script rather than reproducing the FSM,
// since the E2E goal is proving the FRONTEND surface (mic/typed turns →
// render → resume → mobile-safe → exchange count), not the engine itself
// (that's covered server-side by onboarding-conversation.test.ts and the
// B1.19 parity integration test).
//
// The script below is 11 user turns — inside the AC-8 required [10,15]
// exchange range — walking through all six capture states (profile,
// category, pricing, team, schedule, tools) with three clarification
// exchanges (category follow-up, team member role, and an explicit
// timezone confirmation — never guessed, per the PRD) before landing on
// `review` → `completed`.

export interface OnboardingConversationScriptTurn {
  /** FSM state the assistant is in when it sends `assistantMessage`. */
  state: string;
  assistantMessage: string;
  /** True on the final, terminal turn. */
  completed?: boolean;
}

/** The user-side utterances a test should submit, in order, to walk the script. */
export const ONBOARDING_CONVERSATION_USER_MESSAGES: readonly string[] = [
  "Hi, I'm Jamie — I run Acme HVAC out of Austin, Texas.",
  'We do AC repair, furnace installs, and maintenance plans.',
  'Yes, we take emergency after-hours calls, with a seventy five dollar upcharge.',
  'Trip fee is eighty nine dollars, hourly rate is one fifty.',
  'An AC tune-up is a flat one twenty nine.',
  "It's me and my cousin Carlos.",
  'Carlos is a technician.',
  'Monday through Friday, eight to five, and yes to after-hours.',
  'Yes, Central Time — Austin.',
  'We use QuickBooks and Housecall Pro for scheduling.',
  'Looks good.',
];

export const ONBOARDING_CONVERSATION_OPENING_PROMPT =
  "Hi! I'm going to set up your account. To start — tell me a bit about your business: " +
  "name, where you're based, and what kind of work you do.";

/** Assistant replies, 1:1 with ONBOARDING_CONVERSATION_USER_MESSAGES. */
export const ONBOARDING_CONVERSATION_SCRIPT: readonly OnboardingConversationScriptTurn[] = [
  { state: 'category_capture', assistantMessage: 'Got it. What kinds of services do you offer?' },
  // Clarification #1 — stays in category_capture.
  {
    state: 'category_capture',
    assistantMessage: 'Do you also handle emergency or after-hours calls?',
  },
  {
    state: 'pricing_capture',
    assistantMessage: "Now let's talk pricing — what's your trip fee and hourly rate?",
  },
  {
    state: 'pricing_capture',
    assistantMessage: 'Any common flat-rate jobs, like a tune-up or thermostat install?',
  },
  { state: 'team_capture', assistantMessage: "Who's on your team? Names and roles are enough." },
  // Clarification #2 — the "cousin Carlos" follow-up (AC-8's required
  // clarification exchange), stays in team_capture.
  {
    state: 'team_capture',
    assistantMessage: "Got it — what's Carlos' role? Technician, dispatcher, or something else?",
  },
  {
    state: 'schedule_capture',
    assistantMessage: 'What are your business hours, and do you cover after-hours emergencies?',
  },
  // Clarification #3 — explicit timezone confirmation, never guessed.
  {
    state: 'schedule_capture',
    assistantMessage: "Just to confirm — that's Central Time, Austin, Texas. Correct?",
  },
  {
    state: 'tools_capture',
    assistantMessage:
      'Last one — what tools do you use today? Scheduling, invoicing, accounting, anything like that.',
  },
  {
    state: 'review',
    assistantMessage:
      "All right, I've got enough to draft your setup. I'll send a few items to your inbox " +
      "for you to review and approve. Say 'looks good' when you're ready.",
  },
  {
    state: 'completed',
    assistantMessage: 'Done. Your setup proposals are in the inbox — review and tap approve when you\'re ready.',
    completed: true,
  },
];

export interface OnboardingConversationMockState {
  sessionId: string | null;
  /** Count of user turns processed so far (mirrors the server's turnCount). */
  turnIndex: number;
}

export function createOnboardingConversationMockState(): OnboardingConversationMockState {
  return { sessionId: null, turnIndex: 0 };
}

/**
 * Installs the conversation-turn mock. Resume (sessionId only, no
 * userMessage) replays the current position in the script without
 * advancing — mirrors the real route's resume behavior, which is what the
 * AC-2 resumability test depends on.
 */
export async function installOnboardingConversationApiMocks(
  page: Page,
  convState: OnboardingConversationMockState,
  opts?: { onCompleted?: () => void; sentUserMessages?: string[] },
): Promise<void> {
  await page.route('**/api/onboarding/conversation/turn', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const body = (route.request().postDataJSON() ?? {}) as {
      sessionId?: string;
      userMessage?: string;
    };
    if (!convState.sessionId) convState.sessionId = 'e2e-conv-session-1';

    if (!body.userMessage) {
      // New session (first call) or a resume replay — both report the
      // current position without advancing turnIndex.
      const idx = convState.turnIndex;
      const priorEntry = idx > 0 ? ONBOARDING_CONVERSATION_SCRIPT[idx - 1] : null;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionId: convState.sessionId,
          assistantMessage: priorEntry?.assistantMessage ?? ONBOARDING_CONVERSATION_OPENING_PROMPT,
          state: priorEntry?.state ?? 'profile_capture',
          turnCount: idx,
          completed: !!priorEntry?.completed,
          proposalIds: priorEntry?.completed ? ['e2e-prop-1'] : [],
        }),
      });
      return;
    }

    if (opts?.sentUserMessages) opts.sentUserMessages.push(body.userMessage);

    const entry = ONBOARDING_CONVERSATION_SCRIPT[convState.turnIndex];
    if (!entry) {
      // Script exhausted (shouldn't happen in the scripted E2E flow) —
      // replay the last known terminal state rather than 500ing.
      const last = ONBOARDING_CONVERSATION_SCRIPT[ONBOARDING_CONVERSATION_SCRIPT.length - 1];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionId: convState.sessionId,
          assistantMessage: last.assistantMessage,
          state: last.state,
          turnCount: convState.turnIndex,
          completed: true,
          proposalIds: ['e2e-prop-1'],
        }),
      });
      return;
    }

    convState.turnIndex += 1;
    if (entry.completed) opts?.onCompleted?.();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: convState.sessionId,
        assistantMessage: entry.assistantMessage,
        state: entry.state,
        turnCount: convState.turnIndex,
        completed: !!entry.completed,
        proposalIds: entry.completed ? ['e2e-prop-1'] : [],
      }),
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
