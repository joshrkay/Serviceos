import { describe, it, expect } from 'vitest';
import {
  classifyModelId,
  classifyProviderHost,
  findProviderModelMismatch,
} from '../../../src/ai/gateway/provider-model-compat';

describe('provider-model-compat', () => {
  it('classifies OpenAI / OpenRouter / Anthropic hosts', () => {
    expect(classifyProviderHost('https://api.openai.com/v1')).toBe('openai');
    expect(classifyProviderHost('https://openrouter.ai/api/v1')).toBe('openrouter');
    expect(classifyProviderHost('https://api.anthropic.com/v1')).toBe('anthropic');
    expect(classifyProviderHost('https://llm.internal/v1')).toBe('unknown');
  });

  it('classifies model id families', () => {
    expect(classifyModelId('claude-sonnet-4-6')).toBe('anthropic');
    expect(classifyModelId('anthropic/claude-opus-4-8')).toBe('anthropic');
    expect(classifyModelId('gpt-4o-mini')).toBe('openai');
    expect(classifyModelId('openai/gpt-4o')).toBe('openai');
    expect(classifyModelId('meta-llama/llama-3.3-70b-instruct')).toBe('meta_llama');
    expect(classifyModelId('qwen/qwen-2.5-72b-instruct')).toBe('qwen');
  });

  it('flags Claude models on api.openai.com — 2026-07-20 incident', () => {
    const mismatch = findProviderModelMismatch('https://api.openai.com/v1', [
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-6',
    ]);
    expect(mismatch).not.toBeNull();
    expect(mismatch?.providerFamily).toBe('openai');
    expect(mismatch?.modelFamily).toBe('anthropic');
    expect(mismatch?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('flags Llama/Qwen on api.openai.com', () => {
    const mismatch = findProviderModelMismatch('https://api.openai.com/v1', [
      'meta-llama/llama-3.3-70b-instruct',
    ]);
    expect(mismatch?.modelFamily).toBe('meta_llama');
  });

  it('allows gpt models on OpenAI', () => {
    expect(
      findProviderModelMismatch('https://api.openai.com/v1', ['gpt-4o-mini', 'gpt-4o']),
    ).toBeNull();
  });

  it('never mismatches OpenRouter (multi-family aggregator)', () => {
    expect(
      findProviderModelMismatch('https://openrouter.ai/api/v1', [
        'meta-llama/llama-3.3-70b-instruct',
        'anthropic/claude-sonnet-4',
        'openai/gpt-4o-mini',
      ]),
    ).toBeNull();
  });
});
