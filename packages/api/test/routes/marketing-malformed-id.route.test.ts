/**
 * Route hardening tests: Marketing campaigns (#1110, extends the #882 / #1096 sweep)
 *
 * `POST /api/marketing/campaigns/:id/send` passes `req.params.id` into
 * `PgCampaignRepository.claimForSending` / `findById`, which compare it against
 * `marketing_campaigns.id uuid`. With a delivery provider configured, a
 * non-UUID id reached Postgres, threw `invalid input syntax for type uuid`, and
 * `asyncRoute` answered a bare `500 INTERNAL_ERROR`.
 *
 * Capability ordering (the reports.ts `customer-profit` lesson from #1096):
 * with NO delivery provider the handler answers `503 NOT_CONFIGURED` before it
 * ever reads the id, for any id. That answer must not be pre-empted by the
 * guard, so it is pinned here in both configurations.
 *
 * The PgLike subclass throws exactly what Postgres would (pattern:
 * users-malformed-id.route.test.ts); the real-Postgres leg is
 * test/integration/malformed-id-404-seam.test.ts.
 */
import express, { Request, Response, NextFunction, type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryTagRepository } from '../../src/customers/tag';
import { InMemoryCampaignRepository } from '../../src/marketing/campaign';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { createMarketingRouter } from '../../src/routes/marketing';

const TENANT = 'tenant-marketing-malformed';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`invalid input syntax for type uuid: "${value}"`);
  }
}

class PgLikeCampaignRepository extends InMemoryCampaignRepository {
  async findById(tenantId: string, id: string) {
    castUuid(id);
    return super.findById(tenantId, id);
  }

  async claimForSending(tenantId: string, id: string) {
    castUuid(id);
    return super.claimForSending(tenantId, id);
  }
}

function buildApp(
  repo: InMemoryCampaignRepository,
  opts: { role?: string | null; delivery?: InMemoryDeliveryProvider | null } = {},
): Express {
  const role = opts.role === undefined ? 'owner' : opts.role;
  const delivery = opts.delivery === undefined ? new InMemoryDeliveryProvider() : opts.delivery;
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-marketing-malformed',
        sessionId: 'sess-marketing-malformed',
        tenantId: TENANT,
        role,
      };
    }
    next();
  });
  app.use(
    '/api/marketing',
    createMarketingRouter({
      campaignRepo: repo,
      customerRepo: new InMemoryCustomerRepository(),
      tagRepo: new InMemoryTagRepository(),
      delivery,
      groupMemberIds: async () => [],
      auditRepo: new InMemoryAuditRepository(),
    }),
  );
  return app;
}

const send = (app: Express, id: string) =>
  request(app).post(`/api/marketing/campaigns/${id}/send`).send({});

describe('marketing: malformed campaign :id never reaches Postgres as a raw uuid comparison (#1110)', () => {
  let repo: PgLikeCampaignRepository;

  beforeEach(() => {
    repo = new PgLikeCampaignRepository();
  });

  it('POST /api/marketing/campaigns/:id/send with a malformed id answers 404 NOT_FOUND, never a 500', async () => {
    const res = await send(buildApp(repo), 'not-a-uuid');
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Campaign not found' });
  });

  it('a well-formed unknown id still answers the ordinary 404', async () => {
    const res = await send(buildApp(repo), uuidv4());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('capability ordering: with no delivery provider a malformed id still answers 503 NOT_CONFIGURED, not 404', async () => {
    const res = await send(buildApp(repo, { delivery: null }), 'not-a-uuid');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('NOT_CONFIGURED');
  });

  it('a valid id is unaffected — the draft is sent', async () => {
    const id = uuidv4();
    await repo.create({
      id,
      tenantId: TENANT,
      name: 'Spring tune-up',
      subject: 'Book your tune-up',
      bodyText: 'Hi',
      bodyHtml: null,
      segmentTag: null,
      segmentGroupId: null,
      status: 'draft',
      recipientCount: 0,
      sentCount: 0,
      failedCount: 0,
      createdBy: 'user-marketing-malformed',
      sentAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await send(buildApp(repo), id);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.status).toBe('sent');
  });

  it('auth ordering: a technician (no settings:update) gets 403 before any existence signal', async () => {
    const res = await send(buildApp(repo, { role: 'technician' }), 'not-a-uuid');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('auth ordering: an unauthenticated caller with a malformed id gets 401, not 404', async () => {
    const res = await send(buildApp(repo, { role: null }), 'not-a-uuid');
    expect(res.status).toBe(401);
  });
});
