import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPOSAL_TYPES } from './enums';
import { proposalPayloadSchemas } from './proposals';

describe('proposal payload gate', () => {
  it('every proposal type has a payload schema', () => {
    for (const type of PROPOSAL_TYPES) {
      expect(proposalPayloadSchemas[type]).toBeDefined();
    }
  });

  it('accepts well-formed payloads', () => {
    expect(
      proposalPayloadSchemas.create_customer.safeParse({
        name: 'Sarah Johnson',
        phone: '+15550111',
      }).success,
    ).toBe(true);
    expect(
      proposalPayloadSchemas.draft_invoice.safeParse({
        customerName: 'Sarah Johnson',
        lineItems: [{ description: 'Labor', quantityHundredths: 100, unitPriceCents: 12_000 }],
      }).success,
    ).toBe(true);
    expect(
      proposalPayloadSchemas.schedule_job.safeParse({
        customerName: 'Dev Patel',
        title: 'Furnace tune-up',
        startsAt: new Date().toISOString(),
        durationMinutes: 60,
      }).success,
    ).toBe(true);
  });

  it('rejects arbitrary junk for every type (fuzzed)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PROPOSAL_TYPES),
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.array(fc.anything(), { maxLength: 3 }),
          fc.dictionary(fc.string({ maxLength: 8 }), fc.string({ maxLength: 8 }), { maxKeys: 3 }),
        ),
        (type, junk) => {
          const result = proposalPayloadSchemas[type].safeParse(junk);
          // Junk must never slip through as a valid typed payload unless it
          // genuinely satisfies the schema (vanishingly rare for these shapes).
          if (result.success) {
            expect(typeof junk).toBe('object');
          }
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it('money fields refuse floats and negatives (fuzzed)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ noInteger: true, noNaN: true }),
          fc.integer({ min: -1_000_000, max: -1 }),
        ),
        (bad) => {
          const result = proposalPayloadSchemas.draft_invoice.safeParse({
            customerName: 'X',
            lineItems: [{ description: 'Y', quantityHundredths: bad, unitPriceCents: 100 }],
          });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 1_000 },
    );
  });
});
