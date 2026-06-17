/**
 * U7 — record structured correction lessons on proposal execution.
 *
 * This is the missing call-site glue between the executor's `onExecuted` seam
 * and the (already-built, integration-tested) correction-loop machinery. For a
 * SUCCEEDED execution it:
 *   1. diffs the AI's drafted payload (proposals.payload) against the
 *      as-executed payload (proposal_executions.executed_payload),
 *   2. runs the conservative structured extractor over the typed deltas,
 *   3. records + forward-applies any lessons (recordCorrectionLessons).
 *
 * Lessons are only recorded for EXECUTED (i.e. already human-approved)
 * proposals, so the config cascade stays behind the approval gate. The whole
 * thing is failure-soft at the call site — a lesson-record error must never
 * break execution.
 *
 * Note: proposal line items don't carry a catalog SKU binding, so
 * `part_price_changed` lessons can't be grounded here (skuPriceCents stays
 * empty); the labor-rate and banned-phrase lessons are what this surfaces.
 * scope_reclassified is intentionally off (no template-weight store yet → no
 * resolveTemplate passed).
 */
import type { LineItem } from '../../shared/billing-engine';
import { computeInvoiceDeltas } from '../../ai/evaluation/invoice-edit-delta';
import type { ProposalRepository } from '../../proposals/proposal';
import type { ProposalExecutionRepository } from '../../proposals/proposal-execution';
import type { SettingsRepository } from '../../settings/settings';
import type { AuditRepository } from '../../audit/audit';
import {
  extractCorrectionLessons,
  type ExtractorConfigSnapshot,
  type ExtractorLineItem,
} from './correction-extractor';
import { recordCorrectionLessons } from './apply-undo';
import { localDateFor, type CorrectionLesson, type CorrectionLessonRepository } from './correction-lesson';
import type { ConfigPorts } from './lesson-applicator';

const DEFAULT_TIMEZONE = 'America/New_York';

export interface RecordOnExecutionInput {
  tenantId: string;
  proposalId: string;
}

export interface RecordOnExecutionDeps {
  proposalRepo: ProposalRepository;
  proposalExecutionRepo: ProposalExecutionRepository;
  settingsRepo: SettingsRepository;
  lessonRepo: CorrectionLessonRepository;
  ports: ConfigPorts;
  auditRepo: AuditRepository;
}

function lineItemsOf(payload: Record<string, unknown> | undefined): LineItem[] {
  const items = payload?.lineItems;
  return Array.isArray(items) ? (items as LineItem[]) : [];
}

function messageOf(payload: Record<string, unknown> | undefined): string | undefined {
  const m = payload?.customerMessage;
  return typeof m === 'string' ? m : undefined;
}

/**
 * computeInvoiceDeltas diffs the INVOICE price field (`unitPriceCents`), but
 * estimate payloads carry their integer-cents price in `unitPrice`. Without
 * this normalization an estimate's labor-rate edit produces no `price_changed`
 * delta (undefined !== undefined), so the extractor sees nothing and the lesson
 * is silently lost — and estimates are exactly where labor-rate corrections
 * happen. Surface the cents under `unitPriceCents` for the diff, keeping the
 * rest of the line (id/category/description) intact for the extractor.
 */
function normalizeForDelta(items: LineItem[]): LineItem[] {
  return items.map((li) => {
    const rec = li as unknown as Record<string, unknown>;
    const cents =
      typeof rec.unitPriceCents === 'number'
        ? rec.unitPriceCents
        : typeof rec.unitPrice === 'number'
          ? rec.unitPrice
          : undefined;
    return cents !== undefined ? ({ ...li, unitPriceCents: cents } as LineItem) : li;
  });
}

/**
 * Extract + record correction lessons for one succeeded execution. Returns the
 * persisted lessons (empty when the edit had no clear pattern, or the proposal
 * isn't a line-item document).
 */
export async function recordCorrectionLessonsOnExecution(
  input: RecordOnExecutionInput,
  deps: RecordOnExecutionDeps,
): Promise<CorrectionLesson[]> {
  const { tenantId, proposalId } = input;

  const proposal = await deps.proposalRepo.findById(tenantId, proposalId);
  if (!proposal) return [];

  const execution = await deps.proposalExecutionRepo.findLatestByProposal(tenantId, proposalId);
  if (!execution || execution.status !== 'succeeded') return [];

  const drafted = (proposal.payload ?? {}) as Record<string, unknown>;
  const executed = execution.executedPayload ?? {};

  const draftedItems = lineItemsOf(drafted);
  const executedItems = lineItemsOf(executed);
  // Only line-item documents (estimates/invoices) carry edits worth learning.
  if (draftedItems.length === 0 && executedItems.length === 0) return [];

  const deltas = computeInvoiceDeltas(
    { lineItems: normalizeForDelta(draftedItems), customerMessage: messageOf(drafted) },
    { lineItems: normalizeForDelta(executedItems), customerMessage: messageOf(executed) },
  );
  if (deltas.length === 0) return [];

  const settings = await deps.settingsRepo.findByTenant(tenantId);
  const config: ExtractorConfigSnapshot = {
    laborRateCents: settings?.laborRateCentsPerHour ?? null,
    // Line items don't carry catalogItemId, so part-price lessons stay dormant.
    skuPriceCents: {},
    bannedPhrases: settings?.brandVoice?.banned_phrases ?? [],
    templateWeights: {},
  };

  const lineItems: ExtractorLineItem[] = executedItems.map((li) => ({
    id: li.id,
    ...(li.category ? { category: li.category } : {}),
    ...(li.description ? { description: li.description } : {}),
  }));

  const drafts = extractCorrectionLessons({ deltas, lineItems, config });
  if (drafts.length === 0) return [];

  const tz = settings?.timezone || DEFAULT_TIMEZONE;
  const localDate = localDateFor(execution.executedAt, tz);

  return recordCorrectionLessons(
    {
      tenantId,
      sourceProposalId: proposalId,
      ownerId: execution.executedBy,
      localDate,
      drafts,
    },
    { repository: deps.lessonRepo, ports: deps.ports, auditRepo: deps.auditRepo },
  );
}
