/**
 * P2-028 — complexity classifier + complexity-aware model resolution.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyComplexity,
  modelForComplexity,
  ComplexityRoute,
} from '../../../src/ai/gateway/complexity-classifier';

describe('classifyComplexity', () => {
  it('returns "simple" for short plain messages', () => {
    expect(classifyComplexity({ message: 'Create customer John' })).toBe('simple');
  });

  it('returns "complex" when message exceeds 80 words', () => {
    const long = Array(90).fill('word').join(' ');
    expect(classifyComplexity({ message: long })).toBe('complex');
  });

  it('returns "complex" when contextSize exceeds 2000 chars', () => {
    expect(
      classifyComplexity({ message: 'short', contextSize: 3000 })
    ).toBe('complex');
  });

  it('returns "complex" when structuredOutput is true', () => {
    expect(
      classifyComplexity({ message: 'extract fields', structuredOutput: true })
    ).toBe('complex');
  });

  it('returns "complex" when highStakes is true even on short input', () => {
    expect(classifyComplexity({ message: 'ok', highStakes: true })).toBe('complex');
  });

  it('treats empty/undefined message as simple when other signals absent', () => {
    expect(classifyComplexity({})).toBe('simple');
    expect(classifyComplexity({ message: '' })).toBe('simple');
    expect(classifyComplexity({ message: '   ' })).toBe('simple');
  });
});

describe('modelForComplexity', () => {
  const route: ComplexityRoute = {
    model: 'openai/gpt-4o-mini',
    complexModel: 'openai/gpt-4o',
    temperature: 0.1,
    maxTokens: 1024,
  };

  it('returns the primary model for simple complexity', () => {
    expect(modelForComplexity(route, 'simple')).toBe('openai/gpt-4o-mini');
  });

  it('returns the complex model override for complex complexity', () => {
    expect(modelForComplexity(route, 'complex')).toBe('openai/gpt-4o');
  });

  it('falls back to primary model when complexModel is not configured', () => {
    const staticRoute: ComplexityRoute = { model: 'openai/gpt-4o-mini' };
    expect(modelForComplexity(staticRoute, 'complex')).toBe('openai/gpt-4o-mini');
    expect(modelForComplexity(staticRoute, 'simple')).toBe('openai/gpt-4o-mini');
  });
});
