import { describe, it, expect } from 'vitest';
import {
  AI_BUSY_HOLD_LINE,
  classifyInfraFailure,
  isAiInfrastructureSystemFailure,
  isTransientInfraFailure,
  systemFailureReasonForInfra,
} from '../../../src/ai/voice-turn/classify-infra-failure';
import {
  TenantConcurrencyExceededError,
  TenantTokenBudgetExceededError,
} from '../../../src/ai/gateway/tenant-quota';
import { BreakerOpenError } from '../../../src/ai/gateway/breaker';
import { ProviderRateLimitError } from '../../../src/ai/gateway/retry';
import { transition } from '../../../src/ai/agents/customer-calling/transitions';
import type { CallingAgentContext } from '../../../src/ai/agents/customer-calling/types';

function baseCtx(): CallingAgentContext {
  return {
    sessionId: 's1',
    tenantId: 't1',
    channel: 'telephony',
  };
}

describe('classifyInfraFailure', () => {
  it('maps quota concurrency / budget / breaker / rate limit', () => {
    expect(classifyInfraFailure(new TenantConcurrencyExceededError('t1'))).toBe(
      'quota_concurrency',
    );
    expect(classifyInfraFailure(new TenantTokenBudgetExceededError('t1', 500))).toBe(
      'quota_budget',
    );
    expect(classifyInfraFailure(new BreakerOpenError('primary', 1000))).toBe(
      'breaker_open',
    );
    expect(
      classifyInfraFailure(
        new ProviderRateLimitError({
          providerName: 'primary',
          providerMessage: 'slow down',
          retryAfterMs: 2000,
        }),
      ),
    ).toBe('rate_limit');
  });

  it('maps timeout-ish and connection messages to transient kinds', () => {
    expect(classifyInfraFailure(new Error('socket hang up'))).toBe('provider_transient');
    expect(classifyInfraFailure(new Error('request timeout after 1500ms'))).toBe('timeout');
  });

  it('unknown permanent errors stay unknown', () => {
    expect(classifyInfraFailure(new Error('validation failed'))).toBe('unknown');
  });

  it('transient kinds are retryable once; unknown is not', () => {
    expect(isTransientInfraFailure('quota_concurrency')).toBe(true);
    expect(isTransientInfraFailure('breaker_open')).toBe(true);
    expect(isTransientInfraFailure('unknown')).toBe(false);
  });

  it('system failure reason prefix is detectable', () => {
    const reason = systemFailureReasonForInfra('quota_concurrency');
    expect(isAiInfrastructureSystemFailure(reason)).toBe(true);
    expect(isAiInfrastructureSystemFailure('disk_full')).toBe(false);
  });

  it('hold line does not claim hearing trouble', () => {
    expect(AI_BUSY_HOLD_LINE.toLowerCase()).not.toMatch(/catch|hear|understand/);
    expect(AI_BUSY_HOLD_LINE.toLowerCase()).toMatch(/moment|busy/);
  });
});

describe('system_failure transition — honest AI infra copy', () => {
  it('speaks technical-issue line for ai_infrastructure reasons', () => {
    const result = transition(
      'intent_capture',
      { type: 'system_failure', reason: systemFailureReasonForInfra('breaker_open') },
      baseCtx(),
    );
    expect(result.nextState).toBe('escalating');
    const tts = result.sideEffects.find((s) => s.type === 'tts_play');
    expect(tts?.payload?.text).toMatch(/technical issue/i);
    expect(String(tts?.payload?.text).toLowerCase()).not.toMatch(/didn't catch|trouble understanding/);
  });

  it('keeps generic line for non-infra system failures', () => {
    const result = transition(
      'intent_capture',
      { type: 'system_failure', reason: 'db_unavailable' },
      baseCtx(),
    );
    const tts = result.sideEffects.find((s) => s.type === 'tts_play');
    expect(tts?.payload?.text).toMatch(/trouble completing/i);
  });
});
