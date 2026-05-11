/**
 * Route tests for /api/voice/sessions (P8-009).
 * Cover happy path, tenant isolation, missing session, and SSE delivery.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { createVoiceSessionsRouter } from '../../src/routes/voice-sessions';
import { InAppVoiceAdapter } from '../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../src/oncall/rotation';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

function scriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => ({
      content: responses[Math.min(i++, responses.length - 1)],
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

function buildApp(authTenant: string, authUser: string, store: VoiceSessionStore, adapter: InAppVoiceAdapter) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: authUser,
      sessionId: 'sess-1',
      tenantId: authTenant,
      role: 'owner',
    };
    next();
  });
  app.use('/api/voice/sessions', createVoiceSessionsRouter({ adapter, store }));
  return app;
}

describe('voice-sessions routes', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;
  let onCallRepo: InMemoryOnCallRepository;
  let adapter: InAppVoiceAdapter;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
    onCallRepo = new InMemoryOnCallRepository();
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.92,
        extractedEntities: { customerName: 'Acme' },
      }),
    ]);
    adapter = new InAppVoiceAdapter({
      store,
      gateway,
      proposalRepo,
      auditRepo,
      onCallRepo,
    });
  });

  afterEach(() => store.dispose());

  it('POST / starts a session and returns sessionId+state', async () => {
    const app = buildApp('tenant-a', 'user-a', store, adapter);
    const res = await request(app).post('/api/voice/sessions').send({});
    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.state).toBe('intent_capture');
  });

  it('POST /:id/input runs through to closing on a high-confidence intent', async () => {
    const app = buildApp('tenant-a', 'user-a', store, adapter);
    const startRes = await request(app).post('/api/voice/sessions').send({});
    const id = startRes.body.sessionId;
    const inputRes = await request(app)
      .post(`/api/voice/sessions/${id}/input`)
      .send({ text: 'Invoice Acme for 450' });
    expect(inputRes.status).toBe(200);
    expect(inputRes.body.state).toBe('closing');
    expect(inputRes.body.proposalIds.length).toBe(1);
  });

  it('returns 404 when input is sent to another tenant\'s session', async () => {
    const appA = buildApp('tenant-a', 'user-a', store, adapter);
    const startRes = await request(appA).post('/api/voice/sessions').send({});
    const id = startRes.body.sessionId;

    const appB = buildApp('tenant-b', 'user-b', store, adapter);
    const inputRes = await request(appB)
      .post(`/api/voice/sessions/${id}/input`)
      .send({ text: 'hi' });
    expect(inputRes.status).toBe(404);
  });

  it('returns 404 for unknown sessions', async () => {
    const app = buildApp('tenant-a', 'user-a', store, adapter);
    const res = await request(app)
      .post('/api/voice/sessions/does-not-exist/input')
      .send({ text: 'hi' });
    expect(res.status).toBe(404);
  });

  it('DELETE removes the session and returns 204', async () => {
    const app = buildApp('tenant-a', 'user-a', store, adapter);
    const startRes = await request(app).post('/api/voice/sessions').send({});
    const id = startRes.body.sessionId;
    const delRes = await request(app).delete(`/api/voice/sessions/${id}`);
    expect(delRes.status).toBe(204);
    expect(store.peek(id)).toBeUndefined();
  });

  it('SSE: GET /:id/events delivers the snapshot frame', async () => {
    const app = buildApp('tenant-a', 'user-a', store, adapter);
    const startRes = await request(app).post('/api/voice/sessions').send({});
    const id = startRes.body.sessionId;

    // Boot a real HTTP server so we can hold the SSE stream open.
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    const data = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${port}/api/voice/sessions/${id}/events`,
        (res) => {
          let buf = '';
          res.on('data', (chunk) => {
            buf += chunk.toString();
            // Once we've seen the snapshot frame, resolve and end.
            if (buf.includes('"snapshot"')) {
              resolve(buf);
              req.destroy();
            }
          });
          res.on('error', reject);
        }
      );
      req.on('error', (err) => {
        // ECONNRESET fires when we destroy the request; ignore that.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ECONNRESET') reject(err);
      });
    });

    expect(data).toContain('snapshot');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 10_000);
});
