import { describe, expect, it } from 'vitest';
import { MessageType } from '../enums.js';
import {
  createMessageTypeSchema,
  createMessageTypesCoveredByEnum,
  MESSAGE_TYPE_SCHEMA_VALUES,
} from './messages.js';

describe('F-2 — MessageType enum ↔ createMessageSchema', () => {
  it('schema accepts clarification and proposal', () => {
    expect(createMessageTypeSchema.parse('clarification')).toBe('clarification');
    expect(createMessageTypeSchema.parse('proposal')).toBe('proposal');
  });

  it('schema values are covered by MessageType enum', () => {
    expect(createMessageTypesCoveredByEnum()).toBe(true);
  });

  it('documents every schema value explicitly', () => {
    expect(MESSAGE_TYPE_SCHEMA_VALUES).toContain('clarification');
    expect(MESSAGE_TYPE_SCHEMA_VALUES).toContain('proposal');
    expect(Object.values(MessageType)).toContain(MessageType.CLARIFICATION);
    expect(Object.values(MessageType)).toContain(MessageType.PROPOSAL);
  });
});
