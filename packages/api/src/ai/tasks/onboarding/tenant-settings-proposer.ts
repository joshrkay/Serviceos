import { createProposal, CreateProposalInput, Proposal } from '../../../proposals/proposal';
import { assessConfidence, ConfidenceMetadata } from '../../guardrails/confidence';
import { isRuntimeTimezone } from '../../../shared/timezone';
import {
  BusinessProfileExtraction,
  OnboardingTenantSettingsPayload,
  PricingExtraction,
} from './types';

export interface TenantSettingsProposerResult {
  proposal: Proposal;
  confidence: ConfidenceMetadata;
}

/**
 * B1.20 — pull the owner's hourly rate out of the pricing capture, if the
 * conversation produced one. Multiple `hourly_rate` entries can appear
 * (different services quoted at different hourly rates); we take the
 * highest-confidence one rather than guessing which is "the" rate. Returns
 * undefined (never a fabricated 0 or a guess) when no hourly_rate entry
 * exists — a wrong hourly rate is a money defect, so absence must stay
 * absence all the way to the DB column.
 */
function pickHourlyRateCents(pricing: PricingExtraction | undefined): number | undefined {
  const hourlyEntries = (pricing?.prices ?? []).filter((p) => p.priceType === 'hourly_rate');
  if (hourlyEntries.length === 0) return undefined;
  const best = hourlyEntries.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  return best.amountCents;
}

/**
 * P4-EXT-006: Generate a proposal to update tenant settings from extracted business profile.
 *
 * B1.20: also accepts the pricing extraction so the same proposal carries
 * the owner's hourly rate — see `pickHourlyRateCents`. Optional param kept
 * last so callers that have no pricing capture at all still compile; they
 * get a proposal gated on `hourlyRateCents` rather than one that silently
 * writes NULL.
 *
 * Gated on `verticalPacks`, on `hourlyRateCents`, and on `timezone` —
 * independently, and all at once when all are absent.
 *
 * `timezone` is CAPTURED first and gated only as a fallback — the opposite
 * emphasis from the two gates above, and deliberately so.
 *
 * The problem it solves is the loudest-downstream of the family: ungated and
 * unwritten, the settings card approved, executed SUCCESSFULLY, and left
 * `tenant_settings.timezone` NULL — at which point
 * `CreateAppointmentTaskHandler` (ai/tasks/create-appointment-task.ts) turns
 * EVERY spoken booking into a `voice_clarification`, deterministically,
 * because its required-timezone gate can never be satisfied.
 *
 * But a gate alone would have been the WRONG shape here, because the form
 * wizard does not ask this question either: `BusinessIdentityInputSchema`
 * documents `timezone` as "the client sends browser-detected tz", and
 * IdentityStep pre-fills a select from
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`. A wizard owner never
 * types an IANA name. Gating the conversational path unconditionally would
 * have traded a silent defect for a guaranteed extra manual step and made
 * "Talk it through" strictly worse than the form — so `knownTimezone` carries
 * the SAME browser-detected value the wizard's client already sends
 * (TurnRequest.clientTimezone), or the zone the tenant previously chose.
 *
 * What is never allowed is a value this server made up. `knownTimezone` is
 * re-validated with `isRuntimeTimezone` here rather than trusted, and an
 * absent or unrecognized one falls through to the GATE — never to a default.
 * There is no safe fallback zone: not `America/New_York` (migration 263
 * dropped exactly that column default), not the area code, and not the city
 * and state the profile extractor DID capture — Arizona is the counterexample
 * that named the Phoenix mis-booking postmortem. So the gate is what happens
 * when capture fails, and it is reachable in practice: a non-browser client
 * (telephony onboarding), a browser that reports a zone Intl does not know,
 * or a client that has not been updated to send the field.
 *
 * The `hourlyRateCents` gate closes the SILENT half of the same B1.20
 * requirement the `verticalPacks` gate closes loudly. `PricingExtractor`
 * treats any nonempty price list as a complete capture, so an owner who
 * quotes only a service-call fee or a flat per-job price ("$95 to come
 * out", "$450 for a water heater") yields prices with no
 * `price_type: 'hourly_rate'` entry, and `pickHourlyRateCents` correctly
 * returns undefined. Ungated, that proposal is approvable AND the handler
 * executes it SUCCESSFULLY (`upsertIdentityFields` simply never writes the
 * key), leaving `tenant_settings.hourly_rate_cents` NULL — which
 * `deriveOnboardingStatus` (onboarding/derive-status.ts, `isIdentityDone`)
 * requires non-null, so the owner is bounced back to the identity form
 * after a conversation that reported success. Worse than the
 * `verticalPacks` case: there the failure is visible as
 * `execution_failed`; here nothing looks wrong at all.
 *
 * The fix is a GATE, never a default: an invented hourly rate is a money
 * defect (it feeds reports/time-given-back.ts and the owner's value-of-time
 * figure). `jobBufferMinutes` may default to 30 only because that is
 * genuine parity with the wizard's own pre-filled value; a price has no
 * equivalent safe fallback. Gated whenever no rate was captured — including
 * when no pricing extraction was passed at all — because the identity step
 * requires the column unconditionally.
 *
 * An owner can describe an unsupported trade ("pool service"), or the
 * extractor can keep failing to pin a vertical down until the FSM
 * force-advances past profile_capture (agents/onboarding/transitions.ts,
 * `forcedAdvance`) — either way the business profile arrives here with
 * `verticalPacks: []` while the identity fields are perfectly good.
 * Drafting that ungated produced an APPROVABLE proposal that
 * `OnboardingTenantSettingsExecutionHandler` then always refused
 * ("Payload must include at least one valid verticalPacks entry"), so the
 * owner tapped approve and got `execution_failed` — losing the business
 * name, service area and hourly rate too, since the handler writes
 * identity and packs in one shot.
 *
 * Same idiom as the `onboarding_team_member` `email` gate
 * (orchestration/onboarding-conversation.ts): keep everything the owner
 * DID say on the payload, and mark the fields voice could not produce as
 * missing so the review card asks for them instead of inviting a tap that
 * cannot work. The handler's refusal is the correct behaviour and is
 * deliberately untouched — the two must stay in step.
 *
 * All three gate keys are REAL flat keys of the emitted payload and of
 * `onboardingTenantSettingsPayloadSchema` (proposals/contracts/onboarding.ts),
 * which is what makes them fillable: `editProposal` re-validates the merged
 * payload against that schema and then `clearSatisfiedMissingFields`
 * (proposals/missing-fields.ts) drops a gate only when that exact flat key
 * was edited to a non-empty value. A synthetic key (`hourlyRate`,
 * `pricing.hourlyRate`, `identity.timezone`) would be permanently unfillable.
 * And because the schema still applies, the gate cannot clear onto a payload
 * the handler would refuse: `verticalPacks` must be a non-empty array of
 * known verticals, `hourlyRateCents` a non-negative integer (cents), and
 * `timezone` a zone `isRuntimeTimezone` accepts — the same predicate the
 * booking handler gates on, so filling this gate cannot hand the owner a
 * different failure one layer down.
 */
export function createTenantSettingsProposal(
  tenantId: string,
  userId: string,
  extraction: BusinessProfileExtraction,
  conversationId?: string,
  pricing?: PricingExtraction,
  /**
   * The tenant's already-stored zone, else the client-detected one their
   * browser reported — the same two sources, in the same order, the wizard's
   * IdentityStep uses. Never a value this server derived.
   */
  knownTimezone?: string,
): TenantSettingsProposerResult | null {
  if (!extraction.businessName && extraction.verticalPacks.length === 0) {
    return null;
  }

  const hourlyRateCents = pickHourlyRateCents(pricing);
  // Trimmed and re-validated here rather than trusted: a stored zone can
  // predate migration 263's validation, and an unrecognized one must gate
  // (ask) rather than ride through to a payload the handler will refuse.
  const timezone =
    typeof knownTimezone === 'string' && isRuntimeTimezone(knownTimezone.trim())
      ? knownTimezone.trim()
      : undefined;

  const payload: OnboardingTenantSettingsPayload = {
    businessName: extraction.businessName ?? 'My Business',
    city: extraction.city ?? undefined,
    state: extraction.state ?? undefined,
    verticalPacks: extraction.verticalPacks
      .filter((v) => v.confidence >= 0.5)
      .map((v) => v.type),
    ...(hourlyRateCents !== undefined ? { hourlyRateCents } : {}),
    ...(timezone !== undefined ? { timezone } : {}),
  };

  if (payload.verticalPacks.length === 0 && extraction.verticalPacks.length > 0) {
    // Include low-confidence verticals if they're all we have
    payload.verticalPacks = extraction.verticalPacks.map((v) => v.type);
  }

  const confidence = assessConfidence({
    confidence_score: extraction.confidence,
    business_name: extraction.businessName,
    verticals: extraction.verticalPacks,
  });

  // The fields the identity step cannot be completed without and the
  // conversation failed to produce. Independent — an owner can arrive here
  // missing either or both. Non-empty ⇒ createProposal forces 'draft' and
  // approveProposal refuses until the operator fills them in.
  const missingFields: string[] = [];
  if (payload.verticalPacks.length === 0) missingFields.push('verticalPacks');
  // Absent (never 0, never a guess) ⇒ hourly_rate_cents would stay NULL and
  // deriveOnboardingStatus would send the owner back to the identity form.
  if (payload.hourlyRateCents === undefined) missingFields.push('hourlyRateCents');
  // Absent (never guessed from city/state/locale) ⇒ tenant_settings.timezone
  // stays NULL and every spoken booking gates as a timezone clarification.
  if (payload.timezone === undefined) missingFields.push('timezone');

  const summary = `Configure tenant: ${payload.businessName}` +
    (payload.verticalPacks.length > 0
      ? ` (${payload.verticalPacks.join(', ')})`
      : ' — which trade? (HVAC, plumbing, electrical, painting)') +
    (payload.hourlyRateCents === undefined
      ? ' — what is your hourly labor rate?'
      : '') +
    (payload.timezone === undefined
      ? ' — which timezone are you in? (e.g. America/Phoenix)'
      : '');

  const input: CreateProposalInput = {
    tenantId,
    proposalType: 'onboarding_tenant_settings',
    payload: payload as unknown as Record<string, unknown>,
    summary,
    confidenceScore: confidence.score,
    confidenceFactors: confidence.factors,
    sourceContext: conversationId ? { conversationId } : undefined,
    createdBy: userId,
    ...(missingFields.length > 0 ? { missingFields } : {}),
  };

  return { proposal: createProposal(input), confidence };
}
