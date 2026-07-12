/**
 * §11 H2 Layer A — synthetic voice smoke.
 *
 * Gates every deploy via .github/workflows/deploy.yml. Two layers of proof:
 *
 *   1. Structural — the Media Streams server attaches to a live HTTP server,
 *      the documented upgrade path is exported and stable, and the upgrade
 *      handler is registered.
 *   2. Full intent→proposal — a canned "book Tuesday at 2" transcript is
 *      driven through the REAL voice-turn orchestration (classify → action
 *      router → create_appointment task) via the same `TextModeDriver` the
 *      Layer-1 voice-quality harness uses, and we assert a `create_appointment`
 *      proposal is drafted (never auto-executed). The LLM is a canned
 *      gateway (no API keys); the clock is pinned so the booking date is
 *      deterministic. This replaces the former `.todo()` scaffold — a broken
 *      booking pipeline now reddens the smoke gate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import {
  attachMediaStreamServer,
  MEDIA_STREAM_PATH,
} from '../../src/telephony/media-streams/twilio-mediastream-server';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { StreamingTranscriptionProvider } from '../../src/voice/transcription-providers';
import { LLMGateway, type LLMRequest, type LLMResponse } from '../../src/ai/gateway/gateway';
import { TextModeDriver } from '../../src/ai/voice-quality/text-mode-driver';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryCustomerRepository, type Customer } from '../../src/customers/customer';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import type { SettingsRepository, TenantSettings } from '../../src/settings/settings';

const AUTH_TOKEN = 'test-voice-smoke-token';

/**
 * Format a UTC instant as an absolute, tz-correct wall-clock phrase the
 * deterministic date resolver round-trips back to exactly that instant. Same
 * new-contract shape the Layer-1 harness uses: the LLM emits a verbatim phrase,
 * `resolveDateTime` owns the timezone math.
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
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('month')} ${get('day')} ${get('year')} ${get('hour')}:${get('minute')} ${get('dayPeriod')}`;
}

/**
 * Canned LLM gateway: classifies the smoke transcript as `create_appointment`
 * and returns a fixed appointment extraction whose date phrase resolves to the
 * pinned target instant. No network, no API keys — deterministic.
 */
class CannedBookingGateway extends LLMGateway {
  constructor(private readonly dateTimePhrase: string) {
    super({ defaultProvider: 'mock' }, new Map());
  }

  override async complete(request: LLMRequest): Promise<LLMResponse> {
    const wrap = (content: string): LLMResponse => ({
      content,
      model: 'canned',
      provider: 'mock',
      latencyMs: 1,
      tokenUsage: { input: 10, output: 10, total: 20 },
    });
    if (request.taskType === 'classify_intent') {
      return wrap(
        JSON.stringify({ intentType: 'create_appointment', confidence: 0.95, extractedEntities: {} }),
      );
    }
    if (request.taskType === 'create_appointment') {
      return wrap(
        JSON.stringify({
          summary: 'Service appointment',
          confidence_score: 0.95,
          dateTimePhrase: this.dateTimePhrase,
          durationMinutes: 120,
        }),
      );
    }
    return wrap(JSON.stringify({ intentType: 'unknown', confidence: 0.1 }));
  }
}

/**
 * Minimal no-op streaming transcription provider. We're not driving audio
 * frames in this structural test — the provider exists only to satisfy
 * the adapter's constructor dependency. The tier-2 promotion will swap
 * this for a fake provider that emits canned transcripts.
 */
function makeNoopStreamingProvider(): StreamingTranscriptionProvider {
  return {
    async openSession() {
      return {
        send: () => {},
        finish: () => {},
        destroy: () => {},
      };
    },
  };
}

describe('voice smoke (synthetic) — §11 H2 Layer A', () => {
  let server: http.Server;
  let port: number;
  let dispose: () => void = () => {};

  beforeAll(async () => {
    server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    port = (server.address() as AddressInfo).port;

    const result = attachMediaStreamServer(server, {
      store: new VoiceSessionStore({ startInterval: false }),
      streamingProvider: makeNoopStreamingProvider(),
      speechTurn: async () => [],
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: `http://127.0.0.1:${port}`,
    });
    dispose = result.dispose;
  });

  afterAll(async () => {
    dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('exports the documented Media Streams path contract', () => {
    // Twilio's <Stream> directive dials this exact path; changing it is a
    // breaking change for any deployed TwiML.
    expect(MEDIA_STREAM_PATH).toBe('/api/telephony/stream');
  });

  it('attaches the upgrade handler to a live HTTP server', () => {
    expect(server.listening).toBe(true);
    // The upgrade handler is registered as a listener on `upgrade`.
    expect(server.listenerCount('upgrade')).toBeGreaterThan(0);
  });

  it('routes a canned "book Tuesday at 2" call to a create_appointment proposal in <5s', async () => {
    const tenantId = 't_voice_smoke';
    const timezone = 'America/Los_Angeles';
    const callerId = '+15125559999';
    // Pinned clock BEFORE the booking target so the resolver accepts the
    // (deterministic) future date. Tuesday May 5 2026, 2:00 PM America/LA.
    const pinnedNow = new Date('2026-05-01T12:00:00.000Z');
    const targetIso = '2026-05-05T21:00:00.000Z';
    const dateTimePhrase = absolutePhraseFromIso(targetIso, timezone);

    const store = new VoiceSessionStore({ startInterval: false });
    const proposalRepo = new InMemoryProposalRepository();
    const appointmentRepo = new InMemoryAppointmentRepository();
    const customerRepo = new InMemoryCustomerRepository();
    // Seed the caller as a known customer so identity resolves by caller-ID and
    // the booking is not escalated as an unknown-caller booking.
    await customerRepo.create({
      id: 'cust_voice_smoke',
      tenantId,
      firstName: 'Dana',
      lastName: 'Booker',
      displayName: 'Dana Booker',
      companyName: null,
      primaryPhone: callerId,
      secondaryPhone: null,
      email: null,
      preferredChannel: 'phone',
      smsConsent: false,
      communicationNotes: null,
      isArchived: false,
      createdBy: 'seed',
      createdAt: pinnedNow,
      updatedAt: pinnedNow,
    } as unknown as Customer);

    const settingsRow = {
      tenantId,
      timezone,
      businessHoursSchedule: [],
    } as unknown as TenantSettings;
    const settingsRepo: SettingsRepository = {
      findByTenant: async (t: string) => (t === tenantId ? settingsRow : null),
      create: async (s: TenantSettings) => s,
      update: async () => settingsRow,
      incrementEstimateNumber: async () => 1,
      incrementInvoiceNumber: async () => 1,
    };

    const driver = new TextModeDriver({
      voiceSessionStore: store,
      gateway: new CannedBookingGateway(dateTimePhrase),
      proposalRepo,
      customerRepo,
      appointmentRepo,
      settingsRepo,
      now: () => pinnedNow,
      systemActorId: 'system:voice-smoke',
    });

    const startedAt = Date.now();
    const { sessionId } = await driver.startSession({
      tenantId,
      callerId,
      callerIdBlocked: false,
    });
    await driver.speak(sessionId, 'I need to book an appointment Tuesday at 2 PM.');
    const elapsedMs = Date.now() - startedAt;
    await driver.endSession(sessionId);
    store.dispose();

    const proposals = await proposalRepo.findByTenant(tenantId);
    const booking = proposals.find((p) => p.proposalType === 'create_appointment');

    // The canned transcript drove the real pipeline all the way to a drafted
    // (never executed) booking proposal.
    expect(booking, `expected a create_appointment proposal, got: ${JSON.stringify(
      proposals.map((p) => p.proposalType),
    )}`).toBeDefined();
    expect(booking!.status).not.toBe('executed');
    // Smoke latency budget (§11 H2): the whole canned turn well under 5s.
    expect(elapsedMs).toBeLessThan(5000);
  });
});
