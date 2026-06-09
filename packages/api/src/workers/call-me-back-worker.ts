/**
 * Voice-parity (Feature 7) — call_me_back sweeper.
 *
 * Mirrors the P0-009 cross-tenant sweep pattern (see
 * recurring-agreements-worker.ts): iterate active tenants, surface each
 * tenant's pending `call_me_back` tasks to the CSR (SMS to the tenant's
 * transfer_number), mark them `notified`, and never let one tenant's failure
 * crash the loop.
 *
 * The sweep cadence is owned by app.ts (a setInterval driver). Tests exercise
 * this function directly with mocked deps.
 */
import { Logger } from '../logging/logger';
import type { CallMeBackRepository, CallMeBackTask } from '../voice/call-me-back/call-me-back';
import type { SettingsRepository } from '../settings/settings';
import { AuditRepository, createAuditEvent } from '../audit/audit';

export interface CallMeBackWorkerDeps {
  callMeBackRepo: CallMeBackRepository;
  /** Resolves the tenant's transfer_number (the CSR line we notify). */
  settingsRepo: SettingsRepository;
  /** Outbound SMS used to notify the CSR. When absent, tasks stay pending. */
  deliveryProvider?: { sendSms(args: { to: string; body: string }): Promise<unknown> };
  /** Returns the list of tenant IDs we should sweep. */
  listTenantIds: () => Promise<string[]>;
  auditRepo?: AuditRepository;
  logger: Logger;
}

export interface CallMeBackSweepResult {
  tenants: number;
  notified: number;
  skipped: number;
  failed: number;
}

/** Compose the CSR notification SMS for a pending callback (≤160 chars target). */
export function buildCallbackNotificationSms(
  task: CallMeBackTask,
  businessName: string,
): string {
  const who = task.callerName?.trim() || task.callerPhone;
  const msg = task.callbackMessage?.trim();
  const core = `${businessName}: Callback requested from ${who} (${task.callerPhone}).`;
  const withMsg = msg ? `${core} Msg: ${msg}` : `${core} (no message left)`;
  return withMsg.length > 320 ? `${withMsg.slice(0, 317)}…` : withMsg;
}

export async function runCallMeBackSweep(
  deps: CallMeBackWorkerDeps,
): Promise<CallMeBackSweepResult> {
  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('call_me_back sweep: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { tenants: 0, notified: 0, skipped: 0, failed: 0 };
  }

  let notified = 0;
  let skipped = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    try {
      const pending = await deps.callMeBackRepo.listPending(tenantId);
      if (pending.length === 0) continue;

      const settings = await deps.settingsRepo.findByTenant(tenantId);
      const transferNumber = settings?.transferNumber ?? undefined;
      const businessName = settings?.businessName ?? 'Your shop';

      // No line to notify (or SMS not wired) — leave the tasks pending so they
      // surface in-app / on the next sweep once a number is configured.
      if (!transferNumber || !deps.deliveryProvider) {
        skipped += pending.length;
        continue;
      }

      for (const task of pending) {
        try {
          await deps.deliveryProvider.sendSms({
            to: transferNumber,
            body: buildCallbackNotificationSms(task, businessName),
          });
          await deps.callMeBackRepo.markNotified(tenantId, task.id);
          notified++;
          if (deps.auditRepo) {
            await deps.auditRepo.create(
              createAuditEvent({
                tenantId,
                actorId: 'call-me-back-worker',
                actorRole: 'system',
                eventType: 'call_me_back.notified',
                entityType: 'call_me_back_task',
                entityId: task.id,
                correlationId: task.sessionId ?? task.id,
                metadata: { callerPhone: task.callerPhone },
              }),
            );
          }
        } catch (err) {
          // One task's failure shouldn't stop the rest of the tenant's queue.
          failed++;
          deps.logger.warn('call_me_back sweep: task notify failed', {
            tenantId,
            taskId: task.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      // Mirror recurring-agreements-worker: a single tenant's failure is logged
      // and swallowed so the sweep keeps going.
      deps.logger.warn('call_me_back sweep: tenant failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { tenants: tenantIds.length, notified, skipped, failed };
}
