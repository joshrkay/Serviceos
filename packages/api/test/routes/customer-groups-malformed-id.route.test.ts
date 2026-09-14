/**
 * Route hardening tests: Customer groups (#1110, extends the #882 / #1096 sweep)
 *
 * Every `:id` / `:customerId` handler on `/api/customer-groups` passes the
 * param straight into `PgCustomerGroupRepository`, whose queries compare it
 * against `uuid` columns (`customer_groups.id`, `customer_group_members.
 * group_id` / `customer_id`). A non-UUID value reached Postgres, threw
 * `invalid input syntax for type uuid`, and `asyncRoute` answered a bare
 * `500 INTERNAL_ERROR`.
 *
 * The PgLike subclass throws exactly what Postgres would (pattern:
 * users-malformed-id.route.test.ts); the real-Postgres leg is
 * test/integration/malformed-id-404-seam.test.ts.
 *
 * Note on the list-shaped reads (`GET /for-customer/:customerId`,
 * `GET /:id/members`) and the idempotent `DELETE /:id/members/:customerId`:
 * a well-formed id that names nothing answers 200 with an empty result there,
 * and that is unchanged. Only a value that cannot be a uuid — which today is a
 * 500 — now answers the seam's 404.
 */
import express, { Request, Response, NextFunction, type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryCustomerGroupRepository } from '../../src/customers/customer-group';
import { createCustomerGroupRouter } from '../../src/routes/customer-groups';

const TENANT = 'tenant-customer-groups-malformed';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(...values: string[]): void {
  for (const value of values) {
    if (!UUID_RE.test(value)) {
      throw new Error(`invalid input syntax for type uuid: "${value}"`);
    }
  }
}

class PgLikeCustomerGroupRepository extends InMemoryCustomerGroupRepository {
  async findGroupById(tenantId: string, id: string) {
    castUuid(id);
    return super.findGroupById(tenantId, id);
  }

  async archiveGroup(tenantId: string, id: string) {
    castUuid(id);
    return super.archiveGroup(tenantId, id);
  }

  async addMember(tenantId: string, groupId: string, customerId: string) {
    castUuid(groupId, customerId);
    return super.addMember(tenantId, groupId, customerId);
  }

  async removeMember(tenantId: string, groupId: string, customerId: string) {
    castUuid(groupId, customerId);
    return super.removeMember(tenantId, groupId, customerId);
  }

  async listMemberIds(tenantId: string, groupId: string) {
    castUuid(groupId);
    return super.listMemberIds(tenantId, groupId);
  }

  async listGroupsForCustomer(tenantId: string, customerId: string) {
    castUuid(customerId);
    return super.listGroupsForCustomer(tenantId, customerId);
  }
}

function buildApp(repo: InMemoryCustomerGroupRepository, role: string | null = 'owner'): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-customer-groups-malformed',
        sessionId: 'sess-customer-groups-malformed',
        tenantId: TENANT,
        role,
      };
    }
    next();
  });
  app.use('/api/customer-groups', createCustomerGroupRouter(repo, new InMemoryAuditRepository()));
  return app;
}

async function seedGroup(repo: InMemoryCustomerGroupRepository): Promise<string> {
  const id = uuidv4();
  await repo.createGroup({
    id,
    tenantId: TENANT,
    name: `VIP ${id.slice(0, 6)}`,
    description: null,
    color: null,
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

type Send = (app: Express, bad: string, groupId: string) => request.Test;

const GROUP = 'Customer group not found';
const CUSTOMER = 'Customer not found';

/**
 * Each row substitutes the malformed value into exactly one param; the other
 * param (where there is one) is a real group id so the malformed value is what
 * reaches the query.
 */
const HANDLERS: Array<{ route: string; message: string; send: Send; unknownStatus: number }> = [
  {
    route: 'PATCH /api/customer-groups/:id',
    message: GROUP,
    send: (app, bad) => request(app).patch(`/api/customer-groups/${bad}`).send({ name: 'Renamed' }),
    unknownStatus: 404,
  },
  {
    route: 'POST /api/customer-groups/:id/archive',
    message: GROUP,
    send: (app, bad) => request(app).post(`/api/customer-groups/${bad}/archive`).send({}),
    unknownStatus: 404,
  },
  {
    route: 'GET /api/customer-groups/for-customer/:customerId',
    message: CUSTOMER,
    send: (app, bad) => request(app).get(`/api/customer-groups/for-customer/${bad}`),
    unknownStatus: 200,
  },
  {
    route: 'GET /api/customer-groups/:id/members',
    message: GROUP,
    send: (app, bad) => request(app).get(`/api/customer-groups/${bad}/members`),
    unknownStatus: 200,
  },
  {
    route: 'PUT /api/customer-groups/:id/members/:customerId (malformed :id)',
    message: GROUP,
    send: (app, bad) => request(app).put(`/api/customer-groups/${bad}/members/${uuidv4()}`).send({}),
    unknownStatus: 404,
  },
  {
    route: 'PUT /api/customer-groups/:id/members/:customerId (malformed :customerId)',
    message: CUSTOMER,
    send: (app, bad, groupId) =>
      request(app).put(`/api/customer-groups/${groupId}/members/${bad}`).send({}),
    unknownStatus: 201,
  },
  {
    route: 'DELETE /api/customer-groups/:id/members/:customerId (malformed :id)',
    message: GROUP,
    send: (app, bad) => request(app).delete(`/api/customer-groups/${bad}/members/${uuidv4()}`),
    unknownStatus: 200,
  },
  {
    route: 'DELETE /api/customer-groups/:id/members/:customerId (malformed :customerId)',
    message: CUSTOMER,
    send: (app, bad, groupId) => request(app).delete(`/api/customer-groups/${groupId}/members/${bad}`),
    unknownStatus: 200,
  },
];

describe('customer groups: malformed :id / :customerId never reach Postgres as a raw uuid comparison (#1110)', () => {
  let repo: PgLikeCustomerGroupRepository;
  let groupId: string;

  beforeEach(async () => {
    repo = new PgLikeCustomerGroupRepository();
    groupId = await seedGroup(repo);
  });

  for (const { route, message, send, unknownStatus } of HANDLERS) {
    it(`${route} with a malformed value answers 404 NOT_FOUND, never a 500`, async () => {
      const res = await send(buildApp(repo), 'not-a-uuid', groupId);
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message });
    });

    it(`${route} with a well-formed unknown value keeps its existing ${unknownStatus} answer`, async () => {
      const res = await send(buildApp(repo), uuidv4(), groupId);
      expect(res.status).toBe(unknownStatus);
    });
  }

  it('a valid id is unaffected — rename, add/list/remove member, archive still apply', async () => {
    const app = buildApp(repo);
    const customerId = uuidv4();

    const renamed = await request(app).patch(`/api/customer-groups/${groupId}`).send({ name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Renamed');

    const added = await request(app).put(`/api/customer-groups/${groupId}/members/${customerId}`).send({});
    expect(added.status).toBe(201);

    const members = await request(app).get(`/api/customer-groups/${groupId}/members`);
    expect(members.status).toBe(200);
    expect(members.body.customerIds).toEqual([customerId]);

    const forCustomer = await request(app).get(`/api/customer-groups/for-customer/${customerId}`);
    expect(forCustomer.status).toBe(200);
    expect(forCustomer.body.map((g: { id: string }) => g.id)).toEqual([groupId]);

    const removed = await request(app).delete(`/api/customer-groups/${groupId}/members/${customerId}`);
    expect(removed.status).toBe(200);

    const archived = await request(app).post(`/api/customer-groups/${groupId}/archive`).send({});
    expect(archived.status).toBe(200);
    expect(archived.body.isArchived).toBe(true);
  });

  it('auth ordering: a technician (no customers:update) gets 403 before any existence signal', async () => {
    const app = buildApp(repo, 'technician');
    const writes = HANDLERS.filter(({ route }) => !route.startsWith('GET '));
    for (const { send } of writes) {
      const res = await send(app, 'not-a-uuid', groupId);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    }
  });

  it('auth ordering: an unauthenticated caller with a malformed id gets 401, not 404', async () => {
    const app = buildApp(repo, null);
    for (const { send } of HANDLERS) {
      const res = await send(app, 'not-a-uuid', groupId);
      expect(res.status).toBe(401);
    }
  });
});
