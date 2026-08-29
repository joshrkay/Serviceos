/**
 * Classifier profiles — which slice of the intent taxonomy a calling surface
 * advertises (#886/#887).
 *
 * The classifier system prompt used to be one 58,158-char literal sent to
 * every surface, including inbound customer calls where 47 of its 69 intent
 * blocks describe actions the S1 surface structurally cannot execute
 * (`proposals/surface.ts` allowlist — see #887). This module reassembles the
 * prompt from the verbatim pieces in `intent-taxonomy-blocks.ts`, per
 * profile:
 *
 * - `'operator'`  — the full taxonomy, byte-identical to the original
 *                   literal (pinned by intent-taxonomy-blocks.test.ts).
 *                   Memo worker, in-app voice, chat, evals, and every caller
 *                   that does not pass a profile.
 * - `'caller'`    — anonymous / customer-resolved inbound phone call (S1).
 * - `'field_tech'`— inbound phone call from a caller-ID-resolved employee
 *                   (D-026 phone actor). Still S1 for proposals.
 * - `'owner_line'`— RV-070/071 verified owner line.
 *
 * THE PROMPT IS A HINT, NOT A GATE. Removing a block only stops advertising
 * the intent to the model; enforcement stays where it always was (the S1
 * proposal-type allowlist, the D-026 lookup RBAC, the router). The post-parse
 * guard in `classifyIntentRaw` additionally maps any off-profile
 * classification to 'unknown' before it can reach routing.
 */
import type { IntentType } from './intent-classifier';
import {
  CALIBRATION,
  CALLER_MONEY_PREAMBLE,
  DISTINCTIONS_HEADER,
  DISTINCTION_RULES,
  ENTITY_FIELDS,
  ENTITY_FIELD_VARIANTS,
  INTENT_BLOCKS,
  INTENT_BLOCK_ORDER,
  INTENT_BLOCK_VARIANTS,
  INTENT_LIST_HEADER,
  PREAMBLE_HEAD,
  SCHEMA_HEAD,
  SCHEMA_TAIL,
  TRAILING_UNKNOWN_BLOCK,
  type EntityFieldVariantTable,
  type IntentBlockVariantTable,
} from './intent-taxonomy-blocks';

// The variant tables are exported `as const` (readonly literal types, #902);
// these table-shaped views allow lookups by arbitrary intent / field key.
// Readonly-to-mutable assignment is fine here — nothing writes through them.
const intentBlockVariants: IntentBlockVariantTable = INTENT_BLOCK_VARIANTS;
const entityFieldVariants: EntityFieldVariantTable = ENTITY_FIELD_VARIANTS;

export type ClassifierProfile = 'caller' | 'field_tech' | 'owner_line' | 'operator';

/**
 * Every IntentType, in SUPPORTED_INTENTS order. Duplicated as literals here
 * because importing the runtime `SUPPORTED_INTENTS` array from
 * intent-classifier.ts would create a load-order cycle (intent-classifier
 * imports `buildClassifierSystemPrompt` from this module to define
 * SYSTEM_PROMPT). The duplication is pinned two ways: the type annotation
 * rejects any name outside the IntentType union, and
 * intent-taxonomy-blocks.test.ts asserts set-equality with the real
 * SUPPORTED_INTENTS export.
 */
const ALL_INTENTS: readonly IntentType[] = [
  'create_invoice',
  'draft_estimate',
  'create_appointment',
  'update_invoice',
  'update_estimate',
  'issue_invoice',
  'batch_invoice',
  'create_customer',
  'create_job',
  'update_job',
  'reschedule_appointment',
  'cancel_appointment',
  'reassign_appointment',
  'add_crew_member',
  'remove_crew_member',
  'add_note',
  'send_invoice',
  'send_estimate',
  'send_estimate_nudge',
  'send_payment_reminder',
  'apply_late_fee',
  'record_payment',
  'emergency_dispatch',
  'update_customer',
  'log_expense',
  'convert_lead',
  'confirm_appointment',
  'mark_lead_lost',
  'add_service_location',
  'log_time_entry',
  'notify_delay',
  'request_feedback',
  'schedule_inspection',
  'log_permit',
  'log_warranty_claim',
  'update_catalog_item',
  'record_refund',
  'apply_credit',
  'send_customer_message',
  'create_change_order',
  'create_service_agreement',
  'add_material',
  'lookup_materials',
  'lookup_crew_schedule',
  'lookup_timesheets',
  'lookup_my_day',
  'log_mileage',
  'add_catalog_item',
  'create_invoice_schedule',
  'respond_to_review',
  'create_standing_instruction',
  'update_brand_voice',
  'en_route',
  'lookup_appointments',
  'lookup_invoices',
  'lookup_balance',
  'lookup_jobs',
  'lookup_agreements',
  'lookup_account_summary',
  'lookup_customer',
  'lookup_estimates',
  'lookup_availability',
  'lookup_leads',
  'lookup_revenue',
  'lookup_catalog',
  'lookup_day_overview',
  'lookup_digest',
  'lookup_pending_items',
  'complaint',
  'negotiation',
  'lookup_job_profit',
  'language_switch',
  'operator_request',
  'confirm',
  'approve_proposal',
  'reject_proposal',
  'edit_proposal',
  'unknown',
];

/**
 * The lookups that answer about the CALLING CUSTOMER's own records
 * (session.customerId scoping). Advertised to 'caller' — the only profile
 * whose sessions carry a customerId — and excluded from 'owner_line' /
 * 'field_tech', where they are dead weight (no customer identity to scope
 * to; the owner asking about a customer's balance goes through operator
 * surfaces, not their own approval line).
 */
export const CUSTOMER_SCOPED_LOOKUP_INTENTS: ReadonlySet<IntentType> = new Set<IntentType>([
  'lookup_appointments',
  'lookup_invoices',
  'lookup_balance',
  'lookup_jobs',
  'lookup_agreements',
  'lookup_account_summary',
  'lookup_customer',
  'lookup_estimates',
]);

/**
 * Anonymous or customer-resolved inbound caller (S1). Mechanical rule:
 * an intent is advertised iff the surface can act on it —
 * INTENT_TO_PROPOSAL_TYPE lands in S1_ALLOWED_PROPOSAL_TYPES (minus
 * schedule_inspection / log_warranty_claim, which are trade-internal
 * phrasings moved to 'field_tech'), plus the customer-scoped lookups, the
 * tenant-public lookup_availability, and the conversational intents the FSM
 * intercepts (confirm / operator_request / language_switch / unknown).
 *
 * complaint / negotiation are here because the customer-protection prompt
 * section is unconditionally appended on live telephony — the post-parse
 * profile guard must not undo what that section advertises.
 *
 * emergency_dispatch is deliberately NOT advertised: on S1 its proposal type
 * is structurally coerced to voice_clarification (surface.ts) and the live
 * emergency path is the FSM's deterministic keyword matcher, which runs
 * before classification and does not need the LLM taxonomy.
 */
const CALLER_INTENTS: readonly IntentType[] = [
  'create_customer',
  'create_appointment',
  'create_job',
  'reschedule_appointment',
  'draft_estimate',
  'lookup_appointments',
  'lookup_invoices',
  'lookup_balance',
  'lookup_jobs',
  'lookup_agreements',
  'lookup_account_summary',
  'lookup_customer',
  'lookup_estimates',
  'lookup_availability',
  'confirm',
  'operator_request',
  'language_switch',
  'unknown',
  'complaint',
  'negotiation',
];

/**
 * Inbound phone call whose caller-ID resolved to an employee (D-026 phone
 * actor — session.actorUserId is stamped before the first classify). Keeps
 * the S1 capture set plus the trade-internal aliases and the actor-scoped
 * lookups D-026 authorises. No customer-scoped lookups (no
 * session.customerId on an employee call) and no protection section (a
 * technician is not a haggling customer).
 */
const FIELD_TECH_INTENTS: readonly IntentType[] = [
  'create_customer',
  'create_appointment',
  'create_job',
  'reschedule_appointment',
  'draft_estimate',
  'schedule_inspection',
  'log_warranty_claim',
  'en_route',
  'lookup_my_day',
  'lookup_materials',
  'lookup_availability',
  'confirm',
  'operator_request',
  'language_switch',
  'unknown',
];

/**
 * Which slice of the taxonomy each profile ACCEPTS — the post-parse gate's
 * authority. Used twice by design:
 * 1. `buildClassifierSystemPrompt` assembles the prompt from it (advertise =
 *    accepted ∩ the base block table; `advertisedIntentsForProfile` below is
 *    the derived, pinned view — accepted ⊇ advertised by construction).
 * 2. `classifyIntentRaw`'s post-parse guard (`isIntentAcceptedOnProfile`)
 *    maps any classification outside it to 'unknown'/'intent_off_surface'
 *    (accept) — the prompt is a hint, this set is the classifier-level gate.
 *    The guard exempts two families that own their surface behavior
 *    DOWNSTREAM of classification and must not be pre-empted by a generic
 *    clarification: read-only lookup_* (D-026's dispatch RBAC answers or
 *    refuses with purposeful copy) and the SURFACE_GUARD_EXEMPT_INTENTS set
 *    (emergency escalation, owner approval/edit hard gates).
 *
 * Section-gated intents (owner approval, protection, extended lookups) are
 * members wherever the section can be appended, so the guard never rejects
 * what a section legitimately advertised — which is why 'caller' accepts 20
 * while its base prompt advertises 18 (complaint/negotiation have no base
 * block; the always-appended protection section carries them).
 */
export const PROFILE_INTENTS: Readonly<Record<ClassifierProfile, ReadonlySet<IntentType>>> = {
  caller: new Set<IntentType>(CALLER_INTENTS),
  field_tech: new Set<IntentType>(FIELD_TECH_INTENTS),
  // Everything except the customer-scoped lookups (dead on a line with no
  // customer identity). All three prompt sections can appear on an owner
  // line, so their intents stay accepted here via ALL_INTENTS.
  owner_line: new Set<IntentType>(ALL_INTENTS.filter((i) => !CUSTOMER_SCOPED_LOOKUP_INTENTS.has(i))),
  operator: new Set<IntentType>(ALL_INTENTS),
};

/**
 * Prompt assembly is on the per-turn hot path (every classify on every
 * surface); the pieces never change at runtime, so each profile's prompt is
 * assembled once per process.
 */
const promptMemo = new Map<ClassifierProfile, string>();

/**
 * Assemble the classifier system prompt for a surface profile.
 *
 * `buildClassifierSystemPrompt('operator')` reproduces the original
 * SYSTEM_PROMPT literal BYTE-FOR-BYTE — pinned by
 * test/ai/orchestration/intent-taxonomy-blocks.test.ts (hash + length), which
 * is what keeps the 74 Layer-1 voice-quality cassettes and the gateway cache
 * keys stable. Other profiles drop the blocks, distinction rules, and entity
 * dictionary lines whose intents the profile does not advertise.
 */
export function buildClassifierSystemPrompt(profile: ClassifierProfile): string {
  const memoized = promptMemo.get(profile);
  if (memoized !== undefined) return memoized;

  const allowed = PROFILE_INTENTS[profile];
  const parts: string[] = [PREAMBLE_HEAD];
  // The caller surface advertises no money/document intents; one preamble
  // paragraph tells the model where those asks land (operator_request).
  if (profile === 'caller') parts.push(CALLER_MONEY_PREAMBLE);
  parts.push(INTENT_LIST_HEADER);
  for (const intent of INTENT_BLOCK_ORDER) {
    if (!allowed.has(intent)) continue;
    parts.push(intentBlockVariants[intent]?.[profile] ?? INTENT_BLOCKS[intent]);
  }
  // 'unknown' is in every profile; the short closing catch-all always ends
  // the list, exactly as in the original literal.
  parts.push(TRAILING_UNKNOWN_BLOCK);

  // A disambiguation rule earns its place only when EVERY intent it
  // contrasts is advertised above it.
  const rules = DISTINCTION_RULES.filter((rule) => rule.intents.every((i) => allowed.has(i)));
  if (rules.length > 0) {
    parts.push(DISTINCTIONS_HEADER);
    for (const rule of rules) parts.push(rule.text);
  }

  // Entity dictionary: keep a field line when any advertised intent extracts
  // it ('*' = generic fields kept everywhere). Lines carry no trailing comma
  // — joining here keeps the example JSON well-formed after any trim.
  parts.push(SCHEMA_HEAD);
  parts.push(
    ENTITY_FIELDS.filter((f) => f.intents === '*' || f.intents.some((i) => allowed.has(i)))
      .map((f) => entityFieldVariants[f.key]?.[profile] ?? f.line)
      .join(',\n'),
  );
  parts.push(SCHEMA_TAIL, CALIBRATION);

  const prompt = parts.join('');
  promptMemo.set(profile, prompt);
  return prompt;
}

/**
 * #902 — the intents a profile's BASE prompt actually advertises as list
 * blocks: PROFILE_INTENTS ∩ the block table, exactly the filter
 * `buildClassifierSystemPrompt` applies. DERIVED, never hand-kept, so
 * advertise-vs-accept cannot drift: accepted (PROFILE_INTENTS) ⊇ advertised
 * by construction, and the difference is exactly the intents whose prompt
 * text lives in an appended SECTION rather than a base block — for 'caller',
 * complaint/negotiation (advertised by the customer-protection section,
 * which live telephony always appends; accepted here so the guard never
 * undoes what that section advertised). Counts pinned by
 * classifier-profile.test.ts: caller 18 advertised / 20 accepted.
 */
export function advertisedIntentsForProfile(profile: ClassifierProfile): ReadonlySet<IntentType> {
  return new Set<IntentType>(INTENT_BLOCK_ORDER.filter((intent) => PROFILE_INTENTS[profile].has(intent)));
}
