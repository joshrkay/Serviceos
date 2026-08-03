/**
 * Tradesperson admin-task inventory (versioned).
 *
 * Source of truth for "what admin work Mike/Jenna do" from
 * `docs/strategy/day-in-the-life.md`. Each task is scored as speakable
 * end-to-end when live catalog/code proves a path (proposal triple, lookup
 * skill, or intentional special handler). Money/comms tasks that still
 * require one-tap human approval AFTER a voice draft count as voice-
 * completable — the product claim is "approve in seconds," not unattended
 * money execution.
 *
 * Coverage gate: packages/api/scripts/admin-voice-coverage.ts
 * Tests: packages/api/test/voice/admin-voice-coverage.test.ts
 */

export const ADMIN_TASK_INVENTORY_VERSION = '1.0.0';

/** How the task is completed (or not) on the voice surface. */
export type AdminTaskVoiceMode =
  /** Intent → INTENT_TO_PROPOSAL_TYPE → execution handler. */
  | 'proposal'
  /** Read-only lookup_* skill (no proposal). */
  | 'lookup'
  /** Special router path (complaint/negotiation/en_route) outside the map. */
  | 'special'
  /** No voice path by design or white-space — residual human admin. */
  | 'human_only';

export interface AdminTask {
  /** Stable id used in reports and gate failure lists. */
  id: string;
  /** Short operator-facing title. */
  title: string;
  /** Day-in-the-life moment this task comes from. */
  dayInLife: string;
  mode: AdminTaskVoiceMode;
  /**
   * Primary classifier intent(s). For proposal/lookup/special modes these
   * must exist in live code; for human_only leave empty or note aspirational.
   */
  intents: readonly string[];
  /**
   * Expected proposal type when mode === 'proposal'. Checked against
   * INTENT_TO_PROPOSAL_TYPE at evaluation time.
   */
  proposalType?: string;
  /**
   * Critical-path id in graph/paths.ts or path-smoke when this task is part
   * of the ≥90% product claim proof spine.
   */
  criticalPathId?: string;
  /**
   * When true, this task is in the ≤10% human-only residual budget.
   * Must be mode === 'human_only'.
   */
  humanOnly: boolean;
  /** Optional notes (policy, CSR vs operator channel). */
  notes?: string;
}

/**
 * Recurring owner/operator admin work from Mike/Jenna days.
 * Keep the list product-shaped (not every classifier intent).
 */
export const ADMIN_TASK_INVENTORY: readonly AdminTask[] = [
  // ── Inbound CSR / booking ────────────────────────────────────────────
  {
    id: 'inbound_csr_book',
    title: 'Inbound CSR books a job from a caller',
    dayInLife: 'Mike 6:30am — AI answers and books while he drives',
    mode: 'proposal',
    intents: ['create_appointment'],
    proposalType: 'create_appointment',
    criticalPathId: 'book',
    humanOnly: false,
    notes:
      'On-call confirm when D-015 autonomous booking is enabled (hold + create_booking). See docs/runbooks/book-on-call.md.',
  },
  {
    id: 'book_appointment',
    title: 'Operator books / schedules an appointment by voice',
    dayInLife: 'Mike / Jenna — schedule jobs without typing',
    mode: 'proposal',
    intents: ['create_appointment'],
    proposalType: 'create_appointment',
    criticalPathId: 'book',
    humanOnly: false,
    notes: 'May upgrade to create_booking when hold + D-015 lane eligible.',
  },
  {
    id: 'reschedule_appointment',
    title: 'Reschedule an appointment',
    dayInLife: 'Mike Tuesday — move Garcia job',
    mode: 'proposal',
    intents: ['reschedule_appointment'],
    proposalType: 'reschedule_appointment',
    humanOnly: false,
  },
  {
    id: 'cancel_appointment',
    title: 'Cancel an appointment',
    dayInLife: 'Schedule changes mid-day',
    mode: 'proposal',
    intents: ['cancel_appointment'],
    proposalType: 'cancel_appointment',
    humanOnly: false,
  },
  {
    id: 'confirm_appointment',
    title: 'Confirm an appointment',
    dayInLife: 'Tomorrow’s jobs all confirmed in digest',
    mode: 'proposal',
    intents: ['confirm_appointment'],
    proposalType: 'confirm_appointment',
    humanOnly: false,
  },
  {
    id: 'reassign_crew',
    title: 'Reassign technician on a job',
    dayInLife: 'Mike — put Carlos on Garcia instead of me',
    mode: 'proposal',
    intents: ['reassign_appointment'],
    proposalType: 'reassign_appointment',
    humanOnly: false,
  },

  // ── Estimates ────────────────────────────────────────────────────────
  {
    id: 'draft_estimate',
    title: 'Draft an estimate from voice / call context',
    dayInLife: 'Mike 6:15am — three drafted estimates waiting',
    mode: 'proposal',
    intents: ['draft_estimate'],
    proposalType: 'draft_estimate',
    criticalPathId: 'quote',
    humanOnly: false,
  },
  {
    id: 'update_estimate',
    title: 'Edit an estimate line by voice',
    dayInLife: 'Mike 6:15am — make that a 3-ton condenser',
    mode: 'proposal',
    intents: ['update_estimate'],
    proposalType: 'update_estimate',
    humanOnly: false,
  },
  {
    id: 'send_estimate',
    title: 'Send an estimate to the customer',
    dayInLife: 'Mike — Approve & Send quotes before 6:30',
    mode: 'proposal',
    intents: ['send_estimate'],
    proposalType: 'send_estimate',
    humanOnly: false,
    notes: 'comms class — one-tap approve after draft; never auto-sends money/comms unattended without policy.',
  },
  {
    id: 'nudge_estimate',
    title: 'Nudge / re-send an estimate',
    dayInLife: 'Pipeline follow-up on open quotes',
    mode: 'proposal',
    intents: ['send_estimate_nudge'],
    proposalType: 'send_estimate_nudge',
    humanOnly: false,
  },

  // ── Invoices & collections ───────────────────────────────────────────
  {
    id: 'draft_invoice',
    title: 'Draft an invoice from a completed job',
    dayInLife: 'Jenna 2:00pm — morning customer invoiced from notes',
    mode: 'proposal',
    intents: ['create_invoice'],
    proposalType: 'draft_invoice',
    criticalPathId: 'invoice',
    humanOnly: false,
  },
  {
    id: 'send_invoice',
    title: 'Send an invoice with payment link',
    dayInLife: 'Jenna — SMS invoice + payment link',
    mode: 'proposal',
    intents: ['send_invoice'],
    proposalType: 'send_invoice',
    humanOnly: false,
  },
  {
    id: 'issue_invoice',
    title: 'Issue a finalized invoice',
    dayInLife: 'Mike evening — jobs invoiced',
    mode: 'proposal',
    intents: ['issue_invoice'],
    proposalType: 'issue_invoice',
    humanOnly: false,
    notes: 'money class — human approve required.',
  },
  {
    id: 'payment_chase',
    title: 'Chase unpaid invoices (payment reminder)',
    dayInLife: 'Mike 10:30pm / Jenna digest — follow-ups on unpaid',
    mode: 'proposal',
    intents: ['send_payment_reminder'],
    proposalType: 'send_payment_reminder',
    criticalPathId: 'payment_chase',
    humanOnly: false,
  },
  {
    id: 'record_payment',
    title: 'Record a cash / offline payment',
    dayInLife: 'Mark invoice paid when paid in field',
    mode: 'proposal',
    intents: ['record_payment'],
    proposalType: 'record_payment',
    humanOnly: false,
  },
  {
    id: 'batch_invoice',
    title: 'Batch-invoice completed jobs',
    dayInLife: 'Mike — invoice all completed jobs',
    mode: 'proposal',
    intents: ['batch_invoice'],
    proposalType: 'batch_invoice',
    humanOnly: false,
  },

  // ── CRM / leads ──────────────────────────────────────────────────────
  {
    id: 'create_customer',
    title: 'Capture a new customer / lead by voice',
    dayInLife: 'Inbound signup / new caller',
    mode: 'proposal',
    intents: ['create_customer'],
    proposalType: 'create_customer',
    criticalPathId: 'lead_capture',
    humanOnly: false,
  },
  {
    id: 'update_customer',
    title: 'Update customer contact info',
    dayInLife: 'Phone / email corrections',
    mode: 'proposal',
    intents: ['update_customer'],
    proposalType: 'update_customer',
    humanOnly: false,
  },
  {
    id: 'convert_lead',
    title: 'Convert a lead to a customer',
    dayInLife: 'Greenfield / B2B pipeline',
    mode: 'proposal',
    intents: ['convert_lead'],
    proposalType: 'convert_lead',
    humanOnly: false,
  },
  {
    id: 'mark_lead_lost',
    title: 'Mark a lead lost',
    dayInLife: 'Competitor wins',
    mode: 'proposal',
    intents: ['mark_lead_lost'],
    proposalType: 'mark_lead_lost',
    humanOnly: false,
  },

  // ── Jobs / field notes ───────────────────────────────────────────────
  {
    id: 'create_job',
    title: 'Open a job from voice',
    dayInLife: 'Alvarez no-AC job card',
    mode: 'proposal',
    intents: ['create_job'],
    proposalType: 'create_job',
    humanOnly: false,
  },
  {
    id: 'update_job',
    title: 'Update job status / notes fields',
    dayInLife: 'Mark job in progress',
    mode: 'proposal',
    intents: ['update_job'],
    proposalType: 'update_job',
    humanOnly: false,
  },
  {
    id: 'add_note',
    title: 'Add a note on a job / customer',
    dayInLife: 'Mike — Patel wants morning visits',
    mode: 'proposal',
    intents: ['add_note'],
    proposalType: 'add_note',
    humanOnly: false,
  },
  {
    id: 'notify_delay',
    title: 'Text customer about a late arrival',
    dayInLife: 'Mike bad day — Carlos 20 min late auto-text',
    mode: 'proposal',
    intents: ['notify_delay'],
    proposalType: 'notify_delay',
    humanOnly: false,
  },
  {
    id: 'log_expense',
    title: 'Log a parts / fuel expense',
    dayInLife: 'Field expense capture',
    mode: 'proposal',
    intents: ['log_expense'],
    proposalType: 'log_expense',
    humanOnly: false,
  },
  {
    id: 'log_time',
    title: 'Clock time on a job',
    dayInLife: 'Labor capture for billing',
    mode: 'proposal',
    intents: ['log_time_entry'],
    proposalType: 'log_time_entry',
    humanOnly: false,
  },

  // ── Lookups (read-only admin) ────────────────────────────────────────
  {
    id: 'lookup_quote',
    title: 'Look up what we quoted a customer',
    dayInLife: 'Mike 2:00pm — What did we quote the Patel job?',
    mode: 'lookup',
    intents: ['lookup_estimates'],
    criticalPathId: 'lookup',
    humanOnly: false,
  },
  {
    id: 'lookup_schedule',
    title: 'Look up appointments / day schedule',
    dayInLife: 'Between jobs — what is next',
    mode: 'lookup',
    intents: ['lookup_appointments', 'lookup_day_overview'],
    criticalPathId: 'lookup',
    humanOnly: false,
  },
  {
    id: 'lookup_invoices_balance',
    title: 'Look up invoices / balance due',
    dayInLife: 'Collections awareness mid-day',
    mode: 'lookup',
    intents: ['lookup_invoices', 'lookup_balance'],
    criticalPathId: 'lookup',
    humanOnly: false,
  },
  {
    id: 'lookup_digest',
    title: 'Hear end-of-day digest / pending items',
    dayInLife: 'Mike 7:30pm digest',
    mode: 'lookup',
    intents: ['lookup_digest', 'lookup_pending_items'],
    humanOnly: false,
  },

  // ── Safety / reputation / special ────────────────────────────────────
  {
    id: 'emergency_patch',
    title: 'Emergency escalation / patch-through',
    dayInLife: 'Mike 4:30pm — medical priority no AC',
    mode: 'proposal',
    intents: ['emergency_dispatch'],
    proposalType: 'emergency_dispatch',
    criticalPathId: 'emergency',
    humanOnly: false,
  },
  {
    id: 'respond_to_review',
    title: 'Draft a response to a bad Google review',
    dayInLife: 'Mike bad day — 1-star review response',
    mode: 'proposal',
    intents: ['respond_to_review'],
    proposalType: 'review_response_proposal',
    humanOnly: false,
  },
  {
    id: 'request_feedback',
    title: 'Ask a customer for a review',
    dayInLife: 'Reputation loop after good job',
    mode: 'proposal',
    intents: ['request_feedback'],
    proposalType: 'request_feedback',
    humanOnly: false,
  },
  {
    id: 'negotiation_hold',
    title: 'Price pushback holds for owner (no AI discount)',
    dayInLife: 'Mike bad day — Mrs. Wagner 20% off demand',
    mode: 'special',
    intents: ['negotiation'],
    criticalPathId: 'negotiation',
    humanOnly: false,
    notes: 'Special router → callback; AI never negotiates.',
  },
  {
    id: 'complaint_capture',
    title: 'Capture a complaint and route to owner',
    dayInLife: 'Dissatisfied customer after service',
    mode: 'special',
    intents: ['complaint'],
    criticalPathId: 'complaint',
    humanOnly: false,
  },
  {
    id: 'en_route_status',
    title: 'Mark en-route / on my way',
    dayInLife: 'Tech status between jobs',
    mode: 'special',
    intents: ['en_route'],
    humanOnly: false,
    notes: 'Direct audited act, not a proposal (Part F F-3).',
  },
  {
    id: 'standing_instruction',
    title: 'Set a standing shop rule by voice',
    dayInLife: 'Always add $79 diagnostic on AC calls',
    mode: 'proposal',
    intents: ['create_standing_instruction'],
    proposalType: 'create_standing_instruction',
    humanOnly: false,
  },

  // ── Residual human-only (must stay ≤10% of inventory) ────────────────
  {
    id: 'assign_closest_certified_tech',
    title: 'Auto-assign closest certified tech',
    dayInLife: 'Dispatch optimization beyond reassign-by-name',
    mode: 'human_only',
    intents: [],
    humanOnly: true,
    notes: 'Catalog section C / parity P25 — no proposal type yet.',
  },
  {
    id: 'equipment_photo_to_asset',
    title: 'Add equipment unit from service photo to customer asset list',
    dayInLife: 'HVAC model tracking from photos',
    mode: 'human_only',
    intents: [],
    humanOnly: true,
    notes: 'Catalog section C / parity P24 — white-space.',
  },
  {
    id: 'tax_payroll_books',
    title: 'Tax filing / payroll calculation',
    dayInLife: 'Wife on weekends for the books (out of product scope)',
    mode: 'human_only',
    intents: [],
    humanOnly: true,
    notes: 'day-in-the-life Never list — QuickBooks/Gusto territory.',
  },
] as const;

export function inventoryTaskById(id: string): AdminTask | undefined {
  return ADMIN_TASK_INVENTORY.find((t) => t.id === id);
}

export function humanOnlyTasks(): AdminTask[] {
  return ADMIN_TASK_INVENTORY.filter((t) => t.humanOnly);
}

export function voiceClaimedTasks(): AdminTask[] {
  return ADMIN_TASK_INVENTORY.filter((t) => !t.humanOnly);
}
