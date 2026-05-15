import { describe, expect, it } from 'vitest';
import {
  getServiceCategories,
  isValidVerticalType,
  VALID_VERTICAL_TYPES,
} from '../../src/shared/vertical-types';
import { validateVerticalPack } from '../../src/verticals/registry';

describe('vertical type support', () => {
  it('treats electrical as supported but second-class', () => {
    expect(VALID_VERTICAL_TYPES).toEqual(['hvac', 'plumbing', 'electrical']);
    expect(isValidVerticalType('electrical')).toBe(true);
    expect(getServiceCategories('electrical')).toEqual([
      'diagnostic',
      'repair',
      'install',
      'panel',
      'lighting',
      'safety',
      'emergency',
    ]);
  });

  it('validates an electrical vertical pack', () => {
    const errors = validateVerticalPack({
      verticalType: 'electrical',
      displayName: 'Electrical Basic',
      version: '1.0.0',
      categories: [{ id: 'electrical-diagnostic', name: 'Diagnostic', sortOrder: 1 }],
    });
    expect(errors).toEqual([]);
  });
});
