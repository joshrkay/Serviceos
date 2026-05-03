/**
 * P11-002 — i18n helper smoke test (placeholder; main coverage lives
 * under packages/api/test/ai/i18n/i18n.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { t } from '../i18n';

describe('P11-002 i18n smoke', () => {
  it('i18n: t() interpolates {{name}} placeholders', () => {
    const out = t('confirm.readback', 'en', { summary: 'schedule a job' });
    expect(out).toContain('schedule a job');
  });
});
