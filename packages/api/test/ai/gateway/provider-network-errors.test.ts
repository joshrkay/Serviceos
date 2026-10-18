/**
 * GATEWAY-02 — socket-level provider failures must be retried inside the
 * deadline.
 *
 * With PROVIDER_SDK_MAX_RETRIES = 0 (the 17.4s fix), the OpenAI SDK no longer
 * retries a dropped socket itself. It throws `APIConnectionError` with the
 * message "Connection error.", no HTTP status, and the real network error in
 * `cause` (openai/core.js makeRequest). `classifyError` used to sniff only
 * `err.message`, so that error classified 'permanent' and `runWithRetry` made
 * zero retries — one dropped keep-alive socket failed the whole call.
 *
 * These tests use the REAL SDK error classes (`new OpenAI.APIConnectionError
 * ({ cause })`), not a hand-built `new Error('socket hang up')`, because the
 * hand-built shape is exactly what let the regression through.
 */
import { describe, it, expect } from 'vitest';
import OpenAI from 'openai';
import {
  classifyError,
  ProviderNetworkError,
} from '../../../src/ai/gateway/retry';
import { isLocalDeadlineOrAbort } from '../../../src/ai/gateway/deadline';
import { isBreakerHealthFailure } from '../../../src/ai/gateway/breaker';
import {
  OpenAICompatibleProvider,
  normalizeProviderError,
} from '../../../src/ai/providers/openai-compatible';
import { composeResilienceStack } from '../../../src/ai/gateway/compose-resilience';
import { gatewayRetryAttemptsTotal } from '../../../src/monitoring/metrics';
import type { LLMRequest } from '../../../src/ai/gateway/gateway';

function networkCause(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function connectionError(code = 'ECONNRESET', message = 'read ECONNRESET'): Error {
  return new OpenAI.APIConnectionError({ cause: networkCause(code, message) });
}

function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    taskType: 'classify_intent',
    tenantId: 'tenant-net',
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'book me tuesday' }],
    ...overrides,
  };
}

function stubProvider(create: () => Promise<unknown>): OpenAICompatibleProvider {
  const provider = new OpenAICompatibleProvider({
    apiKey: 'test-key',
    baseURL: 'https://api.openai.com/v1',
  });
  (
    provider as unknown as {
      client: { chat: { completions: { create: () => Promise<unknown> } } };
    }
  ).client = { chat: { completions: { create } } } as never;
  return provider;
}

const okCompletion = {
  model: 'gpt-4o-mini-2024-07-18',
  choices: [{ message: { content: '{"ok":true}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

async function retryCount(outcome: string): Promise<number> {
  const metric = await gatewayRetryAttemptsTotal.get();
  return metric.values
    .filter(
      (v) =>
        v.labels.provider === 'api.openai.com' &&
        v.labels.taskType === 'classify_intent' &&
        v.labels.outcome === outcome,
    )
    .reduce((sum, v) => sum + v.value, 0);
}

describe('GATEWAY-02 — SDK connection errors are transient', () => {
  it.each([
    ['ECONNRESET', 'read ECONNRESET'],
    ['ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:443'],
    ['EAI_AGAIN', 'getaddrinfo EAI_AGAIN api.openai.com'],
    ['ECONNRESET', 'socket hang up'],
  ])('normalizes APIConnectionError(cause %s) to a transient ProviderNetworkError', (code, msg) => {
    const raw = connectionError(code, msg);
    // The raw SDK error alone says nothing a message sniffer can use.
    expect(raw.message).toBe('Connection error.');

    const normalized = normalizeProviderError(raw, 'api.openai.com');
    expect(normalized).toBeInstanceOf(ProviderNetworkError);
    const net = normalized as ProviderNetworkError;
    expect(net.code).toBe('PROVIDER_NETWORK');
    expect(net.causeCode).toBe(code);
    expect(net.cause).toBe(raw);
    expect(net.message).toContain(msg);
    expect(classifyError(normalized)).toBe('transient');
  });

  it('classifies the SDK client-timeout error as transient and as a provider-health failure', () => {
    const raw = new OpenAI.APIConnectionTimeoutError();
    expect(raw.message).toBe('Request timed out.');
    const normalized = normalizeProviderError(raw, 'api.openai.com');
    expect(normalized).toBeInstanceOf(ProviderNetworkError);
    expect(classifyError(normalized)).toBe('transient');
    // An upstream that never answers is a health signal — unlike OUR deadline
    // abort, it must still count toward the breaker (FM-01 is narrow).
    expect(isLocalDeadlineOrAbort(normalized)).toBe(false);
    expect(isBreakerHealthFailure(normalized)).toBe(true);
  });

  it('leaves our own abort (APIUserAbortError) alone — it stays a local deadline', () => {
    const abort = new OpenAI.APIUserAbortError();
    expect(normalizeProviderError(abort, 'api.openai.com')).toBe(abort);
    expect(classifyError(abort)).toBe('timeout');
    expect(isLocalDeadlineOrAbort(abort)).toBe(true);
  });

  it('classifies an un-normalized APIConnectionError by its cause (defence in depth)', () => {
    // Another adapter that forgot to normalize must not regress to 'permanent'.
    expect(classifyError(connectionError('ECONNRESET', 'read ECONNRESET'))).toBe('transient');
    expect(classifyError(connectionError('EAI_AGAIN', 'getaddrinfo EAI_AGAIN host'))).toBe(
      'transient',
    );
  });

  it('still classifies a genuinely unknown error as permanent', () => {
    expect(classifyError(new Error('Connection error.'))).toBe('permanent');
    expect(
      classifyError(Object.assign(new Error('boom'), { cause: new Error('unrelated') })),
    ).toBe('permanent');
  });

  it('retries a dropped socket inside the deadline and succeeds (handler level)', async () => {
    let calls = 0;
    const provider = stubProvider(async () => {
      calls += 1;
      if (calls === 1) throw connectionError();
      return okCompletion;
    });
    const stack = composeResilienceStack(provider);

    const before = await retryCount('transient');
    const response = await stack.complete(request({ deadlineMs: 5_000 }));

    expect(response.content).toBe('{"ok":true}');
    expect(calls).toBe(2);
    expect(await retryCount('transient')).toBe(before + 1);
  });
});
