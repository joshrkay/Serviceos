/**
 * #1613 — Layer 2 run 37323734649 (reschedule-appointment-known-customer):
 * the judge failed the close twice for not saying "drafted". The close an S1
 * caller hears for a confirmed, queued request is the owner-decided
 * CALLER_REQUEST_QUEUED_COPY (#1553: "I've passed that along to our team, and
 * someone will confirm it with you shortly."), not a "drafted" line — so the
 * corpus expectation must describe that close. The judge grades the agent
 * against the expectation; the expectation must be the product.
 */
import { describe, it, expect } from 'vitest';

import { loadLayer2Corpus } from '../../src/ai/voice-quality/corpus/loader';

describe('#1613 — S1 queued-request close in the corpus', () => {
  it('reschedule-appointment-known-customer expects the #1553 queued-request close', () => {
    const script = loadLayer2Corpus().find((s) => s.id === 'reschedule-appointment-known-customer')!;
    const close = script.turns[script.turns.length - 1]!.expected.spokenAnswerMatches ?? '';

    expect(close).toContain("I've passed that along to our team, and someone will confirm it with you shortly.");
    expect(close).not.toMatch(/I've drafted/);
  });
});
