import { describe, it, expect } from 'vitest';
import { checkServiceArea } from '../../src/scheduling/service-area';

describe('checkServiceArea — F2 term 5 (enforce exactly what is configured)', () => {
  it('accepts everything when no allowlist is configured', () => {
    expect(checkServiceArea(null, '85001')).toEqual({ inArea: true, reason: 'not_configured' });
    expect(checkServiceArea(undefined, '85001')).toEqual({ inArea: true, reason: 'not_configured' });
    expect(checkServiceArea([], '85001')).toEqual({ inArea: true, reason: 'not_configured' });
  });

  it('accepts a ZIP on the allowlist and rejects one off it', () => {
    const zips = ['85001', '85002'];
    expect(checkServiceArea(zips, '85001').inArea).toBe(true);
    expect(checkServiceArea(zips, '90210')).toEqual({ inArea: false, reason: 'zip_mismatch' });
  });

  it('normalizes ZIP+4 and whitespace on both sides', () => {
    expect(checkServiceArea(['85001'], ' 85001-1234 ').inArea).toBe(true);
    expect(checkServiceArea([' 85001-9999 '], '85001').inArea).toBe(true);
  });
});
