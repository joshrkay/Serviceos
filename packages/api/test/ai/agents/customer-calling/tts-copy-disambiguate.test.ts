import { describe, it, expect } from 'vitest';
import { renderTtsText } from '../../../../src/ai/agents/customer-calling/tts-copy';

/**
 * VOX-52 — the entity-resolution fix made the `entity_ambiguous` FSM branch
 * reachable for the first time, which plays ttsPlay('entity_disambiguate',
 * { template: 'disambiguate', candidates }). Before the matching render case
 * existed the caller heard the raw key "entity_disambiguate". These pin the
 * disambiguation copy.
 */
describe('renderTtsText — disambiguate template', () => {
  const play = (candidates: unknown, lang: 'en' | 'es') =>
    renderTtsText('entity_disambiguate', { template: 'disambiguate', candidates }, lang);

  const cand = (id: string, name: string, score = 0.9) => ({ id, name, score });

  it('lists distinct candidate names (en)', () => {
    const text = play([cand('1', 'Dana Rivera'), cand('2', 'Danielle Rivers')], 'en');
    expect(text).toContain('Dana Rivera');
    expect(text).toContain('Danielle Rivers');
    expect(text).toContain('or');
    expect(text).not.toBe('entity_disambiguate');
  });

  it('lists distinct candidate names (es)', () => {
    const text = play([cand('1', 'Dana Rivera'), cand('2', 'Danielle Rivers')], 'es');
    expect(text).toContain('Dana Rivera');
    expect(text).toContain('Danielle Rivers');
    expect(text).toContain(' o '); // Spanish conjunction, not English "or"
  });

  it('asks for a distinguishing detail when names are identical (the "two Bobs" case)', () => {
    const en = play([cand('1', 'Bob Smith'), cand('2', 'Bob Smith')], 'en');
    expect(en).toMatch(/service address/i);
    expect(en).not.toContain('Bob Smith or Bob Smith');

    const es = play([cand('1', 'Bob Smith'), cand('2', 'Bob Smith')], 'es');
    expect(es).toMatch(/dirección de servicio/i);
  });

  it('falls back to a detail request when candidates are missing or malformed', () => {
    expect(play(undefined, 'en')).toMatch(/more than one record/i);
    expect(play([], 'en')).toMatch(/more than one record/i);
    expect(play([{ id: '1' }], 'en')).toMatch(/more than one record/i); // no name field
  });

  it('caps the spoken list at three names', () => {
    const text = play(
      [cand('1', 'Ana'), cand('2', 'Bea'), cand('3', 'Cid'), cand('4', 'Dan')],
      'en',
    );
    expect(text).toContain('Ana');
    expect(text).toContain('Bea');
    expect(text).toContain('Cid');
    expect(text).not.toContain('Dan');
  });

  it('still renders the existing intent_confirm template unchanged', () => {
    const text = renderTtsText(
      'intent_confirm',
      { template: 'intent_confirm', intent: 'book_appointment' },
      'en',
    );
    expect(text).toMatch(/confirm/i);
    expect(text).not.toBe('intent_confirm');
  });
});
