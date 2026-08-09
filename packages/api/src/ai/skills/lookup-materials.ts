/**
 * `lookup_materials` voice skill (Task 9, 2026-08-07 tradesperson plan) —
 * owner/technician asks to hear the pending shopping list ("what parts do
 * I need?", "read me the shopping list", "what materials are open on the
 * Patel job?").
 *
 * Tenant-scoped, read-only. Reads Task 8's `material_items` substrate
 * (src/materials/material-item.ts) via `MaterialItemRepository.listPending`
 * and summarizes up to 5 items by description + quantity. Optionally
 * scoped to one job when the caller's spoken jobReference resolved to a
 * verified `jobId` (JOB_REF_INTENTS membership — see entity-resolution.ts).
 * Bypasses the proposals pipeline, same as every other lookup_* skill.
 *
 * No permission gate: unlike `lookup_leads`/`lookup_catalog`, there is
 * deliberately NO entry for this intent in `LOOKUP_REQUIRED_PERMISSION`
 * (workers/voice-lookup-answer.ts) — any authenticated operator, technician
 * included, may hear the shopping list.
 *
 * "for tomorrow" / date-scoped asks — DELIBERATE non-filter: Task 8's
 * `MaterialItemListOptions` has only `jobId`, no `neededBy`/date filter,
 * and this skill does not extend that contract. A job-scoped ask
 * genuinely narrows via `jobId`; a bare date phrase like "tomorrow" is not
 * distinguished — the answer is always the tenant's (or job's) FULL
 * pending list. See `contracts/add-material.ts`'s module doc comment for
 * why `neededBy` has no sweep/filter consumer at all today.
 */
import type { MaterialItemRepository } from '../../materials/material-item';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';

export interface LookupMaterialsInput {
  tenantId: string;
  sessionId?: string;
  /** Verified jobId, when a job was named and resolved (JOB_REF_INTENTS). */
  jobId?: string;
}

export interface LookupMaterialsDeps {
  materialItemRepo: MaterialItemRepository;
  lookupEvents?: LookupEventService;
}

export interface LookupMaterialsItem {
  description: string;
  quantity: number;
  vendor?: string;
}

export type LookupMaterialsResult =
  | { status: 'found'; summary: string; data: { count: number; items: LookupMaterialsItem[] } }
  | { status: 'none'; summary: string; data: { count: 0; items: [] } }
  | { status: 'error'; summary: string; data: { error: string } };

const MAX_ITEMS_SPOKEN = 5;

export async function lookupMaterials(
  input: LookupMaterialsInput,
  deps: LookupMaterialsDeps,
): Promise<LookupMaterialsResult> {
  const start = Date.now();
  const record = async (
    resultStatus: 'found' | 'none' | 'error',
    resultCount: number,
    summary: string,
  ): Promise<void> => {
    if (!deps.lookupEvents) return;
    try {
      await deps.lookupEvents.record({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        intent: 'lookup_materials',
        resultStatus,
        resultCount,
        summary,
        latencyMs: Date.now() - start,
      });
    } catch {
      /* swallow — an audit-write failure never breaks the spoken turn */
    }
  };

  try {
    const items = await deps.materialItemRepo.listPending(
      input.tenantId,
      input.jobId ? { jobId: input.jobId } : undefined,
    );

    if (items.length === 0) {
      const summary = 'Your materials list is clear — nothing pending.';
      await record('none', 0, summary);
      return { status: 'none', summary, data: { count: 0, items: [] } };
    }

    const spoken = items.slice(0, MAX_ITEMS_SPOKEN);
    const summary =
      `${items.length} item${items.length === 1 ? '' : 's'} on the materials list: ` +
      spoken.map((m) => `${m.quantity}× ${m.description}`).join('; ') +
      (items.length > spoken.length ? `; and ${items.length - spoken.length} more` : '');
    await record('found', items.length, summary);
    return {
      status: 'found',
      summary,
      data: {
        count: items.length,
        items: spoken.map((m) => ({
          description: m.description,
          quantity: m.quantity,
          ...(m.vendor ? { vendor: m.vendor } : {}),
        })),
      },
    };
  } catch (err) {
    const summary = "I'm having trouble pulling up the materials list right now.";
    await record('error', 0, summary);
    return {
      status: 'error',
      summary,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}
