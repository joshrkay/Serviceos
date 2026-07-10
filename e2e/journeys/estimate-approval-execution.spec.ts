/**
 * Journey 2 — AI-generated estimate proposal is reviewed, approved, and executed.
 *
 * Hermetic proof lives in `e2e/money-loop/estimate-approve-execute.spec.ts`
 * (W1-1). That suite boots the real SPA with the offline Clerk stub, seeds a
 * ready_for_review draft_estimate (no live LLM), drives Inbox Approve, and
 * advances execution via a test hook — no Clerk secrets, no AI_PROVIDER_API_KEY.
 *
 * This file remains as the journey index entry and documents the live-stack
 * shape for a future secret-gated run. The hermetic path is the continuous
 * CI gate.
 *
 * Plan: docs/plans/wave1/W1-1-estimate-approve-execute.md
 */

import { test } from '@playwright/test';

test.describe('Journey 2 — estimate proposal approval + execution', () => {
  test('see e2e/money-loop/estimate-approve-execute.spec.ts (W1-1 hermetic)', () => {
    // Intentionally empty — hermetic coverage is the money-loop spec.
    // Keeping this describe so the journeys README / index still points here.
    test.info().annotations.push({
      type: 'doc',
      description:
        'Hermetic approve→execute: e2e/money-loop/estimate-approve-execute.spec.ts',
    });
  });
});
