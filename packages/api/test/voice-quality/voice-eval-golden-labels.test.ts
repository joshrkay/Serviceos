/**
 * Golden-label corrections for the intent eval (#1469), pinned at the golden
 * set's public seams: the held-out split the live eval scores
 * (`loadIntentTestSplit`) and the committed corpus file it reads.
 *
 * A caller ASKING whether their visit is still on / is booked is a read-only
 * question about an upcoming appointment — `lookup_appointments` ("Do I have
 * a service call scheduled?", intent-taxonomy-blocks.ts) — not
 * `confirm_appointment`, which MARKS an existing appointment confirmed
 * because the customer said they'll be there. `confirm_appointment` is also
 * not on the inbound-caller surface at all (CALLER_INTENTS,
 * classifier-profile.ts), so production can never answer these caller
 * questions with it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { loadIntentTestSplit, UTTERANCES_PATH } from '../../../voice-eval/corpus';

const INTERROGATIVE_STATUS_CHECK = /^(Is (my|the) .+ still on for .+\?|Can you confirm my .+ is booked.*\?)$/;

describe('intent golden set — appointment status questions (#1469)', () => {
  it('labels the held-out status questions the live eval scores as lookup_appointments', () => {
    const byUtterance = new Map(loadIntentTestSplit().map((r) => [r.utterance, r.intent]));
    expect(byUtterance.get('Is my visit still on for Thursday please?')).toBe('lookup_appointments');
    expect(byUtterance.get('Can you confirm my service call is booked thanks?')).toBe('lookup_appointments');
  });

  it('labels every "is it still on / is it booked?" question in the corpus the same way', () => {
    const rows = readFileSync(UTTERANCES_PATH, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { text: string; intent: string });
    const statusQuestions = rows.filter((r) => INTERROGATIVE_STATUS_CHECK.test(r.text));
    expect(statusQuestions.length).toBe(19);
    expect(statusQuestions.filter((r) => r.intent !== 'lookup_appointments')).toEqual([]);
  });
});
