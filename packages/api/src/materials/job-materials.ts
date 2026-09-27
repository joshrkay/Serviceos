/**
 * #1406 D3 — a job's parts list (the job-detail "Parts" sheet), persisted
 * through `material_items`.
 *
 * The sheet edits the WHOLE list and saves it at once, so the write is a
 * reconcile: rows the client still lists keep their id (a quantity change
 * updates them), rows it no longer lists are cancelled (kept for the audit
 * trail, hidden from the list), and anything without a known id is created.
 * Every row-level change emits its own audit event.
 */
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { MaterialCategory, MaterialItem, MaterialItemRepository } from './material-item';

export interface JobMaterialInput {
  /** Id of an existing row on this job; anything else is treated as new. */
  id?: string;
  name: string;
  partNumber?: string;
  quantity: number;
  /** Integer cents — never float. */
  unitCostCents?: number;
  category?: MaterialCategory;
}

export interface JobMaterialsActor {
  tenantId: string;
  actorId: string;
  actorRole: string;
}

export interface JobMaterialsDeps {
  materialItemRepo: MaterialItemRepository;
  auditRepo: AuditRepository;
}

export async function listJobMaterials(
  tenantId: string,
  jobId: string,
  deps: Pick<JobMaterialsDeps, 'materialItemRepo'>,
): Promise<MaterialItem[]> {
  return deps.materialItemRepo.listForJob(tenantId, jobId);
}

export async function saveJobMaterials(
  actor: JobMaterialsActor,
  jobId: string,
  items: JobMaterialInput[],
  deps: JobMaterialsDeps,
): Promise<MaterialItem[]> {
  const { tenantId } = actor;
  const existing = await deps.materialItemRepo.listForJob(tenantId, jobId);
  const existingById = new Map(existing.map((m) => [m.id, m]));
  const kept = new Set<string>();

  const audit = (eventType: string, item: MaterialItem, metadata: Record<string, unknown>) =>
    deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: actor.actorId,
        actorRole: actor.actorRole,
        eventType,
        entityType: 'material_item',
        entityId: item.id,
        metadata: { jobId, ...metadata },
      }),
    );

  for (const input of items) {
    const current = input.id ? existingById.get(input.id) : undefined;
    if (current) {
      kept.add(current.id);
      if (current.quantity !== input.quantity) {
        const updated = await deps.materialItemRepo.updateQuantity(tenantId, current.id, input.quantity);
        if (updated) {
          await audit('material_item.updated', updated, {
            fromQuantity: current.quantity,
            toQuantity: input.quantity,
          });
        }
      }
      continue;
    }
    const created = await deps.materialItemRepo.create({
      tenantId,
      jobId,
      description: input.name,
      quantity: input.quantity,
      ...(input.partNumber ? { partNumber: input.partNumber } : {}),
      ...(input.unitCostCents !== undefined ? { unitCostCents: input.unitCostCents } : {}),
      ...(input.category ? { category: input.category } : {}),
      createdBy: actor.actorId,
    });
    await audit('material_item.created', created, {
      quantity: created.quantity,
      ...(created.unitCostCents !== undefined ? { unitCostCents: created.unitCostCents } : {}),
    });
  }

  for (const row of existing) {
    if (kept.has(row.id)) continue;
    const cancelled = await deps.materialItemRepo.cancel(tenantId, row.id);
    if (cancelled) await audit('material_item.cancelled', cancelled, {});
  }

  return deps.materialItemRepo.listForJob(tenantId, jobId);
}
