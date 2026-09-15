import { describe, it, expect, beforeEach } from 'vitest';
import express, { Express, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createConversationRouter } from '../../src/routes/conversations';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = 'tenant-thread-1';
const USER = 'owner-1';
// Well-formed uuids — #882's malformed-:customerId guard 404s fixture-style
// ids like 'cust-1' before the handler runs, exactly as prod (uuid column) would.
const CUST_ID = '5f0f0d5e-1c2a-4b6e-8a3d-9c7b6a5e4d3c';
const GHOST_ID = '99999999-9999-4999-8999-999999999999';
const UNVERIFIED_ID = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';

function buildApp(opts: { withCustomerLookup: boolean; knownCustomerIds?: string[] } = { withCustomerLookup: true }) {
  const conversationRepo = new InMemoryConversationRepository();
  const auditRepo = new InMemoryAuditRepository();
  const known = new Set(opts.knownCustomerIds ?? [CUST_ID]);
  const customerLookup = {
    findById: async (_tenantId: string, id: string) => (known.has(id) ? ({ id } as never) : null),
  };

  const app: Express = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: USER, sessionId: 's1', tenantId: TENANT, role: 'owner' };
    next();
  });
  app.use(
    '/api/conversations',
    createConversationRouter(
      conversationRepo,
      auditRepo,
      undefined,
      undefined,
      opts.withCustomerLookup ? customerLookup : undefined,
    ),
  );
  return { app, conversationRepo };
}

describe('POST /api/conversations/customer/:customerId', () => {
  let env: ReturnType<typeof buildApp>;
  beforeEach(() => {
    env = buildApp({ withCustomerLookup: true });
  });

  it('creates a customer thread on first call', async () => {
    const res = await request(env.app).post(`/api/conversations/customer/${CUST_ID}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.conversation.entityType).toBe('customer');
    expect(res.body.conversation.entityId).toBe(CUST_ID);
  });

  it('reuses the same thread on repeat calls (idempotent, no duplicate)', async () => {
    const first = await request(env.app).post(`/api/conversations/customer/${CUST_ID}`).send({});
    const second = await request(env.app).post(`/api/conversations/customer/${CUST_ID}`).send({});
    expect(second.body.conversation.id).toBe(first.body.conversation.id);
    const all = await env.conversationRepo.findByEntity(TENANT, 'customer', CUST_ID);
    expect(all).toHaveLength(1);
  });

  it('404s an unknown customer when a lookup is wired', async () => {
    const res = await request(env.app).post(`/api/conversations/customer/${GHOST_ID}`).send({});
    expect(res.status).toBe(404);
  });

  it('404s a malformed customer id before any lookup (#882)', async () => {
    const res = await request(env.app).post('/api/conversations/customer/cust-1').send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Customer not found' });
  });

  it('still creates when no customer lookup is wired (skips verification)', async () => {
    const { app } = buildApp({ withCustomerLookup: false });
    const res = await request(app).post(`/api/conversations/customer/${UNVERIFIED_ID}`).send({});
    expect(res.status).toBe(200);
  });
});
