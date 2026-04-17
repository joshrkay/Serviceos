export type SchedulingConfirmationChannel = 'sms' | 'email';

export interface SchedulingConfirmationRequest {
  tenantId: string;
  appointmentId: string;
  jobId: string;
  channels: SchedulingConfirmationChannel[];
}

export interface SchedulingConfirmationNotifier {
  enqueue(request: SchedulingConfirmationRequest): Promise<void>;
}

/**
 * Default no-op notifier so scheduling execution can request customer
 * confirmations without forcing an external provider in tests/dev.
 */
export class NoopSchedulingConfirmationNotifier implements SchedulingConfirmationNotifier {
  async enqueue(_request: SchedulingConfirmationRequest): Promise<void> {
    // Intentionally empty.
  }
}

