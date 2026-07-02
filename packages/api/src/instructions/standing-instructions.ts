import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { AppError, NotFoundError, ValidationError } from '../shared/errors';

/**
 * UB-A1 (agent wave) — standing instructions.
 *
 * Persistent tenant-scoped directives the AI agents apply when drafting
 * (e.g. "always add a fuel surcharge", "never discount emergency calls").
 * This module is the domain layer: port interface + pure selection logic +
 * in-memory repo, mirroring the customer-group domain shape. Pg impl in
 * `pg-standing-instructions.ts` (migration 229). A later unit (UB-A2/A3)
 * adds the voice on-ramp and prompt injection; nothing here touches the
 * intent taxonomy or proposal pipeline.
 */

/** Hard cap on ACTIVE instructions stored per tenant (enforced at create). */
export const MAX_ACTIVE_STANDING_INSTRUCTIONS = 20;
/** Hard cap on instructions selected for injection into any single task. */
export const MAX_APPLICABLE_STANDING_INSTRUCTIONS = 5;
export const MAX_INSTRUCTION_LENGTH = 500;

/**
 * Scope narrows where an instruction applies. All fields optional; an empty
 * scope means "applies everywhere". `amountCents` is an optional monetary
 * parameter for the instruction (integer cents — never floating point, per
 * core patterns), e.g. "add a $50 trip fee" carries amountCents: 5000.
 * `.strict()` so junk keys never land in the JSONB column.
 */
export const standingInstructionScopeSchema = z
  .object({
    intents: z.array(z.string().min(1)).optional(),
    tradeCategories: z.array(z.string().min(1)).optional(),
    customerSegment: z.enum(['new', 'existing', 'all']).optional(),
    amountCents: z.number().int().nonnegative().optional(),
  })
  .strict();

export type StandingInstructionScope = z.infer<typeof standingInstructionScopeSchema>;

export type StandingInstructionSource = 'proposal' | 'settings';

export interface StandingInstruction {
  id: string;
  tenantId: string;
  instruction: string;
  scope: StandingInstructionScope;
  active: boolean;
  source: StandingInstructionSource;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deactivatedAt: Date | null;
  deactivatedBy: string | null;
}

/** Request-body contract for POST /api/standing-instructions. */
export const createStandingInstructionSchema = z.object({
  instruction: z.string().trim().min(1).max(MAX_INSTRUCTION_LENGTH),
  scope: standingInstructionScopeSchema.optional(),
});

export interface CreateStandingInstructionInput {
  tenantId: string;
  instruction: string;
  scope?: StandingInstructionScope;
  source: StandingInstructionSource;
  createdBy: string;
  actorRole?: string;
}

/**
 * Thrown by repositories when a create would exceed the per-tenant cap on
 * ACTIVE instructions. statusCode 422: the request is well-formed but the
 * tenant's current state can't accept it (deactivate one first).
 */
export class StandingInstructionLimitError extends AppError {
  constructor(limit: number = MAX_ACTIVE_STANDING_INSTRUCTIONS) {
    super(
      'STANDING_INSTRUCTION_LIMIT',
      `Tenant already has ${limit} active standing instructions — deactivate one before adding another`,
      422,
      { limit }
    );
    this.name = 'StandingInstructionLimitError';
  }
}

export interface StandingInstructionRepository {
  /** Persists a fully-built instruction. Throws StandingInstructionLimitError at the active cap. */
  create(instruction: StandingInstruction): Promise<StandingInstruction>;
  findById(tenantId: string, id: string): Promise<StandingInstruction | null>;
  /** Active instructions only, newest first. */
  listActive(tenantId: string): Promise<StandingInstruction[]>;
  /** Active + deactivated, newest first. */
  listAll(tenantId: string): Promise<StandingInstruction[]>;
  /**
   * Soft-deactivates an ACTIVE instruction. Returns the updated row, or null
   * when the row doesn't exist or is already inactive.
   */
  deactivate(tenantId: string, id: string, deactivatedBy: string): Promise<StandingInstruction | null>;
}

export interface InstructionSelectionContext {
  intentType: string;
  customerSegment?: 'new' | 'existing';
}

/**
 * Pure selection of the instructions applicable to one task.
 *
 * Filtering:
 * - inactive instructions never apply (defensive — callers should pass
 *   active lists, but a stale cache must not inject a revoked directive);
 * - an intent-scoped instruction applies only when `intentType` is listed;
 * - a segment-scoped instruction (`new`/`existing`) applies only when the
 *   context segment is known and matches (`all` always applies). Unknown
 *   segment → excluded: never inject a directive we can't verify applies.
 *
 * Priority (most specific wins): exact intent match > tradeCategory-scoped >
 * unscoped. Newest-first within a band, capped at
 * MAX_APPLICABLE_STANDING_INSTRUCTIONS so prompt injection stays bounded.
 */
export function selectApplicableInstructions(
  instructions: StandingInstruction[],
  context: InstructionSelectionContext
): StandingInstruction[] {
  const banded = instructions
    .filter((instruction) => {
      if (!instruction.active) return false;
      const scope = instruction.scope;
      if (scope.intents && scope.intents.length > 0 && !scope.intents.includes(context.intentType)) {
        return false;
      }
      if (scope.customerSegment && scope.customerSegment !== 'all') {
        if (!context.customerSegment || context.customerSegment !== scope.customerSegment) {
          return false;
        }
      }
      return true;
    })
    .map((instruction) => ({ instruction, band: priorityBand(instruction, context.intentType) }));

  banded.sort((a, b) => {
    if (a.band !== b.band) return a.band - b.band;
    const byRecency = b.instruction.createdAt.getTime() - a.instruction.createdAt.getTime();
    if (byRecency !== 0) return byRecency;
    // Deterministic tie-break for identical timestamps (bulk inserts in tests).
    return a.instruction.id < b.instruction.id ? 1 : -1;
  });

  return banded.slice(0, MAX_APPLICABLE_STANDING_INSTRUCTIONS).map((b) => b.instruction);
}

function priorityBand(instruction: StandingInstruction, intentType: string): number {
  const scope = instruction.scope;
  if (scope.intents && scope.intents.length > 0 && scope.intents.includes(intentType)) return 0;
  if (scope.tradeCategories && scope.tradeCategories.length > 0) return 1;
  return 2;
}

export async function createStandingInstruction(
  input: CreateStandingInstructionInput,
  repository: StandingInstructionRepository,
  auditRepo?: AuditRepository
): Promise<StandingInstruction> {
  const text = input.instruction.trim();
  if (!text) throw new ValidationError('instruction is required');
  if (text.length > MAX_INSTRUCTION_LENGTH) {
    throw new ValidationError(`instruction must be ${MAX_INSTRUCTION_LENGTH} characters or fewer`);
  }
  const scopeResult = standingInstructionScopeSchema.safeParse(input.scope ?? {});
  if (!scopeResult.success) {
    throw new ValidationError('Invalid scope', {
      fields: scopeResult.error.flatten().fieldErrors,
    });
  }

  const now = new Date();
  const instruction: StandingInstruction = {
    id: uuidv4(),
    tenantId: input.tenantId,
    instruction: text,
    scope: scopeResult.data,
    active: true,
    source: input.source,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    deactivatedAt: null,
    deactivatedBy: null,
  };
  const created = await repository.create(instruction);

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.createdBy,
        actorRole: input.actorRole ?? 'unknown',
        eventType: 'standing_instruction.created',
        entityType: 'standing_instruction',
        entityId: created.id,
        metadata: { instruction: created.instruction, scope: created.scope, source: created.source },
      })
    );
  }
  return created;
}

export async function deactivateStandingInstruction(
  tenantId: string,
  id: string,
  repository: StandingInstructionRepository,
  actorId: string,
  auditRepo?: AuditRepository,
  actorRole?: string
): Promise<StandingInstruction> {
  const existing = await repository.findById(tenantId, id);
  if (!existing) throw new NotFoundError('Standing instruction', id);
  // Idempotent: deactivating an already-inactive instruction is a no-op
  // (no second audit event).
  if (!existing.active) return existing;

  const deactivated = (await repository.deactivate(tenantId, id, actorId)) ?? existing;

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: actorRole ?? 'unknown',
        eventType: 'standing_instruction.deactivated',
        entityType: 'standing_instruction',
        entityId: deactivated.id,
        metadata: { instruction: deactivated.instruction },
      })
    );
  }
  return deactivated;
}

export class InMemoryStandingInstructionRepository implements StandingInstructionRepository {
  private instructions: Map<string, StandingInstruction> = new Map();

  async create(instruction: StandingInstruction): Promise<StandingInstruction> {
    const activeCount = Array.from(this.instructions.values()).filter(
      (i) => i.tenantId === instruction.tenantId && i.active
    ).length;
    if (activeCount >= MAX_ACTIVE_STANDING_INSTRUCTIONS) {
      throw new StandingInstructionLimitError();
    }
    this.instructions.set(instruction.id, { ...instruction });
    return { ...instruction };
  }

  async findById(tenantId: string, id: string): Promise<StandingInstruction | null> {
    const found = this.instructions.get(id);
    if (!found || found.tenantId !== tenantId) return null;
    return { ...found };
  }

  async listActive(tenantId: string): Promise<StandingInstruction[]> {
    return this.list(tenantId, true);
  }

  async listAll(tenantId: string): Promise<StandingInstruction[]> {
    return this.list(tenantId, false);
  }

  async deactivate(
    tenantId: string,
    id: string,
    deactivatedBy: string
  ): Promise<StandingInstruction | null> {
    const found = this.instructions.get(id);
    if (!found || found.tenantId !== tenantId || !found.active) return null;
    const now = new Date();
    const updated: StandingInstruction = {
      ...found,
      active: false,
      deactivatedAt: now,
      deactivatedBy,
      updatedAt: now,
    };
    this.instructions.set(id, updated);
    return { ...updated };
  }

  private list(tenantId: string, activeOnly: boolean): StandingInstruction[] {
    return Array.from(this.instructions.values())
      .filter((i) => i.tenantId === tenantId && (!activeOnly || i.active))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((i) => ({ ...i }));
  }
}
