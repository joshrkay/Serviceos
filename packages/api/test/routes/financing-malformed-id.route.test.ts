/**
 * Route hardening tests: Financing (#1110, extends the #882 / #1096 sweep)
 *
 * `POST /api/financing/invoices/:invoiceId/offer` passes the param into
 * `PgInvoiceRepository.findById`; `GET /api/financing/invoices/:invoiceId`
 * into `PgFinancingRepository.listByInvoice`; `GET /api/financing/:id` into
 * `PgFinancingRepository.findById`. Each compares against a `uuid` column, so a
 * non-UUID value reached Postgres, threw `invalid input syntax for type uuid`,
 * and `asyncRoute` answered a bare `500 INTERNAL_ERROR`.
 *
 * The PgLike subclasses throw exactly what Postgres would (pattern:
 * users-malformed-id.route.test.ts); the real-Postgres leg is
 * test/integration/malformed-id-404-seam.test.ts.
 *
 * `GET /invoices/:invoiceId` is list-shaped: a well-formed id that names no
 * invoice answers `200 []`, and that is unchanged.
 */
import express, { Request, Response, NextFunction, type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryFinancingRepository } from '../../src/financing/financing';
import { ManualFinancingProvider } from '../../src/financing/financing-provider';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { createFinancingRouter } from '../../src/routes/financing';

const TENANT = 'tenant-financing-malformed';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`invalid input syntax for type uuid: "${value}"`);
  }
}

class PgLikeFinancingRepository extends InMemoryFinancingRepository {
  async findById(tenantId: string, id: string) {
    castUuid(id);
    return super.findById(tenantId, id);
  }

  async listByInvoice(tenantId: string, invoiceId: string) {
    castUuid(invoiceId);
    return super.listByInvoice(tenantId, invoiceId);
  }
}

class PgLikeInvoiceRepository extends InMemoryInvoiceRepository {
  async findById(tenantId: string, id: string) {
    castUuid(id);
    return super.findById(tenantId, id);
  }
}

function buildApp(financingRepo: InMemoryFinancingRepository, role: string | null = 'owner'): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-financing-malformed',
        sessionId: 'sess-financing-malformed',
        tenantId: TENANT,
        role,
      };
    }
    next();
  });
  app.use(
    '/api/financing',
    createFinancingRouter({
      financingRepo,
      invoiceRepo: new PgLikeInvoiceRepository(),
      jobRepo: new InMemoryJobRepository(),
      customerRepo: new InMemoryCustomerRepository(),
      provider: new ManualFinancingProvider(),
      auditRepo: new InMemoryAuditRepository(),
    }),
  );
  return app;
}

type Send = (app: Express, id: string) => request.Test;

const HANDLERS: Array<{ route: string; message: string; send: Send; unknownStatus: number }> = [
  {
    route: 'POST /api/financing/invoices/:invoiceId/offer',
    message: 'Invoice not found',
    send: (app, id) => request(app).post(`/api/financing/invoices/${id}/offer`).send({}),
    unknownStatus: 404,
  },
  {
    route: 'GET /api/financing/invoices/:invoiceId',
    message: 'Invoice not found',
    send: (app, id) => request(app).get(`/api/financing/invoices/${id}`),
    unknownStatus: 200,
  },
  {
    route: 'GET /api/financing/:id',
    message: 'Financing application not found',
    send: (app, id) => request(app).get(`/api/financing/${id}`),
    unknownStatus: 404,
  },
];

describe('financing: malformed :id / :invoiceId never reach Postgres as a raw uuid comparison (#1110)', () => {
  let repo: PgLikeFinancingRepository;

  beforeEach(() => {
    repo = new PgLikeFinancingRepository();
  });

  for (const { route, message, send, unknownStatus } of HANDLERS) {
    it(`${route} with a malformed id answers 404 NOT_FOUND, never a 500`, async () => {
      const res = await send(buildApp(repo), 'not-a-uuid');
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message });
    });

    it(`${route} with a well-formed unknown id keeps its existing ${unknownStatus} answer`, async () => {
      const res = await send(buildApp(repo), uuidv4());
      expect(res.status).toBe(unknownStatus);
    });
  }

  it('a valid id is unaffected — the application and the per-invoice list still read', async () => {
    const id = uuidv4();
    const invoiceId = uuidv4();
    await repo.create({
      id,
      tenantId: TENANT,
      invoiceId,
      customerId: null,
      amountCents: 250_000,
      provider: 'manual',
      externalId: null,
      applicationUrl: null,
      status: 'offered',
      statusReason: null,
      createdBy: 'user-financing-malformed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = buildApp(repo);

    const one = await request(app).get(`/api/financing/${id}`);
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(id);

    const list = await request(app).get(`/api/financing/invoices/${invoiceId}`);
    expect(list.status).toBe(200);
    expect(list.body.map((a: { id: string }) => a.id)).toEqual([id]);
  });

  it('auth ordering: a technician (no invoices:view / invoices:update) gets 403 before any existence signal', async () => {
    const app = buildApp(repo, 'technician');
    for (const { send } of HANDLERS) {
      const res = await send(app, 'not-a-uuid');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    }
  });

  it('auth ordering: an unauthenticated caller with a malformed id gets 401, not 404', async () => {
    const app = buildApp(repo, null);
    for (const { send } of HANDLERS) {
      const res = await send(app, 'not-a-uuid');
      expect(res.status).toBe(401);
    }
  });
});
