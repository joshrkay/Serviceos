import { WorkerHandler, QueueMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import { ProposalRepository, ProposalType } from '../proposals/proposal';
import { ProposalExecutionRepository } from '../proposals/proposal-execution';
import {
  EMBEDDING_MODEL,
  KnowledgeChunkRepository,
  KnowledgeChunkSourceType,
} from '../ai/training/knowledge-chunks';
import { EmbeddingProvider } from '../ai/providers/openai-compatible';
import { RetrievalEvalRunRepository } from '../ai/training/retrieval-eval-run';
import { scrubPii } from '../ai/training/scrub';

/**
 * proposal-correction-worker — Phase 4a-1 of the inbound-CSR RAG
 * architecture (writers).
 *
 * Triggered by the ProposalExecutor's `onExecuted` callback. For each
 * successful execution:
 *
 *   1. Reads the AI's drafted payload from `proposals.payload`
 *      (immutable).
 *   2. Reads the as-executed payload from
 *      `proposal_executions.executed_payload` (latest row for the
 *      proposal).
 *   3. Computes the top-level diff. v1 limits to top-level keys to
 *      keep correction chunks small + human-readable; deep diff is a
 *      follow-up if dispatcher edits prove complex.
 *   4. **If non-empty diff**: emits a chunk into `knowledge_chunks`
 *      with `source_type='proposal_correction'`, source_id is the
 *      execution id. Text is human-readable: "AI drafted X={a};
 *      dispatcher set X={b}; intent={proposalType}".
 *   5. **If empty diff (clean approval)**: no chunk written. If a
 *      `retrieval_eval_runs` row is linked via
 *      `proposal.metadata.retrievalEvalRunId`, calls `attachOutcome`
 *      with `'approved_no_edits'` to close the eval loop.
 *
 * Failure-soft per step. Idempotent at the row level via the
 * `knowledge_chunks` ON CONFLICT semantics.
 */

const SOURCE_TYPE: KnowledgeChunkSourceType = 'proposal_correction';

export interface ProposalCorrectionPayload {
  tenantId: string;
  proposalId: string;
  /** Optional — when omitted the worker uses the latest execution row. */
  executionId?: string;
}

export interface ProposalCorrectionDeps {
  proposalRepo: ProposalRepository;
  proposalExecutionRepo: ProposalExecutionRepository;
  knowledgeChunkRepo: KnowledgeChunkRepository;
  embeddings: EmbeddingProvider;
  /** Optional; when set, clean approvals close the linked eval loop. */
  retrievalEvalRunRepo?: RetrievalEvalRunRepository;
}

interface FieldDiff {
  field: string;
  drafted: unknown;
  executed: unknown;
}

/**
 * Top-level diff between two JSONB payloads. Differences are identified
 * by serialized-value comparison (handles nested objects without
 * recursing into them — those just show up as the object literal in
 * the chunk text). Skips fields with both sides equal to undefined.
 */
export function computeTopLevelDiff(
  drafted: Record<string, unknown>,
  executed: Record<string, unknown>,
): FieldDiff[] {
  const fields = new Set<string>([...Object.keys(drafted), ...Object.keys(executed)]);
  const diffs: FieldDiff[] = [];
  for (const field of fields) {
    const a = drafted[field];
    const b = executed[field];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffs.push({ field, drafted: a, executed: b });
    }
  }
  return diffs.sort((x, y) => x.field.localeCompare(y.field));
}

function formatValue(v: unknown): string {
  if (v === undefined) return '<unset>';
  if (v === null) return '<null>';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/**
 * Render the diff into the chunk body. One field per line so the LLM
 * can pull patterns at retrieval time without parsing JSON.
 */
function buildCorrectionChunkText(
  diffs: readonly FieldDiff[],
  proposalType: ProposalType,
): string {
  const lines = diffs.map(
    (d) => `  ${d.field}: AI drafted ${formatValue(d.drafted)} → dispatcher set ${formatValue(d.executed)}`,
  );
  return [
    `intent=${proposalType}`,
    `Dispatcher edited ${diffs.length} field${diffs.length === 1 ? '' : 's'}:`,
    ...lines,
  ].join('\n');
}

export function createProposalCorrectionWorker(
  deps: ProposalCorrectionDeps,
): WorkerHandler<ProposalCorrectionPayload> {
  return {
    type: 'proposal_correction',
    async handle(
      message: QueueMessage<ProposalCorrectionPayload>,
      logger: Logger,
    ): Promise<void> {
      const { tenantId, proposalId } = message.payload;

      logger.info('Starting proposal-correction', { proposalId });

      const proposal = await deps.proposalRepo.findById(tenantId, proposalId);
      if (!proposal) {
        // Proposal may have been deleted between executor success and
        // this worker firing; soft-skip.
        logger.warn('proposal-correction: proposal not found, skipping', { proposalId });
        return;
      }

      const execution = await deps.proposalExecutionRepo.findLatestByProposal(tenantId, proposalId);
      if (!execution) {
        // No execution row — likely the executor wasn't wired with
        // executionRepo when this proposal ran. Skip; Phase 4a-1 is
        // additive and missing rows are recoverable.
        logger.warn('proposal-correction: no execution row found, skipping', { proposalId });
        return;
      }

      // Only emit chunks for successful executions; failed runs aren't
      // ground truth on what dispatchers want.
      if (execution.status !== 'succeeded') {
        logger.info('proposal-correction: execution status is not succeeded, skipping', {
          proposalId,
          status: execution.status,
        });
        return;
      }

      const drafted = (proposal.payload ?? {}) as Record<string, unknown>;
      const executed = execution.executedPayload ?? {};
      const diffs = computeTopLevelDiff(drafted, executed);

      // Clean approval: dispatcher rubber-stamped the AI draft. No chunk
      // emitted, but we close the eval loop if a retrieval-eval-run is
      // linked via proposal metadata.
      if (diffs.length === 0) {
        logger.info('proposal-correction: clean approval, no chunk', { proposalId });
        const evalRunId = (proposal.sourceContext as Record<string, unknown> | undefined)?.[
          'retrievalEvalRunId'
        ];
        if (typeof evalRunId === 'string' && deps.retrievalEvalRunRepo) {
          try {
            await deps.retrievalEvalRunRepo.attachOutcome({
              tenantId,
              evalRunId,
              downstreamProposalId: proposalId,
              downstreamOutcome: 'approved_no_edits',
            });
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            logger.warn('attachOutcome (clean approval) failed', {
              proposalId,
              evalRunId,
              error: error.message,
            });
          }
        }
        return;
      }

      // Non-empty diff: build, scrub, embed, upsert.
      const rawText = buildCorrectionChunkText(diffs, proposal.proposalType);
      const scrub = scrubPii(rawText);

      let embedding: number[];
      try {
        const result = await deps.embeddings.createEmbedding(scrub.scrubbed);
        embedding = result.embedding;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.warn('embedding failed; skipping correction chunk', {
          proposalId,
          error: error.message,
        });
        return;
      }

      try {
        await deps.knowledgeChunkRepo.insert({
          tenantId,
          scope: 'tenant',
          sourceType: SOURCE_TYPE,
          sourceId: execution.id,
          content: scrub.text,
          contentScrubbed: scrub.scrubbed,
          embedding,
          embeddingModel: EMBEDDING_MODEL,
          metadata: {
            proposalId,
            proposalType: proposal.proposalType,
            executionId: execution.id,
            executedAt: execution.executedAt.toISOString(),
            editedFields: diffs.map((d) => d.field),
            residualPii: scrub.hasResidualPii,
            residualSignals: scrub.residualSignals,
          },
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.warn('knowledge_chunks insert (correction) failed', {
          proposalId,
          executionId: execution.id,
          error: error.message,
        });
        return;
      }

      // Close the eval loop with the edited-fields outcome when a
      // retrieval run is linked to this proposal.
      const evalRunId = (proposal.sourceContext as Record<string, unknown> | undefined)?.[
        'retrievalEvalRunId'
      ];
      if (typeof evalRunId === 'string' && deps.retrievalEvalRunRepo) {
        try {
          await deps.retrievalEvalRunRepo.attachOutcome({
            tenantId,
            evalRunId,
            downstreamProposalId: proposalId,
            downstreamOutcome: 'approved_with_edits',
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.warn('attachOutcome (with edits) failed', {
            proposalId,
            evalRunId,
            error: error.message,
          });
        }
      }

      logger.info('proposal-correction complete', {
        proposalId,
        executionId: execution.id,
        editedFields: diffs.length,
      });
    },
  };
}
