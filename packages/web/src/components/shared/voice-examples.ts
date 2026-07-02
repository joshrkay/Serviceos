/**
 * U7 (agent wave) — "you can say…" discoverability examples for the VoiceBar.
 *
 * Hand-curated examples of the highest-value speakable voice actions. Every
 * `intent` here MUST be a speakable intent in the machine-readable block of
 * docs/reference/voice-action-catalog.md — pinned by
 * voice-examples.catalog.test.ts, the same mechanism the API contract test
 * uses — so a renamed or removed intent can never leave a dead example
 * rotating in the UI.
 */
export interface VoiceExample {
  /** Classifier intent (catalog "speakable" entry) this example exercises. */
  intent: string;
  /** What the user would actually say. */
  example: string;
}

export const VOICE_EXAMPLES: readonly VoiceExample[] = [
  { intent: 'create_invoice', example: 'Invoice the Martins for the water heater' },
  { intent: 'draft_estimate', example: 'Quote the Khan install, 3-ton condenser' },
  { intent: 'create_appointment', example: 'Book Carlos at the Garcia place Tuesday 2pm' },
  { intent: 'reassign_appointment', example: 'Assign Carlos to the 2pm' },
  {
    intent: 'create_invoice_schedule',
    example: 'Set up 50% deposit, 50% on completion for the Hendersons',
  },
  { intent: 'respond_to_review', example: 'Respond to that 1-star review' },
  {
    intent: 'create_standing_instruction',
    example: 'From now on always add a $79 diagnostic fee to AC calls',
  },
  { intent: 'record_payment', example: 'Mark the Smith invoice paid, $200 cash' },
  { intent: 'send_payment_reminder', example: 'Chase the unpaid Smith invoice' },
  { intent: 'batch_invoice', example: 'Invoice all my completed jobs' },
  { intent: 'create_customer', example: 'New customer Maria Alvarez, 480-555-0102' },
  { intent: 'add_note', example: 'Note on the Patel job: wants morning visits' },
  { intent: 'log_expense', example: 'Log a $60 parts expense on the Patel job' },
  { intent: 'notify_delay', example: "Text the Garcia customer I'm 20 minutes late" },
];

/**
 * Pick `count` distinct examples in random order (Fisher–Yates over a copy).
 * `rand` is injectable so tests can pin the selection.
 */
export function pickExamples(
  count: number,
  rand: () => number = Math.random,
): VoiceExample[] {
  const pool = [...VOICE_EXAMPLES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(1, Math.min(count, pool.length)));
}
