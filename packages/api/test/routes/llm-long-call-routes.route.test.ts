/**
 * TI-02 — the in-request LLM routes hold no request transaction across their
 * LLM/TTS calls.
 *
 * Each of these handlers awaits classify / draft / extract / TTS calls of up
 * to several seconds. Under the /api request transaction that pinned one
 * pooled connection (and under PgBouncer one server backend) per concurrent
 * turn — and the in-app resolver and the onboarding lock took a SECOND
 * connection inside it, so ~DB_MAX_CONNECTIONS overlapping AI turns on a
 * replica deadlocked on checkout and 500'd every other tenant's /api request.
 *
 * Same probe as the UC-2 assistant-chat pin: the REAL middleware mounted the
 * way app.ts mounts it, a pool whose connect() throws, and a gateway that
 * records — at every call — whether a request-scoped client exists.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { currentTenantContext, withTenantTransaction } from '../../src/middleware/tenant-context';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { createVoiceSessionsRouter } from '../../src/routes/voice-sessions';
import { InAppVoiceAdapter } from '../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../src/oncall/rotation';
import { createConversationRouter } from '../../src/routes/conversations';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { createEstimateRouter } from '../../src/routes/estimates';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';
import { createOnboardingConversationRouter } from '../../src/routes/onboarding-conversation';
import { OnboardingConversationOrchestrator } from '../../src/ai/orchestration/onboarding-conversation';
import { InMemoryOnboardingSessionRepository } from '../../src/db/onboarding-session-repository';
import { createTenantSiteRouter } from '../../src/routes/tenant-site';
import { InMemoryTenantSiteRepository } from '../../src/tenant-site/tenant-site';
import { InMemoryVerticalPackRegistry } from '../../src/shared/vertical-pack-registry';
import { TenantSiteAboutTask } from '../../src/ai/tasks/tenant-site-about-task';
import { InMemoryTransactionRunner } from '../../src/db/tenant-transaction';
import { createVoiceRouter } from '../../src/routes/voice';
import { InMemoryVoiceRepository } from '../../src/voice/voice-service';
import type { Queue } from '../../src/queues/queue';
import type { TtsProvider } from '../../src/ai/tts/tts-provider';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = 'user-ti02';

interface Probe {
  store: unknown;
  connects: number;
}

function harness(contentFor: (taskType: string) => string) {
  const connect = vi.fn(async () => {
    throw new Error('the request transaction must not check out a connection on this route');
  });
  const pool = { connect } as unknown as Pool;
  const probes: Probe[] = [];
  const gateway = {
    complete: vi.fn(async (req: { taskType: string }) => {
      probes.push({ store: currentTenantContext(), connects: connect.mock.calls.length });
      return {
        content: contentFor(req.taskType),
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: USER, sessionId: 's-1', tenantId: TENANT, role: 'owner' };
    next();
  });
  app.use('/api', withTenantTransaction(pool));
  const expectNoRequestTransaction = (): void => {
    expect(probes.length).toBeGreaterThan(0);
    for (const p of probes) {
      expect(p.store).toBeUndefined();
      expect(p.connects).toBe(0);
    }
    expect(connect).not.toHaveBeenCalled();
  };
  return { app, gateway, probes, connect, expectNoRequestTransaction };
}

describe('TI-02 — in-request LLM routes bypass the request transaction', () => {
  let store: VoiceSessionStore;
  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
  });
  afterEach(() => store.dispose());

  it('in-app voice: POST /voice/sessions, POST /voice/sessions/:id/input, DELETE /voice/sessions/:id', async () => {
    const h = harness(() =>
      JSON.stringify({ intentType: 'create_invoice', confidence: 0.92, extractedEntities: { customerName: 'Acme' } }),
    );
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: h.gateway,
      proposalRepo: new InMemoryProposalRepository(),
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(),
    });
    h.app.use('/api/voice/sessions', createVoiceSessionsRouter({ adapter, store }));

    const started = await request(h.app).post('/api/voice/sessions').send({});
    expect(started.status).toBe(201);
    const id = started.body.sessionId as string;
    const turn = await request(h.app).post(`/api/voice/sessions/${id}/input`).send({ text: 'Invoice Acme for 450' });
    expect(turn.status).toBe(200);
    const ended = await request(h.app).delete(`/api/voice/sessions/${id}`);
    expect(ended.status).toBe(204);
    // The summary the DELETE kicks off is a gateway call too.
    await vi.waitFor(() =>
      expect((h.gateway.complete as ReturnType<typeof vi.fn>).mock.calls.some(
        ([req]) => (req as { taskType: string }).taskType === 'summarize_conversation',
      )).toBe(true),
    );

    h.expectNoRequestTransaction();
  });

  it('POST /conversations/:id/suggest-reply', async () => {
    const h = harness(() => 'Thanks — we can come by Tuesday morning.');
    const conversations = new InMemoryConversationRepository();
    const conv = await conversations.createConversation({ tenantId: TENANT, title: 'Leak', createdBy: USER });
    await conversations.addMessage({
      tenantId: TENANT,
      conversationId: conv.id,
      messageType: 'text',
      content: 'My kitchen sink is leaking, can someone come out?',
      senderId: 'cust-1',
      senderRole: 'customer',
    });
    h.app.use('/api/conversations', createConversationRouter(conversations, undefined, { gateway: h.gateway }));

    const res = await request(h.app).post(`/api/conversations/${conv.id}/suggest-reply`).send({});

    expect(res.status).toBe(200);
    expect(res.body.draft).toContain('Tuesday');
    h.expectNoRequestTransaction();
  });

  it('POST /estimates/suggest', async () => {
    const h = harness(() =>
      JSON.stringify({
        lineItems: [{ description: 'Pipe repair', quantity: 1, unitPrice: 7500 }],
        notes: 'AI draft',
        confidence_score: 0.6,
      }),
    );
    h.app.use(
      '/api/estimates',
      createEstimateRouter(
        new InMemoryEstimateRepository(),
        new InMemorySettingsRepository(),
        new InMemoryAuditRepository(),
        permissiveTenantOwnership(),
        undefined,
        { gateway: h.gateway, proposalRepo: new InMemoryProposalRepository() },
      ),
    );

    const res = await request(h.app).post('/api/estimates/suggest').send({ description: 'need a pipe repair' });

    expect(res.status).toBe(200);
    h.expectNoRequestTransaction();
  });

  it('POST /onboarding/conversation/turn', async () => {
    const h = harness(() =>
      JSON.stringify({
        business_name: 'Acme HVAC',
        city: 'Mesa',
        state: 'AZ',
        verticals: [{ type: 'hvac', confidence: 0.95, source_text: 'hvac' }],
        service_descriptions: ['repair'],
        confidence_score: 0.9,
      }),
    );
    h.app.use(
      '/api/onboarding/conversation',
      createOnboardingConversationRouter({
        orchestrator: new OnboardingConversationOrchestrator({
          gateway: h.gateway,
          sessionRepo: new InMemoryOnboardingSessionRepository(),
          proposalRepo: new InMemoryProposalRepository(),
          auditRepo: new InMemoryAuditRepository(),
        }),
      }),
    );

    const res = await request(h.app)
      .post('/api/onboarding/conversation/turn')
      .send({ userMessage: 'We run Acme HVAC in Mesa, Arizona' });

    expect(res.status).toBe(200);
    h.expectNoRequestTransaction();
  });

  it('POST /tenant-site/about/draft', async () => {
    const h = harness(() => 'Acme Plumbing keeps Mesa running. Call us for a quote.');
    const settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.upsertIdentityFields(TENANT, { businessName: 'Acme Plumbing' });
    const proposalRepo = new InMemoryProposalRepository();
    h.app.use(
      '/api/tenant-site',
      createTenantSiteRouter({
        baseDomain: 'sites.example-pages.test',
        siteRepo: new InMemoryTenantSiteRepository(),
        settingsRepo,
        viewDeps: { settingsRepo, packRegistry: new InMemoryVerticalPackRegistry(), webOrigin: 'https://app.example.test' },
        auditRepo: new InMemoryAuditRepository(),
        aboutTask: new TenantSiteAboutTask(h.gateway),
        proposalRepo,
        transactionRunner: new InMemoryTransactionRunner(),
      }),
    );

    const res = await request(h.app).post('/api/tenant-site/about/draft').send({});

    expect(res.status).toBe(201);
    expect((await proposalRepo.findById(TENANT, res.body.data.proposalId))?.proposalType).toBe(
      'update_tenant_site_about',
    );
    h.expectNoRequestTransaction();
  });

  // Not LLM calls, but the same shape: the speech provider is awaited for
  // seconds (tens of seconds in the worst case), so the routes take the same
  // bypass and write their audit rows with an explicit tenantId.
  function voiceApp(
    h: ReturnType<typeof harness>,
    opts: { tts?: TtsProvider; transcribeAudio?: Parameters<typeof createVoiceRouter>[2] } = {},
  ) {
    const auditRepo = new InMemoryAuditRepository();
    const auditStores: unknown[] = [];
    const realCreate = auditRepo.create.bind(auditRepo);
    auditRepo.create = async (event) => {
      auditStores.push(currentTenantContext());
      return realCreate(event);
    };
    h.app.use(
      '/api/voice',
      createVoiceRouter(
        new InMemoryVoiceRepository(),
        { send: vi.fn(async () => 'queued-1') } as unknown as Queue,
        opts.transcribeAudio,
        auditRepo,
        undefined,
        { ...(opts.tts ? { tts: opts.tts } : {}), settingsRepo: new InMemorySettingsRepository() },
      ),
    );
    const audited = async (eventType: string) =>
      (await auditRepo.findRecentByTenant(TENANT)).filter((e) => e.eventType === eventType);
    return { auditStores, audited };
  }

  it('POST /voice/tts and POST /voice/tts/batch', async () => {
    const h = harness(() => '');
    const tts: TtsProvider = {
      synthesize: vi.fn(async (input) => {
        h.probes.push({ store: currentTenantContext(), connects: h.connect.mock.calls.length });
        return { audio: Buffer.from(`clip:${input.text}`), contentType: 'audio/mpeg', provider: 'fake' };
      }),
    };
    const v = voiceApp(h, { tts });

    const one = await request(h.app).post('/api/voice/tts').send({ text: 'You have two jobs today.' });
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ contentType: 'audio/mpeg', cached: false });

    const batch = await request(h.app)
      .post('/api/voice/tts/batch')
      .send({ items: ['What do you do?', 'Plumbing', 'Heating'] });
    expect(batch.status).toBe(200);
    expect(batch.body.clips).toHaveLength(3);

    expect(h.probes).toHaveLength(4);
    h.expectNoRequestTransaction();
    // Every billed clip is audited, each write standalone with no request transaction.
    await vi.waitFor(async () => expect(await v.audited('voice.tts.synthesized')).toHaveLength(4));
    expect(v.auditStores).toHaveLength(4);
    expect(v.auditStores.every((s) => s === undefined)).toBe(true);
  });

  it('POST /voice/transcribe: the upload and the transcription hold no request transaction, and a failure is still audited', async () => {
    const h = harness(() => '');
    let fail = false;
    const transcribeAudio = vi.fn(async () => {
      h.probes.push({ store: currentTenantContext(), connects: h.connect.mock.calls.length });
      if (fail) throw new Error('whisper upstream 503');
      return { transcript: 'Invoice Acme for the water heater', metadata: { provider: 'fake' } };
    });
    const v = voiceApp(h, { transcribeAudio });

    const done = await request(h.app)
      .post('/api/voice/transcribe')
      .set('Content-Type', 'audio/webm')
      .send(Buffer.from('fake-webm-bytes'));
    expect(done.status).toBe(200);
    expect(done.body.transcript).toBe('Invoice Acme for the water heater');

    fail = true;
    const failed = await request(h.app)
      .post('/api/voice/transcribe')
      .set('Content-Type', 'audio/webm')
      .send(Buffer.from('fake-webm-bytes'));
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe('TRANSCRIPTION_FAILED');

    h.expectNoRequestTransaction();
    expect(await v.audited('voice.transcription.completed')).toHaveLength(1);
    // Inside the request transaction this row was written and then rolled
    // back by the 500; standalone, it persists.
    expect(await v.audited('voice.transcription.failed')).toHaveLength(1);
    expect(v.auditStores).toEqual([undefined, undefined]);
  });
});
