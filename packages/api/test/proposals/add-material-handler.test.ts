/**
 * Task 9 (2026-08-07 tradesperson plan) — add_material proposal type +
 * execution handler, plus the lookup_materials classification-map
 * assertions (voice-intent-map.ts / intent-classifier.ts).
 *
 * `add_material` is a NEW capture-class proposal type: it adds a row to
 * the voice-captured shopping list (Task 8's `material_items` substrate,
 * src/materials/material-item.ts) — no money moves, and it's reversible
 * (the row can be marked purchased or simply ignored). LogExpense-family
 * execution posture: degrades to a synthetic-id passthrough without a
 * repo, persists for real when wired, audit emission is failure-soft.
 */
import { describe, it, expect } from 'vitest';
import {
  VALID_PROPOSAL_TYPES,
  actionClassForProposalType,
} from '../../src/proposals/proposal';
import { validateProposalPayload } from '../../src/proposals/contracts';
import { AddMaterialExecutionHandler } from '../../src/proposals/execution/add-material-handler';
import { InMemoryMaterialItemRepository } from '../../src/materials/material-item';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { Proposal } from '../../src/proposals/proposal';
import { intentToProposalType } from '../../src/proposals/voice-intent-map';
import { isLookupIntent } from '../../src/ai/orchestration/intent-classifier';

const TENANT = 't-1';
const JOB_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function makeProposal(payload: Record<string, unknown>): Proposal {
  const now = new Date();
  return {
    id: 'prop-1',
    tenantId: TENANT,
    proposalType: 'add_material',
    status: 'approved',
    payload,
    summary: 'Add material',
    createdBy: 'u-1',
    createdAt: now,
    updatedAt: now,
  };
}

describe('add_material proposal type', () => {
  it('is a valid proposal type classified as capture', () => {
    expect(VALID_PROPOSAL_TYPES).toContain('add_material');
    expect(actionClassForProposalType('add_material')).toBe('capture');
  });

  it('accepts a well-formed payload (description + quantity + jobId)', () => {
    const result = validateProposalPayload('add_material', {
      description: '3 boxes 1/2" PEX',
      quantity: 3,
      jobId: JOB_ID,
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a description-only payload, defaulting quantity to 1', () => {
    const result = validateProposalPayload('add_material', {
      description: 'Flue liner kit',
    });
    expect(result.valid).toBe(true);
  });

  it('accepts vendor and neededBy when supplied', () => {
    const result = validateProposalPayload('add_material', {
      description: '40-gallon water heater',
      quantity: 2,
      vendor: 'Ferguson',
      neededBy: '2026-09-10',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects an empty description', () => {
    const result = validateProposalPayload('add_material', { description: '' });
    expect(result.valid).toBe(false);
  });

  // Quality-review I5 — z.string().min(1) alone accepts a whitespace-only
  // string; material-item.ts's own validator rejects it AFTER trimming, so
  // without .trim() here too this payload would pass the draft-time
  // contract and then throw a ValidationError at execution instead of
  // failing cleanly at draft time.
  it('rejects a whitespace-only description', () => {
    const result = validateProposalPayload('add_material', { description: '   ' });
    expect(result.valid).toBe(false);
  });

  it('rejects a missing description', () => {
    const result = validateProposalPayload('add_material', { quantity: 2 });
    expect(result.valid).toBe(false);
  });

  it('rejects a zero or negative quantity', () => {
    expect(validateProposalPayload('add_material', { description: 'x', quantity: 0 }).valid).toBe(false);
    expect(validateProposalPayload('add_material', { description: 'x', quantity: -1 }).valid).toBe(false);
  });

  it('rejects a non-integer quantity', () => {
    const result = validateProposalPayload('add_material', { description: 'x', quantity: 2.5 });
    expect(result.valid).toBe(false);
  });

  it('rejects a quantity above the domain cap (same 1,000,000 cap Task 8 enforces)', () => {
    const result = validateProposalPayload('add_material', {
      description: 'x',
      quantity: 1_000_001,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a malformed jobId (not a UUID)', () => {
    const result = validateProposalPayload('add_material', {
      description: 'x',
      jobId: 'not-a-uuid',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a malformed neededBy (wrong shape)', () => {
    const result = validateProposalPayload('add_material', {
      description: 'x',
      neededBy: 'next Thursday',
    });
    expect(result.valid).toBe(false);
  });

  it('accepts a neededBy date already in the past (a shopping-list item can be overdue)', () => {
    const result = validateProposalPayload('add_material', {
      description: 'x',
      neededBy: '2020-01-01',
    });
    expect(result.valid).toBe(true);
  });
});

describe('AddMaterialExecutionHandler', () => {
  const ctx = { tenantId: TENANT, executedBy: 'u-1' };
  const goodPayload = {
    description: '3 boxes 1/2" PEX',
    quantity: 3,
    jobId: JOB_ID,
  };

  it('degrades to a synthetic-id passthrough when no repo is wired', async () => {
    const handler = new AddMaterialExecutionHandler();
    const result = await handler.execute(makeProposal(goodPayload), ctx);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toMatch(/[0-9a-f-]{36}/);
  });

  it('isFullyWired requires the material item repo', () => {
    expect(new AddMaterialExecutionHandler(new InMemoryMaterialItemRepository()).isFullyWired()).toBe(true);
    expect(new AddMaterialExecutionHandler().isFullyWired()).toBe(false);
  });

  it('persists a material_items row (read back via listPending) + emits a failure-soft audit event when wired', async () => {
    const materialItemRepo = new InMemoryMaterialItemRepository();
    const auditRepo = new InMemoryAuditRepository();
    const handler = new AddMaterialExecutionHandler(materialItemRepo, auditRepo);

    const result = await handler.execute(makeProposal(goodPayload), ctx);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();

    // Assert by reading back through listPending, not the result object —
    // proves the row is genuinely queryable through the same repo contract
    // lookup_materials will read from.
    const pending = await materialItemRepo.listPending(TENANT);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(result.resultEntityId);
    expect(pending[0].description).toBe('3 boxes 1/2" PEX');
    expect(pending[0].quantity).toBe(3);
    expect(pending[0].jobId).toBe(JOB_ID);
    expect(pending[0].createdBy).toBe('u-1');

    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('material.requested');
    expect(events[0].entityId).toBe(result.resultEntityId);
  });

  it('defaults quantity to 1 when the payload omits it', async () => {
    const materialItemRepo = new InMemoryMaterialItemRepository();
    const handler = new AddMaterialExecutionHandler(materialItemRepo);

    const result = await handler.execute(makeProposal({ description: 'Flue liner kit' }), ctx);
    expect(result.success).toBe(true);

    const pending = await materialItemRepo.listPending(TENANT);
    expect(pending[0].quantity).toBe(1);
    expect(pending[0].jobId).toBeUndefined();
  });

  it('carries vendor and neededBy through to the persisted row when supplied', async () => {
    const materialItemRepo = new InMemoryMaterialItemRepository();
    const handler = new AddMaterialExecutionHandler(materialItemRepo);

    const result = await handler.execute(
      makeProposal({
        description: '40-gallon water heater',
        quantity: 2,
        vendor: 'Ferguson',
        neededBy: '2026-09-10',
      }),
      ctx,
    );
    expect(result.success).toBe(true);

    const pending = await materialItemRepo.listPending(TENANT);
    expect(pending[0].vendor).toBe('Ferguson');
    expect(pending[0].neededBy?.toISOString().slice(0, 10)).toBe('2026-09-10');
  });

  it('fails cleanly on an invalid payload (empty description) without throwing', async () => {
    const handler = new AddMaterialExecutionHandler(new InMemoryMaterialItemRepository());
    const result = await handler.execute(makeProposal({ description: '' }), ctx);
    expect(result.success).toBe(false);
    // Quality-review M8 — pin the operator-facing copy, not just success:false.
    expect(result.error).toBe(
      'Could not determine the material to add (missing description or an invalid quantity).',
    );
  });

  it('replays the same resultEntityId without creating a second row when already executed', async () => {
    const materialItemRepo = new InMemoryMaterialItemRepository();
    const handler = new AddMaterialExecutionHandler(materialItemRepo);

    const already: Proposal = { ...makeProposal(goodPayload), resultEntityId: 'material-existing' };
    const result = await handler.execute(already, ctx);
    expect(result).toEqual({ success: true, resultEntityId: 'material-existing' });
    expect(await materialItemRepo.listPending(TENANT)).toHaveLength(0);
  });

  it('tenant isolation — a material item created for one tenant is invisible from another tenant', async () => {
    const materialItemRepo = new InMemoryMaterialItemRepository();
    const handler = new AddMaterialExecutionHandler(materialItemRepo);

    const result = await handler.execute(makeProposal(goodPayload), { tenantId: 't-2', executedBy: 'u-2' });
    expect(result.success).toBe(true);
    expect(await materialItemRepo.listPending(TENANT)).toHaveLength(0);
    expect(await materialItemRepo.listPending('t-2')).toHaveLength(1);
  });
});

describe('lookup_materials — read-only, not a proposal type', () => {
  it('intentToProposalType falls back to voice_clarification (lookup_materials is deliberately absent from INTENT_TO_PROPOSAL_TYPE)', () => {
    expect(intentToProposalType('lookup_materials')).toBe('voice_clarification');
  });

  it('isLookupIntent recognizes lookup_materials', () => {
    expect(isLookupIntent('lookup_materials')).toBe(true);
  });
});
