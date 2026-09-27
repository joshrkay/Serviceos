/**
 * #1405 — the chat card offers the "which accepted estimate?" candidates as a
 * one-tap pick, and that pick is a `PUT /api/proposals/:id {estimateId}`.
 * A pick is not just an id: the draft's lines, discount and tax must be
 * re-drafted from the picked estimate, exactly as a typed chat answer does.
 *
 * Seam: the proposals router's edit route (createProposalsRouter's trailing
 * `estimateRepo` parameter — a mis-wired argument is a silent no-op).
 *
 * Worked example (EST-0002): one taxable $1,200.00 line, $200.00 discount,
 * 8.25% tax.
 */
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createProposalsRouter } from '../../src/routes/proposals';
import { InMemoryProposalRepository, createProposal, missingFieldsFor } from '../../src/proposals/proposal';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { buildEstimate } from '../factories/estimate.factory';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = 'tenant-1405-pick';
const USER = 'user-1405-pick';
const CUSTOMER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const EST_1 = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const EST_2 = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const JOB_2 = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f';

describe('#1405 — PUT /api/proposals/:id picking the accepted estimate re-drafts the invoice', () => {
  it('replaces the placeholder lines with the picked estimate’s lines, discount and tax', async () => {
    const estimateRepo = new InMemoryEstimateRepository();
    const lines = [buildLineItem('li-b', 'Repipe kitchen', 1, 120000, 0, true)];
    await estimateRepo.create(
      buildEstimate({
        id: EST_2,
        tenantId: TENANT,
        jobId: JOB_2,
        estimateNumber: 'EST-0002',
        status: 'accepted',
        lineItems: lines,
        totals: calculateDocumentTotals(lines, 20000, 825),
      }),
    );

    const proposalRepo = new InMemoryProposalRepository();
    const proposal = createProposal({
      tenantId: TENANT,
      proposalType: 'draft_invoice',
      payload: {
        customerId: CUSTOMER,
        estimateReference: 'the accepted estimate',
        lineItems: [
          { description: 'Service as per accepted estimate', quantity: 1, unitPriceCents: 1000, totalCents: 1000 },
        ],
      },
      summary: 'Invoice the accepted estimate',
      createdBy: USER,
      missingFields: ['estimateId'],
      sourceContext: {
        pendingEntityAmbiguity: {
          entityKind: 'estimate',
          reference: 'the accepted estimate',
          refKey: 'estimateId',
          candidates: [
            { id: EST_1, name: 'EST-0001', hint: 'accepted · $1,000.00', score: 1 },
            { id: EST_2, name: 'EST-0002', hint: 'accepted · $1,082.50', score: 1 },
          ],
          partialRefs: {},
          attemptCount: 0,
        },
      },
    });
    await proposalRepo.create(proposal);

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: USER, sessionId: 's', tenantId: TENANT, role: 'owner' };
      next();
    });
    app.use(
      '/api/proposals',
      createProposalsRouter(
        proposalRepo,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        estimateRepo,
      ),
    );

    const res = await request(app).put(`/api/proposals/${proposal.id}`).send({ edits: { estimateId: EST_2 } });
    expect(res.status).toBe(200);

    const picked = (await proposalRepo.findById(TENANT, proposal.id))!;
    expect(picked.payload.estimateId).toBe(EST_2);
    expect(missingFieldsFor(picked)).toEqual([]);
    const pickedLines = picked.payload.lineItems as Array<{ description: string; unitPriceCents: number }>;
    expect(pickedLines.map((l) => [l.description, l.unitPriceCents])).toEqual([['Repipe kitchen', 120000]]);
    expect(picked.payload.discountCents).toBe(20000);
    expect(picked.payload.taxRateBps).toBe(825);
    expect(picked.status).toBe('draft');
  });
});
