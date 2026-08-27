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
  vqResolveMemberRole,
  type AgentDriver,
} from '../../src/ai/voice-quality/text-mode-driver';
import { InMemoryMoneyDashboardRepository } from '../../src/reports/money-dashboard';
import { InMemoryAgreementRepository } from '../../src/agreements/agreement';
import { InMemoryCatalogItemRepository } from '../../src/catalog/catalog-item';
import type { DriverFactoryContext } from '../../src/ai/voice-quality/runner';
import type { VoiceQualityScript } from '../../src/ai/voice-quality/schema';
import { InMemoryOnCallRepository } from '../../src/oncall/rotation';
import { InMemoryDncRepository, normalizePhone } from '../../src/compliance/dnc';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import type { SettingsRepository, TenantSettings } from '../../src/settings/settings';
import {
  hashVoiceApprovalPin,
  isEnrollablePin,
  normalizeEnrollmentPin,
  resolveVoiceApprovalPinSecret,
} from '../../src/settings/voice-approval-pin';

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

/** True when any turn expects a booking intent (drives the pinned clock). */
function scriptBooksAppointment(script: VoiceQualityScript): boolean {
  return script.turns.some(
    (t) =>
      t.expected.intent === 'create_appointment' ||
      t.expected.intent === 'reschedule_appointment',
  );
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
const OPERATOR_REQUEST_SCRIPTS = new Set([
  'add-note-escalated',
  'payment-request-escalated',
  'update-customer-escalated',
  'vague-complaint-escalated',
]);

/** Token usage a classify call reports, per script (drives the cost cap). */
function classifyTokenUsage(script: VoiceQualityScript): { input: number; output: number; total: number } {
  // The chatty caller burns output tokens each turn until the per-session
  // telephony cap (1500 output tokens) trips on the 6th turn.
  if (script.id === 'cost-cap-drain') return { input: 0, output: 260, total: 260 };
  return { input: 10, output: 10, total: 20 };
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
  if (script.id === 'cost-cap-drain') intent = 'lookup_account_summary';

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
  if (intent === 'cancel_appointment') {
    entities.cancellationType = 'customer_request';
    entities.appointmentReference = 'the appointment';
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
    entities.appointmentReference = 'the appointment';
    // New contract: the reschedule handler resolves this phrase against the
    // tenant tz + clock. Derive an absolute phrase from the expected new
    // start so the resolver round-trips back to it.
    const newStart = typeof slots.newScheduledStart === 'string' ? slots.newScheduledStart : undefined;
    entities.newDateTimeDescription = newStart
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
      : 'the appointment';
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
      : 'the appointment';
    if (typeof slots.delayMinutes === 'number') entities.delayMinutes = slots.delayMinutes;
  }
  if (intent === 'request_feedback') {
    if (typeof slots.jobReference === 'string') entities.jobReference = slots.jobReference;
  }
  // Tradesperson wave 1 (2026-08-07 plan), final-verification corpus
  // additions — record_refund / apply_credit / create_change_order /
  // add_material extraction fields (see intent-classifier.ts's
  // ExtractedEntities doc comments for the field-name rationale). This
  // harness wires no `entityResolver` (see runner.ts's `makeRepoBundle` —
  // no job/invoice fuzzy-match dep exists here), so `jobReference` free
  // text is deliberately omitted from the mock's entities for these four:
  // it would stay unresolved and land the proposal on `missingFields`
  // instead of a clean happy-path draft. The corpus scripts therefore pin
  // only the extractable-without-resolution fields in `expected.slots`.
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
 * Appointment-extraction JSON (new hybrid contract): the LLM emits a
 * verbatim `dateTimePhrase`, NOT ISO. We derive an absolute, tz-correct
 * phrase from the expected start so the deterministic resolver reproduces
 * exactly that instant; `durationMinutes` preserves the prior 2h window so
 * any fixture pinning `scheduledEnd` still matches. No date in the slots →
 * empty phrase, which the task turns into a clarification.
 */
function appointmentJsonForTurn(script: VoiceQualityScript, turnIndex: number): string {
  const slots = (script.turns[turnIndex].expected.slots ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { summary: 'Service appointment', confidence_score: 0.95 };
  const start = typeof slots.scheduledStart === 'string' ? slots.scheduledStart : undefined;
  if (start) {
    out.dateTimePhrase = absolutePhraseFromIso(start, tenantTimezone(script));
    out.durationMinutes = 120;
  } else {
    out.dateTimePhrase = '';
  }
  return JSON.stringify(out);
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
      return {
        content: classifierJsonForTurn(this.script, idx),
        model: request.model ?? 'mock-model',
        provider: 'mock',
        latencyMs: 1,
        tokenUsage: classifyTokenUsage(this.script),
      };
    }

    if (request.taskType === 'create_appointment') {
      const userLine = request.messages.find((m) => m.role === 'user')?.content ?? '';
      const idx = turnIndexForUserMessage(this.script, userLine);
      return {
        content: appointmentJsonForTurn(this.script, idx),
        model: request.model ?? 'mock-model',
        provider: 'mock',
        latencyMs: 1,
        tokenUsage: { input: 10, output: 10, total: 20 },
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

    // Seed the DNC list from the tenant fixture.
    const dncRepo = new InMemoryDncRepository();
    const dnc = tenant.dnc as { list?: string[] } | undefined;
    if (dnc?.list) {
      for (const phone of dnc.list) dncRepo.add(fctx.tenantId, normalizePhone(phone));
    }

    // Seed a settings row carrying timezone + business-hours schedule so
    // enforceCompliance can evaluate after-hours; the clock is pinned to
    // the fixture's call moment for determinism.
    // Always provide a settings repo so the compliance gate (DNC +
    // business hours) runs for every script. The row carries a
    // business-hours schedule only when the fixture defines one;
    // otherwise findByTenant returns null and after-hours never trips.
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
    const settingsRow =
      businessHours || tenantTz || ownerPhone || escalationSettings
        ? ({
            tenantId: fctx.tenantId,
            timezone: businessHours?.timezone ?? tenantTz ?? 'America/Los_Angeles',
            businessHoursSchedule: businessHours?.schedule ?? [],
            ...(ownerPhone ? { ownerPhone } : {}),
            ...(escalationSettings ? { escalationSettings } : {}),
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
    };
    let now: (() => Date) | undefined;
    if (businessHours?.callMomentLocal) {
      const fixed = new Date(businessHours.callMomentLocal);
      now = () => fixed;
    } else if (scriptBooksAppointment(script)) {
      // Pin the scheduling clock before all corpus booking dates so the
      // deterministic resolver accepts the (fixed, past-relative-to-real-now)
      // expected dates. Only booking scripts are pinned — others keep
      // wall-clock to avoid shifting unrelated expectations.
      const fixed = new Date('2026-05-01T12:00:00.000Z');
      now = () => fixed;
    }

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
      // #869 — the shared lookup bundle, same shape the live phone's Gather
      // adapter takes. Built from the repos the runner already seeded for this
      // script's fixtures, plus the two the bundle needs and the RepoBundle
      // does not own (agreements, money dashboard). Nothing here is a lookup
      // switch: `answerPhoneLookup` → `executeLookupAnswer` owns dispatch.
      lookups: {
        answers: {
          invoiceRepo: fctx.repos.invoiceRepo,
          estimateRepo: fctx.repos.estimateRepo,
          leadRepo: fctx.repos.leadRepo,
          agreementRepo: new InMemoryAgreementRepository(),
          moneyDashboardRepo: new InMemoryMoneyDashboardRepository(),
          catalogRepo,
          settingsRepo,
          // Harness-owned actor → role seam (decision 3). No `users` fixtures
          // exist (or are needed) — the owner-line flag is the corpus's
          // identity vocabulary.
          resolveMemberRole: vqResolveMemberRole,
        },
        shared: {
          jobRepo: fctx.repos.jobRepo,
          appointmentRepo: fctx.repos.appointmentRepo,
          customerRepo: fctx.repos.customerRepo,
          proposalRepo: fctx.repos.proposalRepo,
          // No `availabilityFinder`: with an appointmentRepo wired the shared
          // dispatch takes the business-hours-aware `lookupBookableAvailability`
          // path (F2), exactly as the live phone does, and the finder would be
          // dead wiring.
        },
        // Spoken dates render in the script's tenant zone, as they do on the
        // phone. Failure-soft by contract in the adapter.
        tenantTimezoneResolver: async (t: string) =>
          (await settingsRepo.findByTenant(t))?.timezone,
        ...(now ? { now } : {}),
      },
      onCallRepo,
      dncRepo,
      settingsRepo,
      ...(now ? { now } : {}),
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
