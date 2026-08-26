/**
 * The ONE free-text → verified-id helper the lookup surface adapters share
 * (assistant chat: `lookup-dispatch.ts`; live phone:
 * `ai/voice-turn/phone-lookup-surface.ts`). Read-only lookups accept the
 * `low_confidence` band — the voice WRITE path forces a confirm turn there
 * because it is about to mutate; reading an operator their own tenant's
 * probably-right record is not the same risk. `ambiguous` still asks.
 *
 * Lives here, not in either adapter, so a third surface adds a caller rather
 * than a third copy — the same rule the shared dispatch itself states.
 */
import type { EntityCandidate, EntityResolver } from '../resolution/entity-resolver';

export type LookupReferenceResult =
  | { kind: 'resolved'; id: string }
  | { kind: 'ambiguous'; candidates: EntityCandidate[] }
  | { kind: 'unresolved' };

export async function resolveLookupReference(
  resolver: EntityResolver | undefined,
  tenantId: string,
  reference: string | undefined,
  kind: 'customer' | 'job' | 'technician',
): Promise<LookupReferenceResult> {
  if (!resolver || !reference || reference.trim().length === 0) return { kind: 'unresolved' };
  const result = await resolver.resolve({ tenantId, reference, kind });
  if (result.kind === 'resolved' || result.kind === 'low_confidence') {
    return { kind: 'resolved', id: result.candidate.id };
  }
  if (result.kind === 'ambiguous') return { kind: 'ambiguous', candidates: result.candidates };
  return { kind: 'unresolved' };
}

/** Spoken/typed "which one?" — shared copy so both surfaces ask the same way. */
export function ambiguousReferenceLine(reference: string, candidates: EntityCandidate[]): string {
  const list = candidates
    .slice(0, 5)
    .map((c) => c.label)
    .join('; ');
  return `More than one match for "${reference}": ${list}. Which one did you mean?`;
}
