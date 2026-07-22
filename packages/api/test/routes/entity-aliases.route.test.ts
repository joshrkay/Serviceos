import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { Role } from '../../src/auth/rbac';
import type { EntityAliasRepository } from '../../src/learning/entity-aliases/entity-alias';
import { createEntityAliasesRouter } from '../../src/routes/entity-aliases';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CLERK_ID = 'user_clerk_123';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const ALIAS_ID = '33333333-3333-4333-8333-333333333333';

function repository(): EntityAliasRepository {
  return {
    findActiveByAlias: vi.fn(),
    activateFromApprovedProposal: vi.fn(),
    deactivate: vi.fn().mockResolvedValue({
      id: ALIAS_ID,
      tenantId: TENANT_ID,
      entityKind: 'customer',
      entityId: '44444444-4444-4444-8444-444444444444',
      normalizedAlias: 'khan',
      sourceAlias: 'Khan',
      source: 'entity_picker',
      sourceProposalId: '55555555-5555-4555-8555-555555555555',
      active: false,
      createdBy: OWNER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
      deactivatedAt: new Date(),
      deactivatedBy: OWNER_ID,
    }),
  };
}

function buildApp(
  repo: EntityAliasRepository,
  role: Role,
  canonicalUserId: string | undefined = OWNER_ID,
  omitCanonicalUserId = false,
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const auth: AuthenticatedRequest['auth'] = {
      userId: CLERK_ID,
      sessionId: 'session-1',
      tenantId: TENANT_ID,
      role,
    };
    if (!omitCanonicalUserId) {
      auth.canonicalUserId = canonicalUserId;
    }
    (req as AuthenticatedRequest).auth = auth;
    next();
  });
  app.use('/api/entity-aliases', createEntityAliasesRouter(repo));
  return app;
}

describe('entity aliases revoke route', () => {
  it('soft-deactivates with the tenant-scoped alias ID and canonical owner actor', async () => {
    const repo = repository();

    const response = await request(buildApp(repo, 'owner'))
      .patch(`/api/entity-aliases/${ALIAS_ID}/deactivate`)
      .send();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: ALIAS_ID, active: false });
    expect(repo.deactivate).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      aliasId: ALIAS_ID,
      deactivatedBy: OWNER_ID,
      actorRole: 'owner',
    });
    expect(repo.deactivate).not.toHaveBeenCalledWith(
      expect.objectContaining({ deactivatedBy: CLERK_ID }),
    );
  });

  it('denies dispatchers and fails closed without a canonical actor ID', async () => {
    const dispatcherRepo = repository();
    expect(
      (
        await request(buildApp(dispatcherRepo, 'dispatcher'))
          .patch(`/api/entity-aliases/${ALIAS_ID}/deactivate`)
          .send()
      ).status,
    ).toBe(403);
    expect(dispatcherRepo.deactivate).not.toHaveBeenCalled();

    const missingActorRepo = repository();
    expect(
      (
        await request(buildApp(missingActorRepo, 'owner', undefined, true))
          .patch(`/api/entity-aliases/${ALIAS_ID}/deactivate`)
          .send()
      ).status,
    ).toBe(403);
    expect(missingActorRepo.deactivate).not.toHaveBeenCalled();
  });

  it('validates the alias ID and returns 404 for an unknown tenant-scoped alias', async () => {
    const repo = repository();
    expect(
      (
        await request(buildApp(repo, 'owner'))
          .patch('/api/entity-aliases/not-a-uuid/deactivate')
          .send()
      ).status,
    ).toBe(400);

    vi.mocked(repo.deactivate).mockResolvedValueOnce(null);
    const missing = await request(buildApp(repo, 'owner'))
      .patch(`/api/entity-aliases/${ALIAS_ID}/deactivate`)
      .send();
    expect(missing.status).toBe(404);
  });
});
