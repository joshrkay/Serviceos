import { v4 as uuidv4 } from 'uuid';
import { createAuditEvent } from '../../audit/audit';
import type { AuditRepository } from '../../audit/audit';
import type { OnCallRepository } from '../../oncall/rotation';

export type EscalationReason =
  | 'caller_requested'
  | 'low_confidence'
  | 'cost_cap_exceeded'
  | 'emergency_dispatch'
  | 'abuse_detected'
  | 'provider_failure'
  | 'max_retries_exceeded';

export interface EscalateToHumanInput {
  tenantId: string;
  conversationId?: string;
  sessionId: string;
  reason: EscalationReason;
  channel: 'telephony' | 'inapp';
  callerPhone?: string;
  emergencyDescription?: string;
  onCallRepo: OnCallRepository;
  auditRepo?: AuditRepository;
}

export interface EscalationResult {
  escalated: boolean;
  assignedUserId?: string;
  /** For in-app: show "Connecting you with [dispatcher name]" */
  message: string;
  /** For emergency_dispatch: a proposal was queued */
  proposalId?: string;
}

export async function escalateToHuman(input: EscalateToHumanInput): Promise<EscalationResult> {
  const {
    tenantId,
    sessionId,
    reason,
    onCallRepo,
    auditRepo,
    emergencyDescription,
  } = input;

  // Look up next on-call dispatcher
  const entry = await onCallRepo.getNextOnCall(tenantId);

  if (!entry) {
    // Emit audit event even when no dispatcher is available
    if (auditRepo) {
      const event = createAuditEvent({
        tenantId,
        actorId: sessionId,
        actorRole: 'system',
        eventType: 'escalation.requested',
        entityType: 'session',
        entityId: sessionId,
        correlationId: uuidv4(),
        metadata: {
          reason,
          assignedUserId: null,
          outcome: 'no_dispatcher_available',
        },
      });
      await auditRepo.create(event);
    }

    return {
      escalated: false,
      message: "No dispatcher available. We'll follow up shortly.",
    };
  }

  // Emit audit event for successful escalation
  if (auditRepo) {
    const event = createAuditEvent({
      tenantId,
      actorId: sessionId,
      actorRole: 'system',
      eventType: 'escalation.requested',
      entityType: 'session',
      entityId: sessionId,
      correlationId: uuidv4(),
      metadata: {
        reason,
        assignedUserId: entry.userId,
        outcome: 'escalated',
      },
    });
    await auditRepo.create(event);
  }

  // Build the result message
  let message = 'Connecting you with a dispatcher...';
  if (reason === 'emergency_dispatch') {
    const desc = emergencyDescription
      ? ` regarding: ${emergencyDescription}`
      : '';
    message = `Emergency escalation in progress${desc}. Connecting you with a dispatcher immediately.`;
  }

  const result: EscalationResult = {
    escalated: true,
    assignedUserId: entry.userId,
    message,
  };

  return result;
}
