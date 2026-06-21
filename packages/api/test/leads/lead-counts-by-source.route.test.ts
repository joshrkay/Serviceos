/**
 * LC-8 — GET /leads/counts-by-source route: source-attribution analytics for
 * the digest/dashboard. Pins that the analytics path is matched before the
 * '/:id' param route (otherwise 'counts-by-source' would be read as an id).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { Express, NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createLeadsRouter } from '../../src/routes/leads';
import { InMemoryLeadRepository } from '../../src/leads/lead';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createLead, convertToCustomer } from '../../src/leads/lead-service';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const USER = 'user-1';

describe('GET /leads/counts-by-source (LC-8)', () => {
  let app: Express;
  let leadRepo: InMemoryLeadRepository;
  let customerRepo: InMemoryCustomerRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(async () => {
    leadRepo = new InMemoryLeadRepository();
    customerRepo = new InMemoryCustomerRepository();
    auditRepo = new InMemoryAuditRepository();

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: USER,
        sessionId: 's',
        tenantId: TENANT,
        role: 'owner',
      };
      next();
    });
    app.use('/leads', createLeadsRouter(leadRepo, customerRepo, auditRepo));

    await createLead({ tenantId: TENANT, firstName: 'A', source: 'web_form', primaryPhone: '5550001', createdBy: USER }, leadRepo, auditRepo);
    const conv = await createLead({ tenantId: TENANT, firstName: 'B', source: 'web_form', primaryPhone: '5550002', createdBy: USER }, leadRepo, auditRepo);
    await createLead({ tenantId: TENANT, firstName: 'C', source: 'referral', primaryPhone: '5550003', createdBy: USER }, leadRepo, auditRepo);
    await convertToCustomer(TENANT, conv.id, leadRepo, customerRepo, USER, 'owner', auditRepo);
  });

  it('returns per-source lead + converted counts (not shadowed by /:id)', async () => {
    const res = await request(app).get('/leads/counts-by-source');
    expect(res.status).toBe(200);
    const bySource = Object.fromEntries(res.body.counts.map((c: { source: string }) => [c.source, c]));
    expect(bySource['web_form']).toMatchObject({ leadCount: 2, convertedCount: 1 });
    expect(bySource['referral']).toMatchObject({ leadCount: 1, convertedCount: 0 });
  });

  it('rejects an invalid date with 400', async () => {
    const res = await request(app).get('/leads/counts-by-source?from=not-a-date');
    expect(res.status).toBe(400);
  });

  it('filters by a from window', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const res = await request(app).get(`/leads/counts-by-source?from=${future}`);
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual([]);
  });
});
