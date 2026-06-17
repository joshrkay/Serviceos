import { describe, it, expect } from 'vitest';
import { transition, STATE_OPENING_PROMPT, REVIEW_PROMPT, COMPLETED_PROMPT, CAPPED_PROMPT } from '../../../../src/ai/agents/onboarding/transitions';
import { MAX_TURNS, MAX_CLARIFICATIONS_PER_STATE } from '../../../../src/ai/agents/onboarding/constants';
import type {
  OnboardingContext,
  OnboardingState,
  ExtractionResultPayload,
  SideEffect,
} from '../../../../src/ai/agents/onboarding/types';

const T = '2026-06-17T15:00:00Z';

function ctx(overrides: Partial<OnboardingContext> = {}): OnboardingContext {
  return {
    tenantId: 'tenant-1',
    sessionId: 'sess-1',
    transcript: [],
    extractions: {},
    clarificationCountByState: {},
    turnCount: 0,
    pendingClarifications: [],
    ...overrides,
  };
}

function kinds(effects: SideEffect[]): string[] {
  return effects.map((e) => e.kind);
}

function highConfidenceProfileResult(): ExtractionResultPayload {
  return {
    state: 'profile_capture',
    data: {
      businessName: 'Acme Plumbing',
      city: 'Phoenix',
      state: 'AZ',
      verticalPacks: [{ type: 'plumbing', confidence: 0.95, sourceText: 'plumbing' }],
      serviceDescriptions: ['plumbing'],
      confidence: 0.9,
      lowConfidenceFields: [],
    },
    confidence: 0.9,
    needsClarification: false,
    clarificationQuestions: [],
  };
}

function lowConfidenceProfileResult(): ExtractionResultPayload {
  return {
    state: 'profile_capture',
    data: {
      businessName: null,
      city: null,
      state: null,
      verticalPacks: [],
      serviceDescriptions: [],
      confidence: 0.2,
      lowConfidenceFields: ['businessName', 'verticalPacks'],
    },
    confidence: 0.2,
    needsClarification: true,
    clarificationQuestions: ['What is your business name?'],
  };
}

describe('onboarding FSM — transition', () => {
  describe('user_turn dispatch', () => {
    it('appends a user turn, increments turn_count, and emits call_extractor in an extraction state', () => {
      const result = transition(
        'profile_capture',
        { kind: 'user_turn', utterance: "I'm Mike, I run Acme Plumbing in Phoenix.", now: T },
        ctx(),
      );

      expect(result.nextState).toBe('profile_capture');
      expect(result.updatedContext.turnCount).toBe(1);
      expect(result.updatedContext.transcript).toHaveLength(1);
      expect(result.updatedContext.transcript[0]).toMatchObject({
        role: 'user',
        text: "I'm Mike, I run Acme Plumbing in Phoenix.",
        state: 'profile_capture',
      });
      expect(kinds(result.sideEffects)).toEqual(['call_extractor', 'audit_log']);
      const extractorEffect = result.sideEffects[0];
      expect(extractorEffect.kind).toBe('call_extractor');
      if (extractorEffect.kind === 'call_extractor') {
        expect(extractorEffect.state).toBe('profile_capture');
        expect(extractorEffect.transcript).toContain('Acme Plumbing');
      }
    });

    it('hitting MAX_TURNS in an extraction state transitions to capped and emits the proposal-batch effect', () => {
      const result = transition(
        'category_capture',
        { kind: 'user_turn', utterance: 'uh', now: T },
        ctx({ turnCount: MAX_TURNS - 1 }),
      );

      expect(result.nextState).toBe('capped');
      expect(result.updatedContext.turnCount).toBe(MAX_TURNS);
      expect(kinds(result.sideEffects)).toContain('emit_assistant_message');
      expect(kinds(result.sideEffects)).toContain('emit_proposal_batches');
      const assistant = result.sideEffects.find((e) => e.kind === 'emit_assistant_message');
      if (assistant && assistant.kind === 'emit_assistant_message') {
        expect(assistant.text).toBe(CAPPED_PROMPT);
      }
    });

    it('user_turn in review state is treated as confirmation — transitions to completed and emits proposals', () => {
      const result = transition(
        'review',
        { kind: 'user_turn', utterance: 'looks good', now: T },
        ctx({ turnCount: 8 }),
      );

      expect(result.nextState).toBe('completed');
      expect(kinds(result.sideEffects)).toContain('emit_proposal_batches');
      const assistant = result.sideEffects.find((e) => e.kind === 'emit_assistant_message');
      if (assistant && assistant.kind === 'emit_assistant_message') {
        expect(assistant.text).toBe(COMPLETED_PROMPT);
      }
    });

    it('terminal states (completed / capped) ignore further user_turn events', () => {
      for (const terminal of ['completed', 'capped'] as OnboardingState[]) {
        const result = transition(
          terminal,
          { kind: 'user_turn', utterance: 'hello?', now: T },
          ctx({ turnCount: 10 }),
        );
        expect(result.nextState).toBe(terminal);
        expect(result.sideEffects).toHaveLength(0);
      }
    });
  });

  describe('extraction_result dispatch', () => {
    it('high-confidence result advances to the next extraction state and emits its opening prompt', () => {
      const result = transition(
        'profile_capture',
        { kind: 'extraction_result', result: highConfidenceProfileResult() },
        ctx({ turnCount: 1 }),
      );

      expect(result.nextState).toBe('category_capture');
      expect(result.updatedContext.extractions.businessProfile).toBeDefined();
      const assistant = result.sideEffects.find((e) => e.kind === 'emit_assistant_message');
      if (assistant && assistant.kind === 'emit_assistant_message') {
        expect(assistant.text).toBe(STATE_OPENING_PROMPT.category_capture);
      }
    });

    it('completing schedule_capture advances to review (not the next extraction state)', () => {
      const scheduleResult: ExtractionResultPayload = {
        state: 'schedule_capture',
        data: {
          workingHours: [{ days: ['mon'], startTime: '08:00', endTime: '17:00' }],
        },
        confidence: 0.9,
        needsClarification: false,
        clarificationQuestions: [],
      };
      const result = transition('schedule_capture', { kind: 'extraction_result', result: scheduleResult }, ctx({ turnCount: 5 }));

      expect(result.nextState).toBe('review');
      const assistant = result.sideEffects.find((e) => e.kind === 'emit_assistant_message');
      if (assistant && assistant.kind === 'emit_assistant_message') {
        expect(assistant.text).toBe(REVIEW_PROMPT);
      }
    });

    it('low-confidence result keeps the same state and emits a clarification reprompt; clarification_count is bumped', () => {
      const result = transition(
        'profile_capture',
        { kind: 'extraction_result', result: lowConfidenceProfileResult() },
        ctx({ turnCount: 1 }),
      );

      expect(result.nextState).toBe('profile_capture');
      expect(result.updatedContext.clarificationCountByState.profile_capture).toBe(1);
      expect(result.updatedContext.pendingClarifications).toEqual(['What is your business name?']);
      const assistant = result.sideEffects.find((e) => e.kind === 'emit_assistant_message');
      if (assistant && assistant.kind === 'emit_assistant_message') {
        expect(assistant.text).toBe('What is your business name?');
      }
    });

    it('hitting MAX_CLARIFICATIONS_PER_STATE force-advances on a low-confidence result', () => {
      const result = transition(
        'profile_capture',
        { kind: 'extraction_result', result: lowConfidenceProfileResult() },
        ctx({
          turnCount: 4,
          clarificationCountByState: { profile_capture: MAX_CLARIFICATIONS_PER_STATE },
        }),
      );

      expect(result.nextState).toBe('category_capture');
    });

    it('uses a generic fallback clarification when the extractor returns no questions', () => {
      const noQuestions: ExtractionResultPayload = {
        ...lowConfidenceProfileResult(),
        clarificationQuestions: [],
      };
      const result = transition(
        'profile_capture',
        { kind: 'extraction_result', result: noQuestions },
        ctx({ turnCount: 1 }),
      );
      expect(result.updatedContext.pendingClarifications[0]).toContain('Could you tell me');
    });

    it('ignores out-of-state extraction results (late arrivals)', () => {
      const result = transition(
        'category_capture',
        { kind: 'extraction_result', result: highConfidenceProfileResult() },
        ctx({ turnCount: 2 }),
      );

      // No state change, no extractor effect — just an audit log.
      expect(result.nextState).toBe('category_capture');
      expect(kinds(result.sideEffects)).toEqual(['audit_log']);
    });
  });

  describe('extraction_failed', () => {
    it('emits a recovery clarification, bumps the clarification count, and does NOT advance state', () => {
      const result = transition(
        'pricing_capture',
        { kind: 'extraction_failed', state: 'pricing_capture', reason: 'malformed_json' },
        ctx({ turnCount: 3 }),
      );

      expect(result.nextState).toBe('pricing_capture');
      expect(result.updatedContext.clarificationCountByState.pricing_capture).toBe(1);
      expect(kinds(result.sideEffects)).toContain('emit_assistant_message');
      expect(kinds(result.sideEffects)).toContain('audit_log');
    });
  });

  describe('review_confirmed', () => {
    it('transitions review → completed and emits the proposal-batch effect', () => {
      const result = transition('review', { kind: 'review_confirmed' }, ctx({ turnCount: 7 }));
      expect(result.nextState).toBe('completed');
      expect(kinds(result.sideEffects)).toContain('emit_proposal_batches');
    });

    it('is a no-op in non-review states', () => {
      const result = transition('profile_capture', { kind: 'review_confirmed' }, ctx());
      expect(result.nextState).toBe('profile_capture');
      expect(result.sideEffects).toHaveLength(0);
    });
  });
});
