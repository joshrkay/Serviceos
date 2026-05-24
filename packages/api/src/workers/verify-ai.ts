import { WorkerHandler, QueueMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import { Pool } from 'pg';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import type { LLMGateway } from '../ai/gateway';

export interface VerifyAiPayload {
  tenantId: string;
}

export const VERIFY_AI_JOB_TYPE = 'verify_ai';

/**
 * Onboarding AI self-check. Makes ONE real gateway.complete() call on the
 * tenant's behalf and records pass/fail on tenant_settings so the onboarding
 * `ai_check` step can be derived without the status endpoint ever touching the
 * gateway. Idempotent — re-running after a pass is a no-op.
 */
export function createVerifyAiWorker(deps: {
  pool: Pool;
  gateway: LLMGateway;
  auditRepo: AuditRepository;
}): WorkerHandler<VerifyAiPayload> {
  return {
    type: VERIFY_AI_JOB_TYPE,

    async handle(message: QueueMessage<VerifyAiPayload>, logger: Logger): Promise<void> {
      const { tenantId } = message.payload;
      const { pool, gateway, auditRepo } = deps;

      const { rows } = await pool.query<{ ai_model: string | null; ai_verification_status: string | null }>(
        `SELECT ai_model, ai_verification_status FROM tenant_settings WHERE tenant_id = $1`,
        [tenantId],
      );
      const current = rows[0];

      if (current?.ai_verification_status === 'passed') {
        logger.info('AI verification already passed, skipping', { tenantId });
        return;
      }

      if (!current?.ai_model) {
        logger.warn('AI verification cannot run — no ai_model configured', { tenantId });
        await pool.query(
          `UPDATE tenant_settings
              SET ai_verification_status = 'failed',
                  ai_verification_error = 'ai_config_missing',
                  updated_at = NOW()
            WHERE tenant_id = $1`,
          [tenantId],
        );
        return;
      }

      await pool.query(
        `UPDATE tenant_settings
            SET ai_verification_status = 'running',
                ai_verification_started_at = NOW(),
                updated_at = NOW()
          WHERE tenant_id = $1`,
        [tenantId],
      );

      try {
        const response = await gateway.complete({
          taskType: 'intent_classification',
          tenantId,
          maxTokens: 16,
          messages: [{ role: 'user', content: 'ping' }],
        });

        if (!response.content || response.content.trim().length === 0) {
          throw new Error('Gateway returned an empty response');
        }

        await pool.query(
          `UPDATE tenant_settings
              SET ai_verification_status = 'passed',
                  ai_verified_at = NOW(),
                  ai_verification_error = NULL,
                  updated_at = NOW()
            WHERE tenant_id = $1`,
          [tenantId],
        );
        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: 'system',
            actorRole: 'system',
            eventType: 'tenant.ai_verified',
            entityType: 'tenant_settings',
            entityId: tenantId,
            metadata: { model: response.model, provider: response.provider },
          }),
        );
        logger.info('AI verification passed', { tenantId, model: response.model });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error('AI verification failed', { tenantId, error });
        await pool.query(
          `UPDATE tenant_settings
              SET ai_verification_status = 'failed',
                  ai_verification_error = $1,
                  updated_at = NOW()
            WHERE tenant_id = $2`,
          [error, tenantId],
        ).catch(() => {});
        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: 'system',
            actorRole: 'system',
            eventType: 'tenant.ai_verification_failed',
            entityType: 'tenant_settings',
            entityId: tenantId,
            metadata: { error },
          }),
        ).catch(() => {});
        throw err;
      }
    },
  };
}
