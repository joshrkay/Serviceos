import { z } from 'zod';
import { MessageType } from '../enums.js';

/**
 * P0-034 (F-2) — canonical message create values shared with API.
 */
export const createMessageTypeSchema = z.enum([
  'text',
  'transcript',
  'system_event',
  'note',
  'clarification',
  'proposal',
]);

export type CreateMessageType = z.infer<typeof createMessageTypeSchema>;

/** Assert shared enum and Zod schema stay aligned (F-2). */
export const MESSAGE_TYPE_SCHEMA_VALUES = createMessageTypeSchema.options;

/** Every value accepted by API createMessageSchema exists on shared MessageType. */
export function createMessageTypesCoveredByEnum(): boolean {
  const enumValues = new Set(Object.values(MessageType) as string[]);
  return MESSAGE_TYPE_SCHEMA_VALUES.every((v) => enumValues.has(v));
}
