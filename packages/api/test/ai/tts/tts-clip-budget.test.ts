/**
 * S3-2 (plan U4) — the per-clip TTS budget behind POST /api/voice/tts and
 * POST /api/voice/tts/batch.
 *
 * The batch must not be a way around #1603's cap: a turn is charged one unit
 * per clip that is actually synthesized, never one per request, and a turn
 * that does not fit in what is left is refused whole (no partial charge).
 *
 * Seam: `createTtsClipBudget` over a real express-rate-limit MemoryStore —
 * the same store family the route uses without REDIS_URL.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MemoryStore } from 'express-rate-limit';
import { createTtsClipBudget, ttsClipsPerMinFromEnv } from '../../../src/ai/tts/tts-clip-budget';

const OWNER = 'tenant-a:user-1';

describe('the per-clip TTS budget (S3-2)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('charges one unit per clip: 3 then 17 fit in 20, the 21st does not', async () => {
    const budget = createTtsClipBudget({ max: 20, store: new MemoryStore() });

    expect(await budget.charge(OWNER, 3)).toEqual({ ok: true });
    expect(await budget.charge(OWNER, 17)).toEqual({ ok: true });
    expect(await budget.charge(OWNER, 1)).toMatchObject({ ok: false });
  });

  it('a refused charge leaves the budget exactly as it was (no partial charge)', async () => {
    const budget = createTtsClipBudget({ max: 5, store: new MemoryStore() });

    expect(await budget.charge(OWNER, 4)).toEqual({ ok: true });
    // Two more would be six: refused, and the one unit it could have taken is given back.
    expect(await budget.charge(OWNER, 2)).toMatchObject({ ok: false });
    expect(await budget.charge(OWNER, 1)).toEqual({ ok: true });
    expect(await budget.charge(OWNER, 1)).toMatchObject({ ok: false });
  });

  it('a turn of only cache hits (zero units) is never refused, even with the budget spent', async () => {
    const budget = createTtsClipBudget({ max: 1, store: new MemoryStore() });

    expect(await budget.charge(OWNER, 1)).toEqual({ ok: true });
    expect(await budget.charge(OWNER, 0)).toEqual({ ok: true });
  });

  it('a single request for more than the whole budget is refused and charges nothing', async () => {
    const budget = createTtsClipBudget({ max: 2, store: new MemoryStore() });

    expect(await budget.charge(OWNER, 3)).toMatchObject({ ok: false });
    expect(await budget.charge(OWNER, 2)).toEqual({ ok: true });
  });

  it('each caller has their own budget', async () => {
    const budget = createTtsClipBudget({ max: 1, store: new MemoryStore() });

    expect(await budget.charge('tenant-a:user-1', 1)).toEqual({ ok: true });
    expect(await budget.charge('tenant-a:user-2', 1)).toEqual({ ok: true });
    expect(await budget.charge('tenant-a:user-1', 1)).toMatchObject({ ok: false });
  });

  it('a refusal says how long until the window resets, and the budget is back after it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
    const budget = createTtsClipBudget({ max: 1, store: new MemoryStore(), windowMs: 60_000 });

    await budget.charge(OWNER, 1);
    vi.advanceTimersByTime(15_000);
    const refused = await budget.charge(OWNER, 1);
    expect(refused).toEqual({ ok: false, retryAfterMs: 45_000 });

    vi.advanceTimersByTime(45_000);
    expect(await budget.charge(OWNER, 1)).toEqual({ ok: true });
  });

  it('without a store of its own it still counts, per process', async () => {
    const budget = createTtsClipBudget({ max: 1 });

    expect(await budget.charge(OWNER, 1)).toEqual({ ok: true });
    expect(await budget.charge(OWNER, 1)).toMatchObject({ ok: false });
  });

  it('VOICE_TTS_PER_MIN sets the cap; garbage or nothing means 20; never below 1', () => {
    expect(ttsClipsPerMinFromEnv({})).toBe(20);
    expect(ttsClipsPerMinFromEnv({ VOICE_TTS_PER_MIN: '2' })).toBe(2);
    expect(ttsClipsPerMinFromEnv({ VOICE_TTS_PER_MIN: 'lots' })).toBe(20);
    expect(ttsClipsPerMinFromEnv({ VOICE_TTS_PER_MIN: '0' })).toBe(20);
    expect(ttsClipsPerMinFromEnv({ VOICE_TTS_PER_MIN: '-4' })).toBe(1);
  });
});
