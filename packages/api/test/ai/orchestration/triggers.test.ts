import {
  shouldAutoTrigger,
  evaluateTrigger,
  getTriggerConfig,
  validateTriggerInput,
  DEFAULT_TRIGGER_CONFIG,
  TriggerEvaluationInput,
} from '../../../src/ai/orchestration/triggers';

describe('P3-010 — Proposal trigger modes by workflow type', () => {
  it('happy path — correct trigger mode returned for each workflow type', () => {
    expect(shouldAutoTrigger('technician_voice_update')).toBe(true);
    expect(shouldAutoTrigger('dispatcher_intake')).toBe(false);
    expect(shouldAutoTrigger('customer_request')).toBe(false);
    expect(shouldAutoTrigger('job_completion')).toBe(true);
    expect(shouldAutoTrigger('estimate_revision')).toBe(false);
  });

  it('happy path — evaluateTrigger returns correct decision for automatic workflow', () => {
    const input: TriggerEvaluationInput = {
      workflowType: 'technician_voice_update',
      hasTranscript: true,
      hasExistingProposal: false,
      userRole: 'technician',
    };

    const decision = evaluateTrigger(input);
    expect(decision.shouldTrigger).toBe(true);
    expect(decision.mode).toBe('automatic');
  });

  it('happy path — evaluateTrigger returns correct decision for semi_automatic workflow', () => {
    const input: TriggerEvaluationInput = {
      workflowType: 'dispatcher_intake',
      hasTranscript: true,
      hasExistingProposal: false,
      userRole: 'dispatcher',
    };

    const decision = evaluateTrigger(input);
    expect(decision.shouldTrigger).toBe(true);
    expect(decision.mode).toBe('semi_automatic');
    expect(decision.requiresConfirmation).toBe(true);
  });

  it('happy path — manual workflow does not auto-trigger', () => {
    const input: TriggerEvaluationInput = {
      workflowType: 'customer_request',
      hasTranscript: true,
      hasExistingProposal: false,
      userRole: 'dispatcher',
    };

    const decision = evaluateTrigger(input);
    expect(decision.shouldTrigger).toBe(false);
    expect(decision.mode).toBe('manual');
  });

  it('happy path — no transcript prevents semi_automatic trigger', () => {
    const input: TriggerEvaluationInput = {
      workflowType: 'dispatcher_intake',
      hasTranscript: false,
      hasExistingProposal: false,
      userRole: 'dispatcher',
    };

    const decision = evaluateTrigger(input);
    expect(decision.shouldTrigger).toBe(false);
  });

  it('happy path — getTriggerConfig returns config for known workflow', () => {
    const config = getTriggerConfig('technician_voice_update');
    expect(config).not.toBeNull();
    expect(config!.triggerMode).toBe('automatic');
  });

  it('validation — unknown workflow type handled gracefully', () => {
    expect(shouldAutoTrigger('unknown_workflow')).toBe(false);

    const decision = evaluateTrigger({
      workflowType: 'unknown_workflow',
      hasTranscript: true,
      hasExistingProposal: false,
      userRole: 'dispatcher',
    });
    expect(decision.shouldTrigger).toBe(false);
    expect(decision.reason).toContain('Unknown workflow type');
  });

  it('validation — missing fields rejected with clear errors', () => {
    const errors = validateTriggerInput({});
    expect(errors).toContain('workflowType is required');
    expect(errors).toContain('hasTranscript must be a boolean');
    expect(errors).toContain('hasExistingProposal must be a boolean');
    expect(errors).toContain('userRole is required');
  });
});
