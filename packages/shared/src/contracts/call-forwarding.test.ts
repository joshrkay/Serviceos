import { describe, expect, it } from 'vitest';
import {
  buildCallForwardingInstructions,
  isCallForwardingCarrier,
  isCallForwardingMode,
  nationalDigits,
} from './call-forwarding.js';

const RIVET = '+15125550123';

describe('call forwarding codes', () => {
  it('builds every single-code carrier x mode code with the off code', () => {
    const cases = [
      ['verizon', 'missed', '*715125550123', '*73'],
      ['verizon', 'all', '*725125550123', '*73'],
      ['att', 'missed', '**61*5125550123#', '##61#'],
      ['att', 'all', '**21*5125550123#', '##21#'],
      ['tmobile', 'all', '**21*15125550123#', '##21#'],
    ] as const;
    for (const [carrier, mode, dial, off] of cases) {
      const r = buildCallForwardingInstructions({ carrier, mode, rivetNumber: RIVET });
      expect(r).toMatchObject({ kind: 'codes', dial, off });
    }
  });

  // T-Mobile publishes no **004* turn-on code (only ##004# as "reset to
  // default"); it publishes one code per condition instead.
  // https://www.t-mobile.com/support/plans-features/self-service-short-codes
  it('gives T-Mobile missed calls three per-condition codes in dial order, each with its off code and a reset', () => {
    const r = buildCallForwardingInstructions({ carrier: 'tmobile', mode: 'missed', rivetNumber: RIVET });
    expect(r).toEqual({
      kind: 'multi-codes',
      codes: [
        { label: 'No answer', dial: '**61*15125550123#', dialHref: 'tel:**61*15125550123%23' },
        { label: 'Busy', dial: '**67*15125550123#', dialHref: 'tel:**67*15125550123%23' },
        { label: 'Unreachable', dial: '**62*15125550123#', dialHref: 'tel:**62*15125550123%23' },
      ],
      offCodes: [
        { label: 'No answer', dial: '##61#', dialHref: 'tel:%23%2361%23' },
        { label: 'Busy', dial: '##67#', dialHref: 'tel:%23%2367%23' },
        { label: 'Unreachable', dial: '##62#', dialHref: 'tel:%23%2362%23' },
      ],
      resetAll: { label: 'Reset all', dial: '##004#', dialHref: 'tel:%23%23004%23' },
    });
  });

  it('returns multi-codes only for T-Mobile missed; every other carrier x mode keeps its single code', () => {
    for (const carrier of ['verizon', 'att', 'tmobile'] as const) {
      for (const mode of ['missed', 'all'] as const) {
        const r = buildCallForwardingInstructions({ carrier, mode, rivetNumber: RIVET });
        expect(r?.kind, `${carrier}/${mode}`).toBe(carrier === 'tmobile' && mode === 'missed' ? 'multi-codes' : 'codes');
      }
    }
  });

  it('percent-encodes # in tap-to-dial links', () => {
    const r = buildCallForwardingInstructions({ carrier: 'att', mode: 'all', rivetNumber: RIVET });
    expect(r).toMatchObject({ dialHref: 'tel:**21*5125550123%23', offHref: 'tel:%23%2321%23' });
  });

  it('gives generic steps for other carriers, per mode', () => {
    const missed = buildCallForwardingInstructions({ carrier: 'other', mode: 'missed', rivetNumber: null });
    const all = buildCallForwardingInstructions({ carrier: 'other', mode: 'all', rivetNumber: null });
    expect(missed?.kind).toBe('generic');
    expect(JSON.stringify(missed)).toContain('no-answer');
    expect(JSON.stringify(all)).toContain('unconditional');
  });

  it('returns null for a coded carrier with no usable Rivet number', () => {
    expect(buildCallForwardingInstructions({ carrier: 'verizon', mode: 'all', rivetNumber: null })).toBeNull();
    expect(buildCallForwardingInstructions({ carrier: 'verizon', mode: 'all', rivetNumber: '123' })).toBeNull();
    expect(buildCallForwardingInstructions({ carrier: 'tmobile', mode: 'missed', rivetNumber: null })).toBeNull();
  });

  it('normalises numbers and guards values', () => {
    expect(nationalDigits('+1 (512) 555-0123')).toBe('5125550123');
    expect(nationalDigits('5125550123')).toBe('5125550123');
    expect(isCallForwardingCarrier('att')).toBe(true);
    expect(isCallForwardingCarrier('sprint')).toBe(false);
    expect(isCallForwardingMode('all')).toBe(true);
    expect(isCallForwardingMode('x')).toBe(false);
  });
});
