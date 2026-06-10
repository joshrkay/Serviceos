import { z } from 'zod';
import type { CommandBus } from '../../core/commands';
import type { JobRunner } from '../../core/jobs';
import {
  claimProposalForExecutionCommand,
  completeProposalCommand,
  failProposalCommand,
} from './engine';
import { executeProposalPayloadCommand } from './handlers';

const jobDataSchema = z.object({
  tenantId: z.string().uuid(),
  proposalId: z.string().uuid(),
});

/**
 * The proposal execution worker. Idempotent by construction: the atomic
 * claim (approved -> executing, past undo deadline) admits exactly one
 * execution per proposal; duplicate job deliveries and undone proposals
 * no-op at the claim.
 */
export function registerProposalExecutor(jobs: JobRunner, bus: CommandBus): Promise<void> {
  return jobs.work('proposals.execute', async (data) => {
    const { tenantId, proposalId } = jobDataSchema.parse(data);
    const scope = { tenantId, actor: { type: 'system' as const, id: 'proposal-executor' } };

    const claimed = await bus.execute(claimProposalForExecutionCommand, scope, { proposalId });
    if (!claimed) return;

    try {
      const result = await bus.execute(
        executeProposalPayloadCommand,
        { ...scope, correlationId: proposalId },
        { type: claimed.type, payload: claimed.payload },
      );
      await bus.execute(completeProposalCommand, scope, { proposalId, result });
    } catch (err) {
      await bus.execute(failProposalCommand, scope, {
        proposalId,
        error: (err as Error).message.slice(0, 2000),
      });
    }
  });
}
