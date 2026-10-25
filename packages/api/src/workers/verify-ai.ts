import { WorkerHandler, QueueMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import { Pool } from 'pg';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import type { LLMGateway } from '../ai/gateway';
import { getSentryClient, type SentryClient } from '../monitoring/sentry';
import { withTenantSession } from '../db/rls-runtime-role';

export interface VerifyAiPayload {
  tenantId: string;
}

export const VERIFY_AI_JOB_TYPE = 'verify_ai';

/**
 * Reports a verification failure to Sentry with the context needed to
 * diagnose flakes (tenant, step, failure reason). Monitoring must never
 * break the worker, so capture is wrapped — the no-op client (SENTRY_DSN
 * unset) makes this a no-op in dev/test.
 */
function reportVerificationFailure(
  sentry: SentryClient,
  tenantId: string,
  failureReason: string,
  cause: unknown,
) {
  try {
    sentry.withScope((scope) => {
      scope.setTag('tenant_id', tenantId);
      scope.setTag('step', 'ai_check');
      scope.setTag('failure_reason', failureReason.slice(0, 200));
      scope.captureException(cause instanceof Error ? cause : new Error(failureReason));
    });
  } catch {
    // monitoring must never break the worker
  }
}

/**
 * Onboarding AI self-check. Makes ONE real gateway.complete() call on the
 * tenant's behalf and records pass/fail on tenant_settings so the onboarding
 * `ai_check` step can be derived without the status endpoint ever touching the
 * gateway. Idempotent — re-running after a pass is a no-op.
 *
 * tenant_settings is read and written under the payload tenant's context
 * (`rls_app_runtime`, raw-pg audit 2026-10-23 §4 P1.9), one tenant session per
 * stage: the read and the 'running' (or 'ai_config_missing') mark before the
 * gateway call, then the outcome after it. No session is open across the LLM
 * call, so the call never holds a pooled connection idle in transaction.
 */
export function createVerifyAiWorker(deps: {
  pool: Pool;
  gateway: LLMGateway;
  auditRepo: AuditRepository;
  /** Injected for tests — defaults to the global Sentry client (no-op when unconfigured). */
  sentry?: SentryClient;
}): WorkerHandler<VerifyAiPayload> {
  return {
    type: VERIFY_AI_JOB_TYPE,

    async handle(message: QueueMessage<VerifyAiPayload>, logger: Logger): Promise<void> {
      const { tenantId } = message.payload;
      const { pool, gateway, auditRepo } = deps;
      const sentry = deps.sentry ?? getSentryClient();

      // Stage 1 — one session: the read, then the mark it decides on.
      const start = await withTenantSession(pool, tenantId, async (client) => {
        const { rows } = await client.query<{ ai_model: string | null; ai_verification_status: string | null }>(
          `SELECT ai_model, ai_verification_status FROM tenant_settings WHERE tenant_id = $1`,
          [tenantId],
        );
        const current = rows[0];
        if (current?.ai_verification_status === 'passed') return 'already_passed' as const;
        if (!current?.ai_model) {
          await client.query(
            `UPDATE tenant_settings
                SET ai_verification_status = 'failed',
                    ai_verification_error = 'ai_config_missing',
                    updated_at = NOW()
              WHERE tenant_id = $1`,
            [tenantId],
          );
          return 'ai_config_missing' as const;
        }
        await client.query(
          `UPDATE tenant_settings
              SET ai_verification_status = 'running',
                  ai_verification_started_at = NOW(),
                  updated_at = NOW()
            WHERE tenant_id = $1`,
          [tenantId],
        );
        return 'running' as const;
      });

      if (start === 'already_passed') {
        logger.info('AI verification already passed, skipping', { tenantId });
        return;
      }

      if (start === 'ai_config_missing') {
        logger.warn('AI verification cannot run — no ai_model configured', { tenantId });
        reportVerificationFailure(sentry, tenantId, 'ai_config_missing', new Error('ai_config_missing'));
        return;
      }

      // Stage 2 — the gateway call, with stage 1 committed and no session open.
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

        // Stage 3 — the outcome, a session of its own.
        await withTenantSession(pool, tenantId, (client) =>
          client.query(
            `UPDATE tenant_settings
                SET ai_verification_status = 'passed',
                    ai_verified_at = NOW(),
                    ai_verification_error = NULL,
                    updated_at = NOW()
              WHERE tenant_id = $1`,
            [tenantId],
          ),
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
        reportVerificationFailure(sentry, tenantId, error, err);
        await withTenantSession(pool, tenantId, (client) =>
          client.query(
            `UPDATE tenant_settings
                SET ai_verification_status = 'failed',
                    ai_verification_error = $1,
                    updated_at = NOW()
              WHERE tenant_id = $2`,
            [error, tenantId],
          ),
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
