/**
 * A3-3 — every entity pick runs with a transaction runner.
 *
 * resolveProposalEntity takes its row lock (findByIdsForUpdate) and commits
 * its writes inside `deps.transactionRunner`. With the Pg repositories that
 * lock throws outside a tenant transaction, so a caller that wired the Pg
 * repos and forgot the runner built a pick that could only ever 500. The
 * runner was typed optional (and the route only forwarded it when given), so
 * nothing caught that until a request hit it.
 *
 * The `@ts-expect-error` lines are the contract: they stop compiling the
 * moment the runner becomes optional again. Check them with
 * `npx tsc --noEmit -p <a tsconfig that includes this file>`; at run time the
 * route is driven for real with the runner it was given.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { ResolveEntityDeps } from '../../src/proposals/resolve-entity';
import { createProposalsRouter } from '../../src/routes/proposals';
import { InMemoryProposalRepository, type Proposal } from '../../src/proposals/proposal';
import { InMemoryTransactionRunner, type TenantTransactionRunner } from '../../src/db/tenant-transaction';

const TENANT = 't-runner-required';
const PROPOSAL = 'p-runner-required';

function clarification(): Proposal {
  return {
    id: PROPOSAL,
    tenantId: TENANT,
    proposalType: 'voice_clarification',
    status: 'draft',
    summary: 'Which customer? "Bob" matched 2 records',
    createdBy: 'owner-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    payload: {
      transcript: 'invoice Bob',
      reason: 'ambiguous_entity',
      entityReference: 'Bob',
      entityCandidates: [
        { id: 'cust-a', label: 'Bob Smith', score: 0.82 },
        { id: 'cust-b', label: 'Bob Jones', score: 0.81 },
      ],
    },
    sourceContext: { source: 'voice', entityKind: 'customer', entityReference: 'Bob' },
  } as Proposal;
}

describe('A3-3 — a pick always has a transaction runner', () => {
  it('ResolveEntityDeps does not type-check without one', () => {
    const proposalRepo = new InMemoryProposalRepository();
    // @ts-expect-error transactionRunner is required: the Pg row lock needs its transaction
    const missing: ResolveEntityDeps = { proposalRepo };
    const present: ResolveEntityDeps = { proposalRepo, transactionRunner: new InMemoryTransactionRunner() };
    expect(missing.transactionRunner).toBeUndefined();
    expect(present.transactionRunner).toBeInstanceOf(InMemoryTransactionRunner);
  });

  it('createProposalsRouter does not type-check without one', () => {
    const proposalRepo = new InMemoryProposalRepository();
    // @ts-expect-error the router hands every pick its runner, so it must be given one
    const router = createProposalsRouter(proposalRepo);
    expect(router).toBeDefined();
  });

  it('the route runs the pick inside the runner it was given', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    await proposalRepo.create(clarification());
    const inner = new InMemoryTransactionRunner();
    const runs: string[] = [];
    const runner: TenantTransactionRunner = {
      run(tenantId, fn) {
        runs.push(tenantId);
        return inner.run(tenantId, fn);
      },
    };

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { auth: Record<string, string> }).auth = {
        userId: 'owner-1',
        sessionId: 'sess',
        tenantId: TENANT,
        role: 'owner',
      };
      next();
    });
    app.use('/api/proposals', createProposalsRouter(proposalRepo, runner));

    const res = await request(app)
      .post(`/api/proposals/${PROPOSAL}/resolve-entity`)
      .send({ candidateId: 'cust-b' });

    expect(res.status).toBe(200);
    expect(res.body.payload.customerId).toBe('cust-b');
    expect(runs).toEqual([TENANT]);
  });
});
