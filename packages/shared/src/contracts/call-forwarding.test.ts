import { describe, expect, it } from 'vitest';
import {
  buildCallForwardingInstructions,
  isCallForwardingCarrier,
  isCallForwardingMode,
  nationalDigits,
} from './call-forwarding.js';

const RIVET = '+15125550123';

describe('call forwarding codes', () => {
  it('builds every carrier x mode code with the off code', () => {
    const cases = [
      ['verizon', 'missed', '*715125550123', '*73'],
      ['verizon', 'all', '*725125550123', '*73'],
      ['att', 'missed', '**61*5125550123#', '##61#'],
      ['att', 'all', '**21*5125550123#', '##21#'],
      ['tmobile', 'missed', '**004*15125550123#', '##004#'],
      ['tmobile', 'all', '**21*15125550123#', '##21#'],
    ] as const;
    for (const [carrier, mode, dial, off] of cases) {
      const r = buildCallForwardingInstructions({ carrier, mode, rivetNumber: RIVET });
      expect(r).toMatchObject({ kind: 'codes', dial, off });
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
