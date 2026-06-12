import { describe, it, expect } from 'vitest';
import { derivePageVoiceContext } from '../useGlobalVoice';

describe('P22-003 — useGlobalVoice', () => {
  it('derivePageVoiceContext binds job detail routes', () => {
    const ctx = derivePageVoiceContext('/jobs/job-123');
    expect(ctx.entityType).toBe('job');
    expect(ctx.entityId).toBe('job-123');
  });

  it('derivePageVoiceContext leaves generic routes unbound', () => {
    const ctx = derivePageVoiceContext('/inbox');
    expect(ctx.entityType).toBeUndefined();
    expect(ctx.route).toBe('/inbox');
  });
});
