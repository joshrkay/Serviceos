/**
 * Shared driver factory for the Layer 1 corpus runner.
 *
 * Wires `CassetteLLMGateway` around a script-aware mock LLM so CI can
 * replay deterministic cassettes without live API keys. Record/refresh
 * modes pass through to the same mock for `npm run voice-quality:record`.
 */
import type { LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import { LLMGateway } from '../../src/ai/gateway/gateway';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import {
  CassetteLLMGateway,
  cassetteModeFromEnv,
  defaultCassettesDir,
  type CassetteMode,
} from '../../src/ai/voice-quality/cassette-gateway';
import {
  TextModeDriver,
  type AgentDriver,
} from '../../src/ai/voice-quality/text-mode-driver';
import { buildHarnessPhoneLookups } from '../../src/ai/voice-quality/harness-lookups';
import { InMemoryAgreementRepository } from '../../src/agreements/agreement';
import { InMemoryCatalogItemRepository } from '../../src/catalog/catalog-item';
import type { DriverFactoryContext } from '../../src/ai/voice-quality/runner';
import type { VoiceQualityScript } from '../../src/ai/voice-quality/schema';
import { InMemoryOnCallRepository } from '../../src/oncall/rotation';
import { isAffirmation } from '../../src/ai/agents/customer-calling/confirm-turn';
import { fixtureEntityResolverForBundle } from '../../src/ai/voice-quality/fixture-entity-resolver';
import { corpusCallMoment, corpusTimezone } from '../../src/ai/voice-quality/layer2-world';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import type { SettingsRepository, TenantSettings } from '../../src/settings/settings';
import { estimateTokens } from '../../src/ai/gateway/tenant-quota';
import { InMemoryPackActivationRepository, activatePack } from '../../src/settings/pack-activation';
import { InMemoryVerticalPackRegistry } from '../../src/shared/vertical-pack-registry';
import { seedCanonicalVerticalPacks } from '../../src/shared/canonical-vertical-packs';
import { buildVerticalPromptResolver } from '../../src/verticals/resolve-active-pack';
import {
  buildCallerPlanContext,
  formatCallerPlanForPrompt,
} from '../../src/ai/orchestration/caller-plan-context';
import {
  hashVoiceApprovalPin,
  isEnrollablePin,
  normalizeEnrollmentPin,
  resolveVoiceApprovalPinSecret,
} from '../../src/settings/voice-approval-pin';

/** The first line of `confirmIntent`'s classify prompt (ai/skills/confirm-intent.ts). */
const CONFIRM_INTENT_PROMPT_MARKER = "Classify the caller's response as YES or NO.";

const JUDGE_PASS_JSON = JSON.stringify({
  answerMeaningMatches: true,
  softSlotsReasonable: true,
  rationale: 'vq mock judge pass',
});

/** The fixture tenant's IANA timezone (booker fixtures pin America/Los_Angeles). */
function tenantTimezone(script: VoiceQualityScript): string {
  const tz = (script.fixtures.tenant as Record<string, unknown> | undefined)?.timezone;
  return typeof tz === 'string' ? tz : 'America/Los_Angeles';
}

/**
 * Format a UTC instant as an absolute, tz-correct wall-clock phrase
 * (e.g. "May 12 2026 2:00 PM") that the deterministic resolver round-trips
 * back to exactly that instant. This is the new-contract analogue of the
 * old mock handing the task a pre-resolved ISO: the LLM only ever emits a
 * verbatim phrase, and resolveDateTime owns the timezone math.
 */
function absolutePhraseFromIso(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('month')} ${get('day')} ${get('year')} ${get('hour')}:${get('minute')} ${get('dayPeriod')}`;
}

/**
 * #1587 — the live classifier extracts the caller's own words for an
 * appointment reference ("Tuesday", "tomorrow", "the 10am"), which the shared
 * resolver turns into a visit by day or clock time (fixture-entity-resolver.ts
 * mirrors PgEntityResolver's order). The first day or time phrase in the
 * utterance stands in for that extraction; without one, the generic
 * reference stays — and resolves nothing, as it would in production.
 */
const DAY_WORD = /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const CLOCK_TIME = /\b(\d{1,2}(?::\d{2})?\s?(?:am|pm))\b/i;

function appointmentReferenceFromCaller(caller: string): string {
  const day = DAY_WORD.exec(caller);
  if (day) return day[1]!;
  const time = CLOCK_TIME.exec(caller);
  if (time) return `the ${time[1]!.replace(/\s+/g, '')}`;
  return 'the appointment';
}

/**
 * #1587 — a booking's spoken time, as the classifier would extract it
 * (`dateTimeDescription`, verbatim): "next Tuesday at 2pm", "tomorrow at
 * 10am", "Tuesday". Undefined when the utterance names no day or time, so
 * the engine asks for one (#1577).
 */
const SPOKEN_TIME =
  /\b((?:next\s+)?(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening))?(?:\s+at\s+\d{1,2}(?::\d{2})?\s?(?:am|pm)?)?)\b/i;

/** The last weekday / today / tomorrow named in the utterance ("from Tuesday to Wednesday" → Wednesday). */
function lastDayWord(caller: string): string | undefined {
  const all = [...caller.matchAll(new RegExp(DAY_WORD.source, 'gi'))];
  return all.length > 0 ? all[all.length - 1]![1] : undefined;
}

function dateTimePhraseFromCaller(caller: string): string | undefined {
  const m = SPOKEN_TIME.exec(caller);
  return m?.[1];
}

/** Extract a display name from common signup phrasing in corpus scripts. */
function displayNameFromCaller(caller: string): string | undefined {
  const m = caller.match(
    /\b(?:name is|i am|i'm|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
  );
  return m?.[1]?.trim();
}

/**
 * Scripts whose out-of-scope request the agent must hand to a human.
 * The classifier surfaces these as `operator_request` so the FSM
 * escalates (these turns pin no specific `expected.intent`).
 */
/**
 * #1600 — scripts whose caller names ANOTHER customer in the possessive and
 * whose point is what the agent does with that name; the mock emits it as
 * `customerName`, as the live classifier does.
 */
const POSSESSIVE_CUSTOMER_NAME_SCRIPTS = new Set(['cross-customer-extraction']);

const OPERATOR_REQUEST_SCRIPTS = new Set([
  'add-note-escalated',
  'payment-request-escalated',
  'update-customer-escalated',
  'vague-complaint-escalated',
]);

/**
 * #888 — token usage a classify call reports: SIZED TO THE REQUEST, using
 * the gateway's own 4-chars-per-token estimator (tenant-quota.ts), instead of
 * a fixed 10/10 that took 500 turns to reach any cap. The recorded cassette
 * therefore carries the real prompt's weight, so a prompt that grows (or a
 * profile that stops gating) moves every script's cost — and a long call
 * reaches the production session cap exactly when a live one would
 * (cost-cap-drain, #898). No per-script special case.
 */
function classifyTokenUsage(
  request: LLMRequest,
  content: string,
): { input: number; output: number; total: number } {
  const input = estimateTokens(request.messages.map((m) => m.content).join('\n'));
  const output = estimateTokens(content);
  return { input, output, total: input + output };
}

/**
 * ⚠️ CRITERION 9 IS NOT INDEPENDENTLY ASSESSED IN THIS LANE.
 *
 * The intent below is taken FROM `turn.expected.intent` — the same field the
 * disposition grader compares the observed intent against
 * (src/ai/voice-quality/graders/disposition-structured.ts, `intentMatched`).
 * The fixture's answer is fed in and then compared back to itself, so
 * `rightIntentClassified` cannot fail in the mock-driven Layer 1 corpus. A
 * green Layer 1 run is NOT evidence that intent classification works, and a
 * prompt/taxonomy regression cannot be detected here.
 *
 * What Layer 1 DOES exercise is everything downstream of classification:
 * parseClassifierJson, confidence thresholds, the turn FSM, task handlers,
 * payload contracts and the other graders. That value is real — this note is
 * only about criterion 9.
 *
 * Real assessment requires either a live model (voice-eval-live.yml — weekly
 * cron, secret-gated, not PR-blocking) or mock intents sourced independently
 * of `expected.intent`. See the fix options recorded alongside this note.
 */
function classifierJsonForTurn(script: VoiceQualityScript, turnIndex: number): string {
  const turn = script.turns[turnIndex];
  // NOTE: derived from expected.intent — see the tautology warning above.
  let intent = turn.expected.intent ?? 'unknown';
  if (OPERATOR_REQUEST_SCRIPTS.has(script.id)) intent = 'operator_request';

  const slots = (turn.expected.slots ?? {}) as Record<string, unknown>;
  const entities: Record<string, unknown> = {};
  if (intent === 'create_customer') {
    // Slots are the source of truth (same convention as proposalReference /
    // lineItemDescriptions below): the utterance-regex fallback only matches
    // "name is / I am / this is <Name>" phrasings, and an operator-style
    // "Add a new customer, <Name>, <address>" sentence defeats it — which
    // silently emitted a nameless classify response and made the handler
    // decline to draft (needs_name) on a scenario that pins create_customer.
    const name =
      (typeof slots.name === 'string' ? slots.name : undefined) ??
      displayNameFromCaller(turn.caller);
    if (name) entities.displayName = name;
    const address = typeof slots.address === 'string' ? slots.address : undefined;
    if (address) entities.address = address;
    if (script.callerId) entities.phone = script.callerId;
  }
  if (intent === 'create_appointment') {
    // #1587 — the production classifier extracts the spoken time verbatim
    // (`dateTimeDescription`); the processor resolves it in the tenant zone.
    // The absolute phrase is derived from the expected start so the resolver
    // round-trips to exactly that instant. No date in the slots → no phrase,
    // and the engine asks for one (#1577).
    const start = typeof slots.scheduledStart === 'string' ? slots.scheduledStart : undefined;
    const phrase = start
      ? absolutePhraseFromIso(start, tenantTimezone(script))
      : dateTimePhraseFromCaller(turn.caller);
    if (phrase) entities.dateTimeDescription = phrase;
  }
  if (intent === 'cancel_appointment') {
    // #1331 — the labelled slot, like every other slot-sourced entity here (a
    // caller who gives no reason is labelled with the payload's documented
    // default, 'other', which is what the live classifier lands on).
    entities.cancellationType =
      typeof slots.cancellationType === 'string' ? slots.cancellationType : 'customer_request';
    entities.appointmentReference = appointmentReferenceFromCaller(turn.caller);
  }
  // WS21b — owner approval / reject / edit. The classifier surfaces a
  // proposalReference (verbatim phrase) the approval dialogue resolves against
  // the pending set; edits additionally carry an editInstruction. The batch
  // walk is triggered deterministically by the utterance ("what's waiting"),
  // so no special entity is needed for it.
  if (intent === 'approve_proposal' || intent === 'reject_proposal') {
    entities.proposalReference =
      typeof slots.proposalReference === 'string' ? slots.proposalReference : turn.caller;
  }
  if (intent === 'edit_proposal') {
    entities.proposalReference =
      typeof slots.proposalReference === 'string' ? slots.proposalReference : 'the estimate';
    entities.editInstruction =
      typeof slots.editInstruction === 'string' ? slots.editInstruction : turn.caller;
  }
  // WS21b — grounded quoting. Voice carries line descriptions only (never an
  // LLM price); the catalog sets every price. A quantity variant ("three smoke
  // detectors") is recovered downstream by parseLeadingQuantity.
  if (intent === 'draft_estimate' || intent === 'create_invoice') {
    const descs = slots.lineItemDescriptions;
    if (Array.isArray(descs)) {
      entities.lineItemDescriptions = descs.filter((d): d is string => typeof d === 'string');
    }
  }
  if (intent === 'reschedule_appointment') {
    entities.appointmentReference = appointmentReferenceFromCaller(turn.caller);
    // New contract: the reschedule handler resolves this phrase against the
    // tenant tz + clock. Derive an absolute phrase from the expected new
    // start so the resolver round-trips back to it.
    const newStart = typeof slots.newScheduledStart === 'string' ? slots.newScheduledStart : undefined;
    // #1587 — "Wednesday at the same time" stays the caller's phrase: the
    // processor's reschedule rule (#1540 §1) reads the resolved appointment's
    // window for it, which an absolute phrase would bypass.
    const sameTime = /\bsame time\b/i.test(turn.caller) ? lastDayWord(turn.caller) : undefined;
    entities.newDateTimeDescription = sameTime
      ? `${sameTime} at the same time`
      : newStart
        ? absolutePhraseFromIso(newStart, tenantTimezone(script))
        : 'the requested new time';
  }
  // Full-app voice coverage intents — surface the entities each task
  // handler needs so the proposal payload is well-formed. Values are
  // drawn from the turn's expected slots where present, with sensible
  // defaults so a script can pin just the intent + proposalType.
  if (intent === 'update_customer') {
    if (typeof slots.phone === 'string') entities.updatedPhone = slots.phone;
    if (typeof slots.email === 'string') entities.updatedEmail = slots.email;
    if (typeof slots.name === 'string') entities.updatedName = slots.name;
    if (typeof slots.address === 'string') entities.updatedAddress = slots.address;
    if (
      !entities.updatedPhone &&
      !entities.updatedEmail &&
      !entities.updatedName &&
      !entities.updatedAddress
    ) {
      entities.updatedPhone = '+15555550199';
    }
  }
  if (intent === 'log_expense') {
    entities.amount = typeof slots.amountCents === 'number' ? slots.amountCents : 24000;
    entities.expenseCategory = typeof slots.category === 'string' ? slots.category : 'materials';
    if (typeof slots.vendor === 'string') entities.vendor = slots.vendor;
  }
  if (intent === 'convert_lead') {
    entities.leadReference = typeof slots.leadReference === 'string'
      ? slots.leadReference
      : 'the lead on this call';
  }
  if (intent === 'confirm_appointment') {
    entities.appointmentReference = typeof slots.appointmentReference === 'string'
      ? slots.appointmentReference
      : appointmentReferenceFromCaller(turn.caller);
  }
  if (intent === 'mark_lead_lost') {
    entities.leadReference = typeof slots.leadReference === 'string'
      ? slots.leadReference
      : 'the lead on this call';
    if (typeof slots.reason === 'string') entities.lostReason = slots.reason;
  }
  if (intent === 'add_service_location') {
    entities.serviceAddress = typeof slots.serviceAddress === 'string'
      ? slots.serviceAddress
      : '412 Oak Street';
  }
  if (intent === 'log_time_entry') {
    entities.timeEntryType = typeof slots.entryType === 'string' ? slots.entryType : 'job';
  }
  if (intent === 'notify_delay') {
    entities.appointmentReference = typeof slots.appointmentReference === 'string'
      ? slots.appointmentReference
      : appointmentReferenceFromCaller(turn.caller);
    if (typeof slots.delayMinutes === 'number') entities.delayMinutes = slots.delayMinutes;
  }
  if (intent === 'request_feedback') {
    if (typeof slots.jobReference === 'string') entities.jobReference = slots.jobReference;
  }
  // Tradesperson wave 1 (2026-08-07 plan), final-verification corpus
  // additions — record_refund / apply_credit / create_change_order /
  // add_material extraction fields (see intent-classifier.ts's
  // ExtractedEntities doc comments for the field-name rationale). These
  // four scripts name no job, so no `jobReference` is emitted for them (the
  // fixture resolver is wired, #1587; a reference that resolved nothing
  // would land the proposal on `missingFields` instead of a clean draft).
  // The corpus scripts pin only the extractable fields in `expected.slots`.
  if (intent === 'record_refund') {
    if (typeof slots.amountCents === 'number') entities.amount = slots.amountCents;
    entities.refundMethod = typeof slots.refundMethod === 'string' ? slots.refundMethod : 'cash';
    if (typeof slots.refundReason === 'string') entities.refundReason = slots.refundReason;
  }
  if (intent === 'apply_credit') {
    if (typeof slots.amountCents === 'number') entities.amount = slots.amountCents;
    if (typeof slots.creditReason === 'string') entities.creditReason = slots.creditReason;
  }
  if (intent === 'create_change_order') {
    if (typeof slots.amountCents === 'number') entities.amount = slots.amountCents;
    entities.changeOrderDescription =
      typeof slots.changeOrderDescription === 'string' ? slots.changeOrderDescription : 'the added work';
  }
  if (intent === 'add_material') {
    entities.materialDescription =
      typeof slots.description === 'string' ? slots.description : 'materials for the shopping list';
    if (typeof slots.quantity === 'number') entities.materialQuantity = slots.quantity;
  }
  // create_service_agreement / send_customer_message are CUSTOMER_REF
  // intents resolved via the caller's own verified identity (same
  // mechanism update_customer/log_expense already rely on in this
  // harness — a "known customer" callerId resolves `context.customerId`
  // directly, no free-text customerName lookup needed).
  if (intent === 'create_service_agreement') {
    entities.serviceAgreementName =
      typeof slots.name === 'string' ? slots.name : 'Annual maintenance plan';
    entities.serviceAgreementCadence =
      typeof slots.recurrenceRule === 'string' ? slots.recurrenceRule : 'monthly';
    if (typeof slots.priceCents === 'number') entities.amount = slots.priceCents;
    entities.serviceAgreementStartsOn =
      typeof slots.startsOn === 'string' ? slots.startsOn : 'next month';
  }
  if (intent === 'send_customer_message') {
    entities.customerMessageBody =
      typeof slots.body === 'string' ? slots.body : 'Your part arrived — we can come by Thursday morning.';
    entities.customerMessageChannel =
      typeof slots.channel === 'string' ? slots.channel : 'sms';
  }
  // B8.10 — send_estimate_nudge's reference resolution reads
  // customerName/jobReference off entitiesFrom(context) exactly like
  // send_estimate/send_invoice. `slots.customerName` is NOT reused here for
  // the extraction hint (unlike most other branches) because the disposition-
  // structured grader (graders/disposition-structured.ts) diffs
  // `expected.slots` against the drafted proposal's PAYLOAD — a short,
  // whitespace-free string counts as a hard slot (`looksLikeEnum`), so a
  // script pinning `customerName` there would spuriously require it on the
  // payload, which SendEstimateNudgeTaskHandler resolves INTO `estimateId`
  // and never carries verbatim. Mirrors `add_service_location`'s
  // slots-optional-with-a-fixed-fallback convention just above.
  if (intent === 'send_estimate_nudge') {
    entities.customerName = typeof slots.customerReference === 'string' ? slots.customerReference : 'Khan';
  }
  // #1600 — the live classifier extracts a customer the caller names in the
  // possessive ("what's Jane Doe's balance?") as `customerName`; for the
  // scripts that opt in (POSSESSIVE_CUSTOMER_NAME_SCRIPTS) the first
  // "First Last's" in the utterance stands in for that extraction. Opt-in,
  // not a corpus-wide heuristic: a script must not silently acquire an
  // entity the live classifier may not emit.
  if (POSSESSIVE_CUSTOMER_NAME_SCRIPTS.has(script.id) && entities.customerName === undefined) {
    const possessive = turn.caller.match(/\b([A-Z][a-z]+ [A-Z][a-z]+)'s\b/);
    if (possessive) entities.customerName = possessive[1];
  }
  return JSON.stringify({
    intentType: intent,
    confidence: 0.95,
    reasoning: 'voice-quality mock classifier',
    ...(Object.keys(entities).length > 0 ? { extractedEntities: entities } : {}),
  });
}

/** Find the script turn whose caller text appears in an LLM user message. */
function turnIndexForUserMessage(script: VoiceQualityScript, userLine: string): number {
  const idx = script.turns.findIndex(
    (t) => userLine.includes(t.caller) || t.caller.includes(userLine),
  );
  return idx >= 0 ? idx : 0;
}

/**
 * WS21b — estimate-extraction JSON for the grounded-quote scenarios. The LLM
 * only ever emits line DESCRIPTIONS (+ a placeholder unitPrice the catalog
 * overrides); the fixture's `slots.lineItemDescriptions` are the source, so a
 * quantity variant ("three smoke detectors") flows through verbatim for
 * `parseLeadingQuantity` to recover downstream.
 */
function draftEstimateJsonForTurn(script: VoiceQualityScript, turnIndex: number): string {
  const slots = (script.turns[turnIndex]?.expected.slots ?? {}) as Record<string, unknown>;
  const descs = Array.isArray(slots.lineItemDescriptions)
    ? slots.lineItemDescriptions.filter((d): d is string => typeof d === 'string')
    : [];
  return JSON.stringify({
    summary: 'Voice estimate',
    confidence_score: 0.9,
    lineItems: descs.map((description) => ({ description, unitPrice: 1 })),
  });
}

/**
 * Mock gateway that returns script-appropriate classifier + judge JSON.
 * Used as the "real" gateway inside `CassetteLLMGateway` record mode.
 */
export class ScriptAwareMockGateway extends LLMGateway {
  constructor(
    private readonly script: VoiceQualityScript,
    private readonly inner: LLMGateway,
  ) {
    super({ defaultProvider: 'mock' }, new Map());
  }

  override async complete(request: LLMRequest): Promise<LLMResponse> {
    if (request.taskType === 'voice_quality_judge') {
      return {
        content: JUDGE_PASS_JSON,
        model: 'mock-model',
        provider: 'mock',
        latencyMs: 1,
        tokenUsage: { input: 10, output: 10, total: 20 },
      };
    }

    if (request.taskType === 'classify_intent') {
      const userLine = request.messages.find((m) => m.role === 'user')?.content ?? '';
      const idx = turnIndexForUserMessage(this.script, userLine);
      // #1587 — the yes/no model behind the phone readback (`confirmIntent`,
      // same task type, its own prompt): the scripted answer is a yes when it
      // reads as one. The production fallback for an unreachable model is the
      // same deterministic rule, so the mock never says more than the rule.
      if (userLine.includes(CONFIRM_INTENT_PROMPT_MARKER)) {
        const answer = isAffirmation(this.script.turns[idx]?.caller ?? '') ? 'yes' : 'no';
        const content = JSON.stringify({ answer, reasoning: 'voice-quality mock yes/no' });
        return {
          content,
          model: request.model ?? 'mock-model',
          provider: 'mock',
          latencyMs: 1,
          tokenUsage: classifyTokenUsage(request, content),
        };
      }
      const content = classifierJsonForTurn(this.script, idx);
      return {
        content,
        model: request.model ?? 'mock-model',
        provider: 'mock',
        latencyMs: 1,
        tokenUsage: classifyTokenUsage(request, content),
      };
    }

    // WS21b — grounded-quote extraction. The estimate handler asks the LLM to
    // turn the caller's spoken descriptions into line items; the catalog then
    // OVERRIDES every price (voice never trusts an LLM number). We emit the
    // fixture's line descriptions with a placeholder unitPrice so the catalog
    // grounding is what sets the real price.
    if (request.taskType === 'draft_estimate') {
      const userLine = request.messages.find((m) => m.role === 'user')?.content ?? '';
      const idx = turnIndexForUserMessage(this.script, userLine);
      return {
        content: draftEstimateJsonForTurn(this.script, idx),
        model: request.model ?? 'mock-model',
        provider: 'mock',
        latencyMs: 1,
        tokenUsage: { input: 10, output: 10, total: 20 },
      };
    }

    // Tradesperson wave 1 — SendCustomerMessageTaskHandler's OWN second
    // gateway call (message-rewrite pass, `send-customer-message-task.ts`
    // `rewrite()`), separate from the classify_intent call above. Without
    // this branch it falls through to the generic mock below and the
    // drafted body would be whatever placeholder that returns rather than
    // a realistic customer-facing message.
    if (request.taskType === 'send_customer_message') {
      return {
        content: 'Your part arrived — we can come by Thursday morning.',
        model: request.model ?? 'mock-model',
        provider: 'mock',
        latencyMs: 1,
        tokenUsage: { input: 10, output: 10, total: 20 },
      };
    }

    return this.inner.complete(request);
  }
}

export function buildCassetteGatewayForScript(
  script: VoiceQualityScript,
  mode?: CassetteMode,
): LLMGateway {
  const { gateway: inner } = createMockLLMGateway();
  const realGateway = new ScriptAwareMockGateway(script, inner);
  return new CassetteLLMGateway({
    scriptId: script.id,
    cassettesDir: defaultCassettesDir(),
    mode: mode ?? cassetteModeFromEnv(),
    realGateway,
  });
}

/**
 * #897 — the corpus tenant's vertical prompt resolver, built exactly as app.ts
 * builds production's (`buildVerticalPromptResolver` over the pack-activation
 * repo + the seeded canonical registry). The tenant activates the pack its
 * fixture names (`fixtures.tenant.verticalPack`), defaulting to `hvac-v1` —
 * every corpus tenant is an HVAC shop. `null` opts a script out (no pack).
 */
function corpusVerticalPromptResolver(
  script: VoiceQualityScript,
  tenantId: string,
): ((tenantId: string) => Promise<string | undefined>) | undefined {
  const tenant = (script.fixtures.tenant ?? {}) as Record<string, unknown>;
  const packId = tenant.verticalPack === undefined ? 'hvac-v1' : tenant.verticalPack;
  if (typeof packId !== 'string') return undefined;
  const canonicalPackRegistry = new InMemoryVerticalPackRegistry();
  const packActivationRepo = new InMemoryPackActivationRepository();
  const resolver = buildVerticalPromptResolver({
    packActivationRepo,
    canonicalPackRegistry,
    cacheTtlMs: 0,
  });
  const ready = (async () => {
    await seedCanonicalVerticalPacks(canonicalPackRegistry);
    await activatePack({ tenantId, packId }, packActivationRepo);
  })();
  return async (t: string) => {
    await ready;
    return resolver(t);
  };
}

export function makeVoiceQualityDriverFactory(
  script: VoiceQualityScript,
  cassetteMode?: CassetteMode,
): (fctx: DriverFactoryContext) => AgentDriver {
  return (fctx) => {
    const store = new VoiceSessionStore({ startInterval: false });
    const gateway =
      fctx.gateway ?? buildCassetteGatewayForScript(script, cassetteMode);

    const tenant = (script.fixtures.tenant ?? {}) as Record<string, unknown>;

    // Seed an on-call rotation so escalateToHuman can always find a
    // dispatcher (and therefore emit escalation_triggered).
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([[fctx.tenantId, [{ id: 'oncall_vq', userId: 'dispatcher_vq', orderIndex: 0 }]]]),
    );

    // Seed a settings row carrying timezone + business-hours schedule (the
    // processor reads both for spoken-time resolution and lane evaluation);
    // the clock is pinned to the fixture's call moment for determinism.
    const businessHours = tenant.businessHours as
      | { timezone?: string; schedule?: unknown; callMomentLocal?: string }
      | undefined;
    // Build the row when the fixture defines business hours OR a tenant
    // timezone, so the scheduling resolver can thread the tenant zone even
    // for booker fixtures that pin only `tenant.timezone`.
    const tenantTz = typeof tenant.timezone === 'string' ? tenant.timezone : undefined;
    // WS21b — owner-approval wiring. The owner phone lets the driver stamp an
    // ownerSession via the production caller-ID match; the (optional) PIN is
    // hashed at rest exactly as the settings route does (HMAC, tenant-salted)
    // so a money-class approval script exercises the real challenge.
    const ownerPhone = typeof tenant.ownerPhone === 'string' ? tenant.ownerPhone : undefined;
    const voiceApprovalPin =
      typeof tenant.voiceApprovalPin === 'string' ? tenant.voiceApprovalPin : undefined;
    let escalationSettings: { voice_approval_pin_hash: string } | undefined;
    if (voiceApprovalPin && isEnrollablePin(voiceApprovalPin)) {
      // The runtime verify seam (readChallengeState) resolves the HMAC key
      // from env, so the hash MUST use that same key. Default a harness key
      // when none is configured so the challenge verifies deterministically.
      if (!resolveVoiceApprovalPinSecret()) {
        process.env.TENANT_ENCRYPTION_KEY = 'vq-harness-pin-secret';
      }
      const pinSecret = resolveVoiceApprovalPinSecret()!;
      escalationSettings = {
        voice_approval_pin_hash: hashVoiceApprovalPin(
          normalizeEnrollmentPin(voiceApprovalPin),
          fctx.tenantId,
          pinSecret,
        ),
      };
    }
    // #1567 — the tenant's service area (tenant_settings.service_area_zips)
    // from `fixtures.tenant.serviceArea.zipCodes`.
    const serviceAreaZips = (tenant.serviceArea as { zipCodes?: unknown } | undefined)?.zipCodes;
    const zipList = Array.isArray(serviceAreaZips)
      ? serviceAreaZips.filter((z): z is string => typeof z === 'string')
      : undefined;
    const settingsRow =
      businessHours || tenantTz || ownerPhone || escalationSettings || zipList
        ? ({
            tenantId: fctx.tenantId,
            timezone: businessHours?.timezone ?? tenantTz ?? 'America/Los_Angeles',
            businessHoursSchedule: businessHours?.schedule ?? [],
            ...(ownerPhone ? { ownerPhone } : {}),
            ...(escalationSettings ? { escalationSettings } : {}),
            ...(zipList ? { serviceAreaZips: zipList } : {}),
            // #890 — the tenant's greeting language + supported stack
            // (tenant_settings.default_language / supported_languages), so a
            // Spanish tenant's call is classified as Spanish.
            ...(tenant.default_language === 'es' || tenant.default_language === 'en'
              ? { defaultLanguage: tenant.default_language }
              : {}),
            ...(Array.isArray(tenant.supported_languages)
              ? { supportedLanguages: tenant.supported_languages }
              : {}),
          } as unknown as TenantSettings)
        : null;
    // Tooling fix (2026-08-09) — `SettingsRepository` grew
    // `upsertIdentityFields` (PUT /api/onboarding/identity + the
    // conversational onboarding execution handlers) after this hand-rolled
    // stub was written, and the object literal below never got the new
    // method. `ts-node`'s full typecheck rejects that (`error TS2741:
    // Property 'upsertIdentityFields' is missing`) while vitest's esbuild
    // transform does not typecheck at all, which is why it only ever
    // surfaced when running a script directly via `ts-node` (e.g.
    // scripts/seed-voice-quality-cassettes.ts).
    //
    // Review follow-up N5: the first fix threw from the new method. Safe,
    // but `InMemorySettingsRepository` (src/settings/settings.ts) already
    // implements it for real, so DELEGATION is strictly better — a future
    // onboarding corpus script gets working behavior instead of a crash,
    // and the next `SettingsRepository` method addition breaks `ts-node`
    // again unless it is also delegated. The bespoke overrides above it stay
    // because the corpus needs a settings row synthesized from SCRIPT
    // FIXTURES (business hours, tenant tz, owner phone, escalation config),
    // which no repository can invent.
    const delegate = new InMemorySettingsRepository();
    const settingsRepo: SettingsRepository = {
      findByTenant: async (t: string) => (t === fctx.tenantId ? settingsRow : null),
      create: async (s: TenantSettings) => s,
      update: async () => settingsRow,
      incrementEstimateNumber: async () => 1,
      incrementInvoiceNumber: async () => 1,
      upsertIdentityFields: (tenantId, fields) => delegate.upsertIdentityFields(tenantId, fields),
      ensureActiveVerticalPack: (tenantId, packId, bootstrapAiModel) =>
        delegate.ensureActiveVerticalPack(tenantId, packId, bootstrapAiModel),
    };
    // #1587 — the corpus is authored in a pinned world (Friday 2026-05-01, or a
    // script's own call moment). Every script runs on that clock, as Layer 2
    // does (`corpusCallMoment`): an appointment reference resolves against
    // "upcoming" visits, and a booking date is deterministic.
    const callMoment = corpusCallMoment(script);
    const now = (): Date => callMoment;

    // WS21b — seed the tenant catalog from `fixtures.catalog` so a
    // grounded-quote script resolves spoken line items against real catalog
    // prices (closes the WS17 quoting-scenario gap). Empty when the fixture
    // declares none — the estimate path then falls back to the generic
    // confirmation, exactly as before.
    const catalogRepo = new InMemoryCatalogItemRepository();
    const catalogFixtures = (script.fixtures as { catalog?: unknown[] }).catalog;
    if (Array.isArray(catalogFixtures)) {
      for (const item of catalogFixtures) {
        void catalogRepo.create(item as Parameters<InMemoryCatalogItemRepository['create']>[0]);
      }
    }

    // #897 — one agreement repo for the lookup bundle AND the caller-plan
    // resolver (app.ts shares one too), so a plan a lookup can see is the
    // plan the classifier is told about.
    const agreementRepo = new InMemoryAgreementRepository();

    const driver = new TextModeDriver({
      voiceSessionStore: store,
      bus: fctx.bus,
      gateway,
      proposalRepo: fctx.repos.proposalRepo,
      customerRepo: fctx.repos.customerRepo,
      appointmentRepo: fctx.repos.appointmentRepo,
      invoiceRepo: fctx.repos.invoiceRepo,
      estimateRepo: fctx.repos.estimateRepo,
      jobRepo: fctx.repos.jobRepo,
      leadRepo: fctx.repos.leadRepo,
      auditRepo: fctx.repos.auditRepo,
      catalogRepo,
      // #1604 — seeded team members: a technician's caller-ID resolves to the
      // phone actor through the production resolver.
      userRepo: fctx.repos.userRepo,
      // #869 — the shared lookup bundle, same shape the live phone takes,
      // built from the repos the runner already seeded for this script's
      // fixtures. #1395 — the SAME builder Layer 2 wires, so the two lanes
      // cannot drift on which repos a skill gets.
      lookups: buildHarnessPhoneLookups(fctx.repos, {
        agreementRepo,
        catalogRepo,
        settingsRepo,
        now,
      }),
      // #1540 §1 / #1587 — the shared fixture resolver over the runner's seeded
      // bundle (the same one Layer 2 wires), in the corpus zone and clock, so a
      // spoken appointment / invoice reference resolves the way production's
      // PgEntityResolver resolves it instead of staying free text.
      entityResolver: fixtureEntityResolverForBundle(fctx.repos, {
        tenantId: fctx.tenantId,
        timezone: corpusTimezone(script),
        now,
      }),
      // #897 — the prompt-section resolvers production wires (app.ts).
      verticalPromptResolver: corpusVerticalPromptResolver(script, fctx.tenantId),
      callerPlanResolver: async (tenantId: string, customerId: string) => {
        const section = formatCallerPlanForPrompt(
          await buildCallerPlanContext(tenantId, customerId, agreementRepo),
        );
        return section.length > 0 ? section : undefined;
      },
      onCallRepo,
      settingsRepo,
      now,
      systemActorId: 'system:vq-corpus',
    });

    return {
      startSession: (opts) => driver.startSession(opts),
      speak: (sid, t) => driver.speak(sid, t),
      hangup: (sid) => driver.hangup(sid),
      endSession: async (sid) => {
        await driver.endSession(sid);
        store.dispose();
      },
    };
  };
}
