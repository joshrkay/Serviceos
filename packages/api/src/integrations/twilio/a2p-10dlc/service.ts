// #1564 — the owner-facing A2P 10DLC registration service: accept the
// business details (EIN encrypted before it is stored), queue the async
// worker, and project the status the Settings → Phone panel shows.

import { encrypt } from '../../crypto';
import type { Queue } from '../../../queues/queue';
import { AuditRepository, createAuditEvent } from '../../../audit/audit';
import { ConflictError } from '../../../shared/errors';
import type { A2pBusinessDetails, A2pRegistrationStatus } from './registration';
import type { A2pRegistrationStore, A2pStoredDetails } from './store';

export const A2P_REGISTRATION_JOB_TYPE = 'advance_a2p_10dlc_registration';

export interface A2pRegistrationJobPayload {
  tenantId: string;
  /** Poll sequence; makes each delayed re-enqueue's idempotency key unique. */
  poll: number;
}

export type A2pRegistrationViewStatus = 'not_started' | A2pRegistrationStatus;

export interface A2pRegistrationView {
  status: A2pRegistrationViewStatus;
  /**
   * Texting readiness of the phone integration: 'partial_readiness' while the
   * registration is unfinished (outbound SMS keeps today's unregistered
   * behaviour), 'full_readiness' once the campaign is approved.
   */
  readiness: 'partial_readiness' | 'full_readiness';
  details: (A2pStoredDetails & { einLast4: string }) | null;
  failureReasons: string[];
  submittedAt: string | null;
  approvedAt: string | null;
  updatedAt: string | null;
}

/** Statuses during which the owner cannot resubmit (Twilio is reviewing / done). */
const LOCKED: ReadonlySet<A2pRegistrationStatus> = new Set(['brand_pending', 'campaign_pending', 'approved']);

export function createA2pRegistrationService(deps: {
  store: A2pRegistrationStore;
  queue: Queue;
  auditRepo: AuditRepository;
  encryptionKey: string;
}) {
  async function view(tenantId: string): Promise<A2pRegistrationView> {
    const row = await deps.store.get(tenantId);
    if (!row) {
      return {
        status: 'not_started',
        readiness: 'partial_readiness',
        details: null,
        failureReasons: [],
        submittedAt: null,
        approvedAt: null,
        updatedAt: null,
      };
    }
    return {
      status: row.progress.status,
      readiness: row.progress.status === 'approved' ? 'full_readiness' : 'partial_readiness',
      details: { ...row.details, einLast4: row.einLast4 },
      failureReasons: row.progress.failureReasons,
      submittedAt: row.submittedAt.toISOString(),
      approvedAt: row.approvedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function submit(
    tenantId: string,
    actor: { userId: string; role: string },
    input: A2pBusinessDetails,
  ): Promise<A2pRegistrationView> {
    const existing = await deps.store.get(tenantId);
    if (existing && LOCKED.has(existing.progress.status)) {
      throw new ConflictError('Texting registration is already with the carriers and cannot be changed now', {
        status: existing.progress.status,
      });
    }
    const { ein, ...details } = input;
    const saved = await deps.store.saveSubmission(tenantId, {
      details,
      einEnc: encrypt(ein, deps.encryptionKey),
      einLast4: ein.slice(-4),
    });
    const payload: A2pRegistrationJobPayload = { tenantId, poll: 0 };
    await deps.queue.send(
      A2P_REGISTRATION_JOB_TYPE,
      payload,
      `a2p-10dlc-${tenantId}-${saved.submittedAt.getTime()}-0`,
    );
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: actor.userId,
        actorRole: actor.role,
        eventType: 'tenant.a2p_registration_submitted',
        entityType: 'a2p_registration',
        entityId: tenantId,
        // Deliberately no EIN (not even last four) and no contact PII.
        metadata: { resubmission: existing !== null, businessType: details.businessType },
      }),
    );
    return view(tenantId);
  }

  return { submit, view };
}
