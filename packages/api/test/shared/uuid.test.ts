import { describe, it, expect } from 'vitest';
import { isUuid, UUID_REGEX } from '../../src/shared/uuid';

describe('isUuid', () => {
  it('accepts a canonical v4 UUID', () => {
    expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
  });

  it('accepts UUIDs case-insensitively', () => {
    expect(isUuid('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe(true);
  });

  it('rejects malformed strings', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c330')).toBe(false); // too short
    expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301-extra')).toBe(false);
    expect(isUuid("3f2504e0' OR '1'='1")).toBe(false);
    expect(isUuid('')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(42)).toBe(false);
  });

  it('exposes the underlying regex without global state', () => {
    // A reused /g regex would carry lastIndex between calls; UUID_REGEX must not.
    expect(UUID_REGEX.test('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
    expect(UUID_REGEX.test('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
  });
});
