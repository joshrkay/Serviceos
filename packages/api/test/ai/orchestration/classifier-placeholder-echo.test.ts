/**
 * QA matrix 2026-09-26, row SCH-03 — the live classifier (gpt-4o-mini) copied
 * the prompt's extraction-schema placeholder into the answer:
 *
 *   "Cancel my upcoming appointment please — I need to reschedule it…"
 *   → extractedEntities.appointmentReference = "<string, optional>"
 *
 * The in-app voice path then resolved an appointment literally named
 * "<string, optional>", found none, and SPOKE it back to the operator:
 * "I couldn't find a matching appointment for <string, optional>." A schema
 * placeholder is never something the caller said, so it must not survive
 * parsing as an entity.
 */
import { describe, expect, it } from 'vitest';
import { parseClassifierJson } from '../../../src/ai/orchestration/intent-classifier';

describe('parseClassifierJson — schema placeholder echoes', () => {
  it('drops an entity whose value is the prompt placeholder, keeping the real ones', () => {
    const live = JSON.stringify({
      intentType: 'cancel_appointment',
      confidence: 0.8,
      reasoning: 'The caller wants to cancel their upcoming appointment.',
      extractedEntities: {
        appointmentReference: '<string, optional>',
        cancellationReason: 'Need to reschedule for a later date',
      },
    });

    const parsed = parseClassifierJson(live);

    expect(parsed?.intentType).toBe('cancel_appointment');
    expect(parsed?.extractedEntities).toEqual({
      cancellationReason: 'Need to reschedule for a later date',
    });
  });

  it('drops a placeholder line item ("<string>") instead of billing a line named after the schema', () => {
    const parsed = parseClassifierJson(
      JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.9,
        reasoning: 'Invoice for completed work.',
        extractedEntities: {
          customerName: 'Khan',
          amount: 35000,
          lineItemDescriptions: ['completed furnace repair', '<string>'],
        },
      }),
    );

    expect(parsed?.extractedEntities).toEqual({
      customerName: 'Khan',
      amount: 35000,
      lineItemDescriptions: ['completed furnace repair'],
    });
  });
});
