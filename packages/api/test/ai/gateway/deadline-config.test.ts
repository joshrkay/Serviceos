import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isPresentButBlankEnv,
  resolveClassifyIntentDeadlineMs,
  validateClassifyIntentDeadlineEnv,
} from '../../../src/config/ai-routing';

describe('classify intent deadline env', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isPresentButBlankEnv detects empty string', () => {
    expect(isPresentButBlankEnv({ AI_CLASSIFY_INTENT_DEADLINE_MS: '' }, 'AI_CLASSIFY_INTENT_DEADLINE_MS')).toBe(
      true,
    );
    expect(
      isPresentButBlankEnv({ AI_CLASSIFY_INTENT_DEADLINE_MS: '  ' }, 'AI_CLASSIFY_INTENT_DEADLINE_MS'),
    ).toBe(true);
    expect(isPresentButBlankEnv({}, 'AI_CLASSIFY_INTENT_DEADLINE_MS')).toBe(false);
    expect(
      isPresentButBlankEnv({ AI_CLASSIFY_INTENT_DEADLINE_MS: '12000' }, 'AI_CLASSIFY_INTENT_DEADLINE_MS'),
    ).toBe(false);
  });

  it('validateClassifyIntentDeadlineEnv accepts 12000', () => {
    const r = validateClassifyIntentDeadlineEnv({ AI_CLASSIFY_INTENT_DEADLINE_MS: '12000' });
    expect(r).toEqual({ ok: true, valueMs: 12000 });
  });

  it('validateClassifyIntentDeadlineEnv accepts unset → default 4000', () => {
    const r = validateClassifyIntentDeadlineEnv({});
    expect(r).toEqual({ ok: true, valueMs: 4000 });
  });

  it('validateClassifyIntentDeadlineEnv rejects empty string', () => {
    const r = validateClassifyIntentDeadlineEnv({ AI_CLASSIFY_INTENT_DEADLINE_MS: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/empty string/);
  });

  it('validateClassifyIntentDeadlineEnv rejects zero', () => {
    const r = validateClassifyIntentDeadlineEnv({ AI_CLASSIFY_INTENT_DEADLINE_MS: '0' });
    expect(r.ok).toBe(false);
  });

  it('resolveClassifyIntentDeadlineMs uses 12000 when set', () => {
    expect(resolveClassifyIntentDeadlineMs({ AI_CLASSIFY_INTENT_DEADLINE_MS: '12000' })).toBe(12000);
  });

  it('resolveClassifyIntentDeadlineMs falls back to 4000 on empty and warns', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(resolveClassifyIntentDeadlineMs({ AI_CLASSIFY_INTENT_DEADLINE_MS: '' })).toBe(4000);
    expect(write).toHaveBeenCalled();
    expect(String(write.mock.calls[0]?.[0])).toMatch(/AI_CLASSIFY_INTENT_DEADLINE_MS is empty/);
  });
});
