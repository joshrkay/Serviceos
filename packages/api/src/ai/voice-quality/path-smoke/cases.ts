/**
 * Real-LLM path smoke cases — one utterance (or small multi-turn set) per
 * critical path that requires model proof.
 *
 * Keep this list short and cost-bounded: the default suite must project under
 * ~$1 (100¢) at Haiku prices with a conservative prompt-size estimate.
 *
 * Cases with `extendedIntents: true` exercise the protection intents that are
 * only documented when that flag is set (complaint / negotiation). That is
 * intentional: path smoke proves the *model can* classify them when wired;
 * production telephony gating is tracked separately on the graph coverage map.
 */

export interface PathSmokeCase {
  /** Must match a CriticalPath.id with pathSmokeRequired: true. */
  pathId: string;
  /** Short label for reports. */
  title: string;
  /** Caller utterance(s). Multi-turn cases run each turn and require ALL expected intents to appear. */
  turns: readonly {
    utterance: string;
    /** Primary expected intent for this turn. */
    expectedIntent: string;
    /**
     * Acceptable alternate intents (model variation). If any of
     * expectedIntent | acceptableIntents matches, the turn passes.
     */
    acceptableIntents?: readonly string[];
  }[];
  /**
   * When true, classify with extendedIntents so complaint/negotiation
   * sections are present in the prompt.
   */
  extendedIntents?: boolean;
  /**
   * When true, classify with ownerSession (owner lookup family). Default false
   * — customer session.
   */
  ownerSession?: boolean;
}

/**
 * Canonical smoke set. Order is stable for report diffs.
 *
 * Utterances are chosen to be near-canonical examples from the intent
 * classifier prompt / corpus so a healthy model should clear ≥ PATH_SMOKE_PASS_RATIO.
 */
export const PATH_SMOKE_CASES: readonly PathSmokeCase[] = [
  {
    pathId: 'book',
    title: 'Book appointment',
    turns: [
      {
        utterance:
          "Hi, this is Jane Smith. I'd like to schedule a service appointment for next Tuesday at 2pm.",
        expectedIntent: 'create_appointment',
      },
    ],
  },
  {
    pathId: 'quote',
    title: 'Grounded quote request',
    turns: [
      {
        utterance:
          'How much would it cost to install a new water heater? Can you send me an estimate?',
        expectedIntent: 'draft_estimate',
        acceptableIntents: ['create_estimate'],
      },
    ],
  },
  {
    pathId: 'invoice',
    title: 'Draft invoice for a completed job',
    turns: [
      {
        utterance:
          'Invoice the Johnson job for four hundred fifty dollars capacitor plus labor.',
        expectedIntent: 'create_invoice',
      },
    ],
  },
  {
    pathId: 'payment_chase',
    title: 'Chase unpaid invoice',
    turns: [
      {
        utterance: 'Chase the unpaid Smith invoice — send a payment reminder.',
        expectedIntent: 'send_payment_reminder',
      },
    ],
  },
  {
    pathId: 'lead_capture',
    title: 'New customer signup',
    turns: [
      {
        utterance:
          "Hi, I'm a new customer. My name is Alex Rivera, phone 555-0100. Please add me as a customer.",
        expectedIntent: 'create_customer',
        acceptableIntents: ['find_or_create_lead'],
      },
    ],
  },
  {
    pathId: 'lookup',
    title: 'Lookup next appointment',
    turns: [
      {
        utterance: "What's my next appointment?",
        expectedIntent: 'lookup_appointments',
      },
    ],
  },
  {
    pathId: 'operator_request',
    title: 'Ask for a human',
    turns: [
      {
        utterance: 'I want to speak to a real person please.',
        expectedIntent: 'operator_request',
      },
    ],
  },
  {
    pathId: 'emergency',
    title: 'Emergency language',
    turns: [
      {
        utterance: 'I smell gas in the house and I think there might be a leak!',
        expectedIntent: 'emergency_dispatch',
        // Some models route urgency to operator_request; still a handoff path.
        acceptableIntents: ['operator_request'],
      },
    ],
  },
  {
    pathId: 'negotiation',
    title: 'Price negotiation (extended intents)',
    extendedIntents: true,
    turns: [
      {
        utterance:
          'Can you knock fifty dollars off that quote or I will take my business elsewhere?',
        expectedIntent: 'negotiation',
      },
    ],
  },
  {
    pathId: 'complaint',
    title: 'File a complaint (extended intents)',
    extendedIntents: true,
    turns: [
      {
        utterance:
          'I want to file a complaint about the install last week — the workmanship was terrible.',
        expectedIntent: 'complaint',
      },
    ],
  },
  {
    pathId: 'spanish_book',
    title: 'Spanish booking request',
    turns: [
      {
        utterance:
          'Hola, quiero agendar una cita de servicio para el martes próximo a las dos de la tarde.',
        expectedIntent: 'create_appointment',
        acceptableIntents: ['language_switch'],
      },
    ],
  },
] as const;

/** Default pass ratio for the suite (fraction of cases that must pass). */
export const PATH_SMOKE_PASS_RATIO = 0.8;

/** Default cost cap in cents (~$1). Override with AGENT_PATH_SMOKE_COST_CAP_CENTS. */
export const PATH_SMOKE_DEFAULT_COST_CAP_CENTS = 100;

export function allPathSmokePathIds(): string[] {
  return [...new Set(PATH_SMOKE_CASES.map((c) => c.pathId))].sort();
}

export function allPathSmokeUtterances(): string[] {
  const out: string[] = [];
  for (const c of PATH_SMOKE_CASES) {
    for (const t of c.turns) out.push(t.utterance);
  }
  return out;
}
