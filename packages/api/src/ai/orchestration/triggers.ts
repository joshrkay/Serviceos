export type TriggerMode = 'automatic' | 'manual' | 'semi_automatic';

export type WorkflowType =
  | 'technician_voice_update'
  | 'dispatcher_intake'
  | 'customer_request'
  | 'job_completion'
  | 'estimate_revision';

export interface WorkflowTriggerConfig {
  workflowType: WorkflowType;
  triggerMode: TriggerMode;
  requiresConfirmation: boolean;
}

export const DEFAULT_TRIGGER_CONFIG: WorkflowTriggerConfig[] = [
  { workflowType: 'technician_voice_update', triggerMode: 'automatic', requiresConfirmation: false },
  { workflowType: 'dispatcher_intake', triggerMode: 'semi_automatic', requiresConfirmation: true },
  { workflowType: 'customer_request', triggerMode: 'manual', requiresConfirmation: true },
  { workflowType: 'job_completion', triggerMode: 'automatic', requiresConfirmation: false },
  { workflowType: 'estimate_revision', triggerMode: 'semi_automatic', requiresConfirmation: true },
];

export interface TriggerEvaluationInput {
  workflowType: string;
  hasTranscript: boolean;
  hasExistingProposal: boolean;
  userRole: string;
  config?: WorkflowTriggerConfig[];
}

export interface TriggerDecision {
  shouldTrigger: boolean;
  mode: TriggerMode;
  requiresConfirmation: boolean;
  reason: string;
}

export function getTriggerConfig(
  workflowType: string,
  config: WorkflowTriggerConfig[] = DEFAULT_TRIGGER_CONFIG
): WorkflowTriggerConfig | null {
  return config.find((c) => c.workflowType === workflowType) ?? null;
}

export function shouldAutoTrigger(
  workflowType: string,
  config: WorkflowTriggerConfig[] = DEFAULT_TRIGGER_CONFIG
): boolean {
  const triggerConfig = getTriggerConfig(workflowType, config);
  if (!triggerConfig) return false;
  return triggerConfig.triggerMode === 'automatic';
}

export function evaluateTrigger(input: TriggerEvaluationInput): TriggerDecision {
  const config = input.config ?? DEFAULT_TRIGGER_CONFIG;
  const triggerConfig = getTriggerConfig(input.workflowType, config);

  if (!triggerConfig) {
    return {
      shouldTrigger: false,
      mode: 'manual',
      requiresConfirmation: true,
      reason: `Unknown workflow type: ${input.workflowType}`,
    };
  }

  if (!input.hasTranscript && triggerConfig.triggerMode !== 'manual') {
    return {
      shouldTrigger: false,
      mode: triggerConfig.triggerMode,
      requiresConfirmation: true,
      reason: 'No transcript available for proposal generation',
    };
  }

  switch (triggerConfig.triggerMode) {
    case 'automatic':
      return {
        shouldTrigger: true,
        mode: 'automatic',
        requiresConfirmation: triggerConfig.requiresConfirmation,
        reason: 'Automatic trigger for workflow type',
      };

    case 'semi_automatic':
      if (input.hasExistingProposal) {
        return {
          shouldTrigger: false,
          mode: 'semi_automatic',
          requiresConfirmation: triggerConfig.requiresConfirmation,
          reason: 'Existing proposal found',
        };
      }
      return {
        shouldTrigger: input.hasTranscript,
        mode: 'semi_automatic',
        requiresConfirmation: triggerConfig.requiresConfirmation,
        reason: input.hasTranscript
          ? 'Semi-automatic trigger with transcript available'
          : 'Awaiting transcript for semi-automatic trigger',
      };

    case 'manual':
      return {
        shouldTrigger: false,
        mode: 'manual',
        requiresConfirmation: true,
        reason: 'Manual trigger requires user action',
      };
  }
}

export function validateTriggerInput(input: Partial<TriggerEvaluationInput>): string[] {
  const errors: string[] = [];
  if (!input.workflowType) errors.push('workflowType is required');
  if (typeof input.hasTranscript !== 'boolean') errors.push('hasTranscript must be a boolean');
  if (typeof input.hasExistingProposal !== 'boolean') errors.push('hasExistingProposal must be a boolean');
  if (!input.userRole) errors.push('userRole is required');
  return errors;
}
