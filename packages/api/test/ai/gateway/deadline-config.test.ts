/**
 * U2 — AI_CLASSIFY_INTENT_DEADLINE_MS empty-string guard.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  isEnvPresentButBlank,
  resolveClassifyIntentDeadlineMs,
} from '../../../src/config/ai-routing';

describe('resolveClassifyIntentDeadlineMs', () => {
  const original = process.env.AI_CLASSIFY_INTENT_DEADLINE_MS;

  afterEach(() => {
    if (original === undefined) delete process.env.AI_CLASSIFY_INTENT_DEADLINE_MS;
    else process.env.AI_CLASSIFY_INTENT_DEADLINE_MS = original;
  });

  it('returns 12000 when explicitly set', () => {
    process.env.AI_CLASSIFY_INTENT_DEADLINE_MS = '12000';
    expect(resolveClassifyIntentDeadlineMs()).toBe(12_000);
  });

  it('returns default 4000 when unset', () => {
    delete process.env.AI_CLASSIFY_INTENT_DEADLINE_MS;
    expect(resolveClassifyIntentDeadlineMs()).toBe(4_000);
  });

  it('treats present-but-empty as default 4000 (with blank detection)', () => {
    process.env.AI_CLASSIFY_INTENT_DEADLINE_MS = '';
    expect(isEnvPresentButBlank('AI_CLASSIFY_INTENT_DEADLINE_MS')).toBe(true);
    expect(resolveClassifyIntentDeadlineMs()).toBe(4_000);
  });

  it('treats whitespace-only as blank', () => {
    process.env.AI_CLASSIFY_INTENT_DEADLINE_MS = '   ';
    expect(isEnvPresentButBlank('AI_CLASSIFY_INTENT_DEADLINE_MS')).toBe(true);
    expect(resolveClassifyIntentDeadlineMs()).toBe(4_000);
  });
});
