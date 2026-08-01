import crypto from 'node:crypto';
import {
  entityAliasEntityKindSchema,
  type AdoptEntityAliasPayload,
  type EntityAliasEntityKind,
  type EntityAliasSource,
} from '@ai-service-os/shared';
import { createAuditEvent, type AuditRepository } from '../../audit/audit';
import type { Role } from '../../auth/rbac';
import {
  createProposal,
  type Proposal,
  type ProposalRepository,
} from '../../proposals/proposal';
import { adoptEntityAliasPayloadSchema } from '../../proposals/contracts/adopt-entity-alias';
import { ConflictError, ValidationError } from '../../shared/errors';
import { uuidSchema } from '../../shared/validation';
import { normalizeEntityAlias } from './entity-alias';

const ENTITY_ID_FIELD: Record<EntityAliasEntityKind, string> = {
  customer: 'customerId',
  job: 'jobId',
  appointment: 'appointmentId',
  invoice: 'invoiceId',
  estimate: 'estimateId',
  technician: 'technicianId',
};

interface CandidateCaptureBase {
  tenantId: string;
  actorId: string;
  actorRole: Role;
  groundingProposal: Proposal;
}

export type EntityAliasCandidateCaptureInput =
  | (CandidateCaptureBase & {
      source: 'entity_picker';
      selectedEntityId: string;
    })
  | (CandidateCaptureBase & {
      source: 'proposal_edit';
      updatedProposal: Proposal;
      editedFields: string[];
    });

export interface EntityAliasCandidateCapture {
  capture(input: EntityAliasCandidateCaptureInput): Promise<Proposal[]>;
}

export interface EntityAliasCandidateServiceDeps {
  proposalRepo: ProposalRepository;
  auditRepo: AuditRepository;
}

interface GroundedCandidate {
  payload: AdoptEntityAliasPayload;
  normalizedAlias: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function sourceAlias(value: string): string {
  normalizeEntityAlias(value);
  return value.trim().replace(/\s+/gu, ' ');
}

function parseGroundedPayload(input: {
  alias: string;
  entityKind: EntityAliasEntityKind;
  entityId: string;
  source: EntityAliasSource;
  groundedProposalId: string;
}): GroundedCandidate {
  const parsed = adoptEntityAliasPayloadSchema.safeParse({
    ...input,
    alias: sourceAlias(input.alias),
  });
  if (!parsed.success) {
    throw new ValidationError('Invalid grounded entity alias candidate', {
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      ),
    });
  }
  return {
    payload: parsed.data,
    normalizedAlias: normalizeEntityAlias(parsed.data.alias),
  };
}

function assertGroundingTenant(input: EntityAliasCandidateCaptureInput): void {
  if (
    input.groundingProposal.tenantId !== input.tenantId ||
    (input.source === 'proposal_edit' &&
      (input.updatedProposal.tenantId !== input.tenantId ||
        input.updatedProposal.id !== input.groundingProposal.id))
  ) {
    throw new ValidationError('Entity alias grounding does not match the source proposal');
  }
}

function pickerCandidate(
  input: Extract<EntityAliasCandidateCaptureInput, { source: 'entity_picker' }>,
): GroundedCandidate {
  const sourceContext = asRecord(input.groundingProposal.sourceContext);
  const kindResult = entityAliasEntityKindSchema.safeParse(sourceContext.entityKind);
  if (!kindResult.success || typeof sourceContext.entityReference !== 'string') {
    throw new ValidationError('Entity picker grounding context is incomplete');
  }
  const candidates = Array.isArray(sourceContext.entityCandidates)
    ? sourceContext.entityCandidates
    : [];
  const selected = candidates
    .map(asRecord)
    .find((candidate) => candidate.id === input.selectedEntityId);
  if (!selected) {
    throw new ValidationError('Selected entity is not grounded by the source proposal');
  }
  if (
    typeof selected.kind === 'string' &&
    selected.kind !== kindResult.data
  ) {
    throw new ValidationError('Selected entity kind does not match the source proposal');
  }
  return parseGroundedPayload({
    alias: sourceContext.entityReference,
    entityKind: kindResult.data,
    entityId: input.selectedEntityId,
    source: input.source,
    groundedProposalId: input.groundingProposal.id,
  });
}

function pendingReferences(proposal: Proposal): Array<{
  kind: EntityAliasEntityKind;
  reference: string;
}> {
  const raw = asRecord(proposal.sourceContext).pendingReference;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const record = asRecord(entry);
    const kind = entityAliasEntityKindSchema.safeParse(record.kind);
    return kind.success && typeof record.reference === 'string'
      ? [{ kind: kind.data, reference: record.reference }]
      : [];
  });
}

export function clearPendingReferencesForEdit(
  sourceContext: Record<string, unknown>,
  editedFields: readonly string[],
  updatedPayload: Record<string, unknown>,
): { sourceContext: Record<string, unknown>; cleared: boolean } {
  const raw = sourceContext.pendingReference;
  if (!Array.isArray(raw)) return { sourceContext, cleared: false };
  const edited = new Set(editedFields);
  const remaining = raw.filter((entry) => {
    const record = asRecord(entry);
    const kind = entityAliasEntityKindSchema.safeParse(record.kind);
    if (!kind.success) return true;
    const field = ENTITY_ID_FIELD[kind.data];
    return !(
      edited.has(field) &&
      uuidSchema.safeParse(updatedPayload[field]).success
    );
  });
  if (remaining.length === raw.length) {
    return { sourceContext, cleared: false };
  }
  const next = { ...sourceContext };
  if (remaining.length > 0) next.pendingReference = remaining;
  else delete next.pendingReference;
  return { sourceContext: next, cleared: true };
}

function editCandidates(
  input: Extract<EntityAliasCandidateCaptureInput, { source: 'proposal_edit' }>,
): GroundedCandidate[] {
  const edited = new Set(input.editedFields);
  const stillPending = pendingReferences(input.updatedProposal);
  return pendingReferences(input.groundingProposal).flatMap((pending) => {
    const field = ENTITY_ID_FIELD[pending.kind];
    if (!edited.has(field)) return [];
    const entityId = input.updatedProposal.payload[field];
    if (typeof entityId !== 'string' || !uuidSchema.safeParse(entityId).success) {
      throw new ValidationError('A grounded proposal edit must select a canonical entity ID');
    }
    if (
      stillPending.some(
        (entry) =>
          entry.kind === pending.kind &&
          normalizeEntityAlias(entry.reference) === normalizeEntityAlias(pending.reference),
      )
    ) {
      return [];
    }
    return [
      parseGroundedPayload({
        alias: pending.reference,
        entityKind: pending.kind,
        entityId,
        source: input.source,
        groundedProposalId: input.groundingProposal.id,
      }),
    ];
  });
}

function groundedCandidates(input: EntityAliasCandidateCaptureInput): GroundedCandidate[] {
  assertGroundingTenant(input);
  return input.source === 'entity_picker'
    ? [pickerCandidate(input)]
    : editCandidates(input);
}

function candidateIdempotencyKey(candidate: GroundedCandidate): string {
  const { entityKind, entityId } = candidate.payload;
  const digest = crypto
    .createHash('sha256')
    .update(`${entityKind}\0${candidate.normalizedAlias}\0${entityId}`)
    .digest('hex');
  return `entity-alias-candidate:v1:${digest}`;
}

async function findExisting(
  tenantId: string,
  idempotencyKey: string,
  proposalRepo: ProposalRepository,
): Promise<Proposal | null> {
  if (proposalRepo.findByIdempotencyKey) {
    return proposalRepo.findByIdempotencyKey(tenantId, idempotencyKey);
  }
  const proposals = await proposalRepo.findByTenant(tenantId);
  return proposals.find((proposal) => proposal.idempotencyKey === idempotencyKey) ?? null;
}

function assertAliasProposal(proposal: Proposal | null): Proposal | null {
  if (!proposal) return null;
  if (proposal.proposalType !== 'adopt_entity_alias') {
    throw new ConflictError('Entity alias candidate idempotency key is already in use');
  }
  return proposal;
}

async function auditCandidate(
  input: EntityAliasCandidateCaptureInput,
  candidate: GroundedCandidate,
  proposal: Proposal,
  auditRepo: AuditRepository,
): Promise<void> {
  const existing = await auditRepo.findByEntity(
    input.tenantId,
    'proposal',
    proposal.id,
  );
  if (existing.some((event) => event.eventType === 'entity_alias.candidate_created')) {
    return;
  }
  await auditRepo.create(
    createAuditEvent({
      tenantId: input.tenantId,
      actorId: input.actorId,
      actorRole: input.actorRole,
      eventType: 'entity_alias.candidate_created',
      entityType: 'proposal',
      entityId: proposal.id,
      correlationId: input.groundingProposal.id,
      metadata: {
        entityKind: candidate.payload.entityKind,
        entityId: candidate.payload.entityId,
        source: candidate.payload.source,
        groundedProposalId: input.groundingProposal.id,
      },
    }),
  );
}

async function persistCandidate(
  input: EntityAliasCandidateCaptureInput,
  candidate: GroundedCandidate,
  deps: EntityAliasCandidateServiceDeps,
): Promise<Proposal> {
  const idempotencyKey = candidateIdempotencyKey(candidate);
  const existing = assertAliasProposal(
    await findExisting(input.tenantId, idempotencyKey, deps.proposalRepo),
  );
  if (existing) {
    await auditCandidate(input, candidate, existing, deps.auditRepo);
    return existing;
  }

  const draft = createProposal({
    tenantId: input.tenantId,
    proposalType: 'adopt_entity_alias',
    payload: candidate.payload,
    summary:
      `Learn “${candidate.payload.alias}” as a ${candidate.payload.entityKind} alias?`,
    createdBy: input.actorId,
    targetEntityType: candidate.payload.entityKind,
    targetEntityId: candidate.payload.entityId,
    idempotencyKey,
    sourceContext: {
      candidateSource: candidate.payload.source,
      groundedProposalId: input.groundingProposal.id,
    },
  });

  let proposal: Proposal;
  try {
    proposal = await deps.proposalRepo.create({
      ...draft,
      status: 'ready_for_review',
    });
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    const raced = assertAliasProposal(
      await findExisting(input.tenantId, idempotencyKey, deps.proposalRepo),
    );
    if (!raced) throw error;
    proposal = raced;
  }
  await auditCandidate(input, candidate, proposal, deps.auditRepo);
  return proposal;
}

export async function captureEntityAliasCandidates(
  input: EntityAliasCandidateCaptureInput,
  deps: EntityAliasCandidateServiceDeps,
): Promise<Proposal[]> {
  const candidates = groundedCandidates(input);
  const unique = new Map<string, GroundedCandidate>();
  for (const candidate of candidates) {
    unique.set(candidateIdempotencyKey(candidate), candidate);
  }
  return Promise.all(
    [...unique.values()].map((candidate) => persistCandidate(input, candidate, deps)),
  );
}

export function createEntityAliasCandidateService(
  deps: EntityAliasCandidateServiceDeps,
): EntityAliasCandidateCapture {
  return {
    capture: (input) => captureEntityAliasCandidates(input, deps),
  };
}
