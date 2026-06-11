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
import { TextModeDriver, type AgentDriver } from '../../src/ai/voice-quality/text-mode-driver';
import { InMemoryMoneyDashboardRepository } from '../../src/reports/money-dashboard';
import { InMemoryCatalogItemRepository } from '../../src/catalog/catalog-item';
import { DefaultAvailabilityFinder } from '../../src/ai/tasks/availability-finder';
import type { DriverFactoryContext } from '../../src/ai/voice-quality/runner';
import type { VoiceQualityScript } from '../../src/ai/voice-quality/schema';
import { InMemoryOnCallRepository } from '../../src/oncall/rotation';
import { InMemoryDncRepository, normalizePhone } from '../../src/compliance/dnc';
import type { SettingsRepository, TenantSettings } from '../../src/settings/settings';

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

function classifierJsonForTurn(script: VoiceQualityScript, turnIndex: number): string {
  const turn = script.turns[turnIndex];
  let intent = turn.expected.intent ?? 'unknown';
  if (OPERATOR_REQUEST_SCRIPTS.has(script.id)) intent = 'operator_request';
  if (script.id === 'cost-cap-drain') intent = 'lookup_account_summary';

  const slots = (turn.expected.slots ?? {}) as Record<string, unknown>;
  const entities: Record<string, unknown> = {};
  if (intent === 'create_customer') {
    const name = displayNameFromCaller(turn.caller);
    if (name) entities.displayName = name;
    if (script.callerId) entities.phone = script.callerId;
  }
  if (intent === 'cancel_appointment') {
    entities.cancellationType = 'customer_request';
    entities.appointmentReference = 'the appointment';
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

/** Reschedule-extraction JSON: new ISO datetimes from the turn's expected slots. */
function rescheduleJsonForTurn(script: VoiceQualityScript, turnIndex: number): string {
  const slots = (script.turns[turnIndex].expected.slots ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { confidence_score: 0.95 };
  if (typeof slots.newScheduledStart === 'string') out.newScheduledStart = slots.newScheduledStart;
  if (typeof slots.newScheduledEnd === 'string') out.newScheduledEnd = slots.newScheduledEnd;
  return JSON.stringify(out);
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

    if (request.taskType === 'reschedule_appointment') {
      const userLine = request.messages.find((m) => m.role === 'user')?.content ?? '';
      const idx = turnIndexForUserMessage(this.script, userLine);
      return {
        content: rescheduleJsonForTurn(this.script, idx),
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
    const settingsRow =
      businessHours || tenantTz
        ? ({
            tenantId: fctx.tenantId,
            timezone: businessHours?.timezone ?? tenantTz ?? 'America/Los_Angeles',
            businessHoursSchedule: businessHours?.schedule ?? [],
          } as unknown as TenantSettings)
        : null;
    const settingsRepo: SettingsRepository = {
      findByTenant: async (t: string) => (t === fctx.tenantId ? settingsRow : null),
      create: async (s: TenantSettings) => s,
      update: async () => settingsRow,
      incrementEstimateNumber: async () => 1,
      incrementInvoiceNumber: async () => 1,
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
      moneyDashboardRepo: new InMemoryMoneyDashboardRepository(),
      catalogRepo: new InMemoryCatalogItemRepository(),
      availabilityFinder: new DefaultAvailabilityFinder({
        appointmentRepo: fctx.repos.appointmentRepo,
      }),
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
