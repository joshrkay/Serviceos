/**
 * DELETE /api/users/me — post-COMMIT failure recovery.
 *
 * If commitRequestTransactionAndBegin throws AFTER its COMMIT made the
 * soft-delete durable (connection drop at the COMMIT/BEGIN boundary), the
 * route must compensate on a fresh connection outside the (possibly
 * unusable) request client — otherwise the caller is locked out locally
 * while their Clerk identity still exists. Isolated in its own file
 * because it partial-mocks the tenant-context module.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

vi.mock('../../src/middleware/tenant-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/tenant-context')>();
  return {
    ...actual,
    commitRequestTransactionAndBegin: vi.fn(),
  };
});

// eslint-disable-next-line import/first
import { commitRequestTransactionAndBegin } from '../../src/middleware/tenant-context';
// eslint-disable-next-line import/first
import { createUsersRouter } from '../../src/routes/users';
// eslint-disable-next-line import/first
import { InMemoryUserRepository } from '../../src/users/user';
// eslint-disable-next-line import/first
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = 'tenant-commit-failure';

describe('DELETE /api/users/me — commitRequestTransactionAndBegin failure', () => {
  let repo: InMemoryUserRepository;
  let techId: string;

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'clerk_tech',
        sessionId: 'sess-1',
        tenantId: TENANT,
        role: 'technician',
      };
      next();
    });
    app.use('/api/users', createUsersRouter(repo));
    return app;
  }

  beforeEach(async () => {
    vi.mocked(commitRequestTransactionAndBegin).mockReset();
    repo = new InMemoryUserRepository();
    techId = uuidv4();
    await repo.create!({
      id: techId, tenantId: TENANT, email: 'tech@example.com',
      role: 'technician', canFieldServe: false, clerkUserId: 'clerk_tech',
    });
  });

  it('restores the account on a fresh connection and responds 502', async () => {
    vi.mocked(commitRequestTransactionAndBegin).mockRejectedValue(
      new Error('connection terminated at COMMIT/BEGIN boundary'),
    );
    const res = await request(buildApp()).delete('/api/users/me');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('ACCOUNT_DELETE_FAILED');
    // The account is fully usable again — the durable stamp was compensated.
    expect(await repo.findById(TENANT, techId)).not.toBeNull();
  });

  it('responds 500 ACCOUNT_DELETE_INCONSISTENT when even the recovery restore fails', async () => {
    vi.mocked(commitRequestTransactionAndBegin).mockRejectedValue(new Error('boom'));
    const failingRestore = vi
      .spyOn(repo, 'restoreAccount')
      .mockRejectedValue(new Error('db down'));
    const res = await request(buildApp()).delete('/api/users/me');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('ACCOUNT_DELETE_INCONSISTENT');
    failingRestore.mockRestore();
  });
});
