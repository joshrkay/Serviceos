/**
 * #1392 (QA matrix VOX-05) — "Draft an estimate for the QA Matrix job with one
 * diagnostic labor line for $150" was classified draft_estimate with
 * `{ amount: 15000, jobTitle: "diagnostic labor" }`. The voice payload builds
 * estimate lines from `lineItemDescriptions` ONLY, so the draft had no lines
 * and approve refused on `lineItems`. The draft_estimate block never asked for
 * lines (create_invoice's block does, with a worked example), so the model
 * parked the work in the nearest free-text slot.
 *
 * Seam: the assembled classifier system prompt each surface sends.
 */
import { describe, expect, it } from 'vitest';
import {
  buildClassifierSystemPrompt,
  PROFILE_INTENTS,
  type ClassifierProfile,
} from '../../../src/ai/orchestration/classifier-profile';

/** The draft_estimate intent block: from its bullet to the next intent bullet. */
function draftEstimateBlock(prompt: string): string {
  const start = prompt.indexOf('- "draft_estimate"');
  expect(start, 'draft_estimate block present').toBeGreaterThanOrEqual(0);
  const next = prompt.indexOf('\n- "', start + 1);
  return prompt.slice(start, next === -1 ? undefined : next);
}

const PROFILES: ClassifierProfile[] = ['operator', 'caller', 'field_tech', 'owner_line'];

describe('classifier prompt — draft_estimate extracts line items (#1392)', () => {
  it.each(PROFILES.filter((p) => PROFILE_INTENTS[p].has('draft_estimate')))(
    '%s: the draft_estimate block asks for lineItemDescriptions, with a worked example',
    (profile) => {
      const block = draftEstimateBlock(buildClassifierSystemPrompt(profile));
      expect(block).toContain('Extract lineItemDescriptions');
      // The VOX-05 shape: a described line of work plus a stated price.
      expect(block).toContain('lineItemDescriptions ["diagnostic labor"]');
    },
  );
});
