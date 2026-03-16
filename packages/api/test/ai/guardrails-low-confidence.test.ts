import {
  createProposal,
  CreateProposalInput,
} from '../../src/proposals/proposal';
import {
  evaluateConfidence,
  applyConfidencePolicy,
  DEFAULT_CONFIDENCE_POLICY,
  ConfidencePolicy,
  ConfidenceAction,
} from '../../src/ai/guardrails/low-confidence';

describe('P2-013 — Low-confidence handling policy', () => {
  const baseInput: CreateProposalInput = {
    tenantId: 'tenant-1',
    proposalType: 'create_customer',
    payload: { name: 'John Doe' },
    summary: 'Create customer from voice call',
    confidenceScore: 0.9,
    confidenceFactors: ['high_field_coverage', 'model_provided_confidence'],
    createdBy: 'user-1',
  };

  it('happy path — high confidence returns ready_for_review', () => {
    const action = evaluateConfidence(0.85, ['high_field_coverage']);

    expect(action.action).toBe('ready_for_review');
  });

  it('happy path — medium confidence returns warnings', () => {
    const action = evaluateConfidence(0.6, ['partial_field_coverage', 'model_provided_confidence']);

    expect(action.action).toBe('ready_for_review_with_warnings');
    if (action.action === 'ready_for_review_with_warnings') {
      expect(action.warnings).toHaveLength(2);
      expect(action.warnings[0]).toContain('partial_field_coverage');
      expect(action.warnings[1]).toContain('model_provided_confidence');
    }
  });

  it('happy path — low confidence routes to clarification', () => {
    const action = evaluateConfidence(0.35, ['low_field_coverage']);

    expect(action.action).toBe('request_clarification');
    if (action.action === 'request_clarification') {
      expect(action.questions).toHaveLength(1);
      expect(action.questions[0]).toContain('low_field_coverage');
    }
  });

  it('happy path — very low confidence returns safe failure', () => {
    const action = evaluateConfidence(0.1, ['low_field_coverage']);

    expect(action.action).toBe('safe_failure');
    if (action.action === 'safe_failure') {
      expect(action.reason).toContain('10%');
      expect(action.reason).toContain('below the minimum threshold');
    }
  });

  it('validation — custom thresholds respected', () => {
    const customPolicy: ConfidencePolicy = {
      highThreshold: 0.95,
      mediumThreshold: 0.7,
      lowThreshold: 0.5,
    };

    // 0.85 would be high with defaults, but medium with custom
    const action = evaluateConfidence(0.85, ['high_field_coverage'], customPolicy);
    expect(action.action).toBe('ready_for_review_with_warnings');

    // 0.6 would be medium with defaults, but low with custom
    const action2 = evaluateConfidence(0.6, ['partial_field_coverage'], customPolicy);
    expect(action2.action).toBe('request_clarification');

    // 0.4 would be low with defaults, but safe_failure with custom
    const action3 = evaluateConfidence(0.4, ['low_field_coverage'], customPolicy);
    expect(action3.action).toBe('safe_failure');
  });

  it('validation — never auto-executes regardless of score', () => {
    // Even with perfect confidence, the action is ready_for_review — never auto-execute
    const highAction = evaluateConfidence(1.0, ['high_field_coverage']);
    expect(highAction.action).toBe('ready_for_review');
    expect(highAction).not.toHaveProperty('autoExecute');

    // Apply policy to a proposal with perfect confidence
    const proposal = createProposal({ ...baseInput, confidenceScore: 1.0 });
    const { proposal: updated, action } = applyConfidencePolicy(proposal);

    expect(action.action).toBe('ready_for_review');
    // Status moves to ready_for_review, NEVER to approved or executed
    expect(updated.status).toBe('ready_for_review');
    expect(updated.status).not.toBe('approved');
    expect(updated.status).not.toBe('executed');
  });

  it('invalid transition — safe failure keeps proposal in draft', () => {
    const proposal = createProposal({
      ...baseInput,
      confidenceScore: 0.1,
      confidenceFactors: ['low_field_coverage'],
    });
    expect(proposal.status).toBe('draft');

    const { proposal: updated, action } = applyConfidencePolicy(proposal);

    expect(action.action).toBe('safe_failure');
    expect(updated.status).toBe('draft');
  });

  it('idempotency — same score produces same action', () => {
    const factors = ['partial_field_coverage', 'model_provided_confidence'];

    const action1 = evaluateConfidence(0.65, factors);
    const action2 = evaluateConfidence(0.65, factors);

    expect(action1).toEqual(action2);

    const proposal = createProposal({
      ...baseInput,
      confidenceScore: 0.65,
      confidenceFactors: factors,
    });

    const result1 = applyConfidencePolicy(proposal);
    const result2 = applyConfidencePolicy(proposal);

    expect(result1.action).toEqual(result2.action);
    expect(result1.proposal.status).toBe(result2.proposal.status);
  });
});
