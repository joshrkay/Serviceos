import { describe, it, expect, vi } from 'vitest';
import express, { Express, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createCallsRouter, createCallBridgeRouter } from '../../src/routes/calls';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import type { OutboundCallDeps } from '../../src/telephony/outbound-call-service';

const TENANT = 'tenant-calls-1';
const USER = 'owner-1';

function buildApp(
  opts: { configured: boolean; customerMissing?: boolean; noPhone?: boolean } = { configured: true },
) {
  const conversationRepo = new InMemoryConversationRepository();
  const dncRepo = new InMemoryDncRepository();
  const auditRepo = new InMemoryAuditRepository();
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({ sid: 'CA999', status: 'queued' }),
    text: async () => '',
  });

  const customer = opts.customerMissing
    ? null
    : { id: 'cust-1', primaryPhone: opts.noPhone ? undefined : '+15551234567' };

  const callDeps: OutboundCallDeps = {
    customerRepo: { findById: vi.fn().mockResolvedValue(customer) },
    conversationRepo,
    dncRepo,
    auditRepo,
    getCreds: vi.fn().mockResolvedValue({
      accountSid: 'ACx',
      authToken: 'tok',
      messagingServiceSid: null,
      phoneE164: '+15557778888',
      credentialVersion: 1,
    }),
    publicApiUrl: 'https://api.example.com',
    fetchImpl: fetchMock as unknown as typeof fetch,
    apiBaseUrl: 'https://twilio.test/2010-04-01',
  };

  const app: Express = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: USER,
      sessionId: 's1',
      tenantId: TENANT,
      role: 'owner',
    };
    next();
  });
  app.use('/api/calls', createCallsRouter(opts.configured ? { callDeps } : {}));
  return { app, dncRepo, fetchMock, callDeps };
}

describe('POST /api/calls', () => {
  it('starts a bridged call and returns the call sid', async () => {
    const { app } = buildApp({ configured: true });
    const res = await request(app).post('/api/calls').send({ customerId: 'cust-1', agentPhone: '+15559990000' });
    expect(res.status).toBe(201);
    expect(res.body.callSid).toBe('CA999');
  });

  it('returns 503 when calling is not configured', async () => {
    const { app } = buildApp({ configured: false });
    const res = await request(app).post('/api/calls').send({ customerId: 'cust-1', agentPhone: '+15559990000' });
    expect(res.status).toBe(503);
  });

  it('400s an invalid body', async () => {
    const { app } = buildApp({ configured: true });
    const res = await request(app).post('/api/calls').send({ customerId: 'cust-1' });
    expect(res.status).toBe(400);
  });

  it('403s a DNC-listed customer', async () => {
    const { app, dncRepo, fetchMock } = buildApp({ configured: true });
    dncRepo.add(TENANT, '15551234567');
    const res = await request(app).post('/api/calls').send({ customerId: 'cust-1', agentPhone: '+15559990000' });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('422s a customer with no phone on file', async () => {
    const { app } = buildApp({ configured: true, noPhone: true });
    const res = await request(app).post('/api/calls').send({ customerId: 'cust-1', agentPhone: '+15559990000' });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/calls/bridge (Twilio callback)', () => {
  it('rejects an unsigned request (403) — the signature gate guards the bridge', async () => {
    // Mounted with NO Clerk auth in front (mirrors app.ts mounting it before
    // the /api auth chain); only the Twilio signature gates it.
    const app: Express = express();
    app.use(
      '/api/calls',
      createCallBridgeRouter({ twilioAuthTokenGetter: () => 'tok' }),
    );
    const res = await request(app)
      .post('/api/calls/bridge?tenantId=t&conversationId=c&messageId=m')
      .send('From=%2B15551234567');
    expect(res.status).toBe(403);
  });
});
