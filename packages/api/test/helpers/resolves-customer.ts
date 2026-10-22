/**
 * A memo's spoken customer name resolved by the entity resolver, the way
 * production resolves "Book Mrs Lee…". Since drafting gates a booking that
 * names no customer or job (D-045 point 8), a fixture that expects a booking
 * to auto-approve has to resolve its customer like the real pipeline does.
 */
import { vi } from 'vitest';
import type { EntityResolver } from '../../src/ai/resolution/entity-resolver';

export const RESOLVED_CUSTOMER_ID = '7d4c2a10-5b6e-4f3a-9c1d-2e8f0a6b4c31';

export function resolvesCustomer(id: string = RESOLVED_CUSTOMER_ID): EntityResolver {
  return {
    resolve: vi.fn(async (input: { kind: string }) =>
      input.kind === 'customer'
        ? { kind: 'resolved', candidate: { id, kind: 'customer', label: 'Mrs Lee', score: 0.99 } }
        : { kind: 'not_found' },
    ),
  } as unknown as EntityResolver;
}
