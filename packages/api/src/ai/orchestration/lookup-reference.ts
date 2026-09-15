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
  /**
   * `label` is the matched record's own display text (customer display_name,
   * job summary, crew member's full name). Carried alongside the id because a
   * SPOKEN surface has to be able to name the record that answered — "Khan
   * Household owes …" tells the operator WHICH record was read, where "You
   * owe …" tells them nothing and is addressed to the wrong person entirely
   * (see ai/voice-turn/inapp-lookup-surface.ts#speakForOperator). Optional: a
   * resolver that returns no label still resolves.
   */
  | { kind: 'resolved'; id: string; label?: string }
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
    return {
      kind: 'resolved',
      id: result.candidate.id,
      ...(result.candidate.label ? { label: result.candidate.label } : {}),
    };
  }
  if (result.kind === 'ambiguous') return { kind: 'ambiguous', candidates: result.candidates };
  return { kind: 'unresolved' };
}

/**
 * Spoken/typed "which one?" — shared copy so every surface asks the same way.
 *
 * Each candidate is rendered `label (hint)`, because the label ALONE is
 * frequently not an answer to the question being asked. Two customers named
 * Smith produced `More than one match for "Smith": Smith; Smith. Which one
 * did you mean?` — a question the operator cannot possibly answer, which is
 * worse than a wrong guess would have been because it also wastes the turn.
 * `EntityCandidate.hint` exists precisely for this (the customer's primary
 * phone, a job's assigned tech, an invoice's status) and every resolver
 * populates it; it was simply never rendered.
 *
 * Candidates that render to the IDENTICAL string are collapsed — repeating
 * "Smith; Smith" adds nothing to choose between. Deduping on the rendered
 * string (not on the label) is what keeps two same-named records with
 * different hints both listed, which is the case that actually needs
 * disambiguating. The cap is 5 DISTINCT options, so a duplicate can no longer
 * consume one of the five slots.
 */
export function ambiguousReferenceLine(reference: string, candidates: EntityCandidate[]): string {
  const rendered: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const hint = candidate.hint?.trim();
    const line = hint ? `${candidate.label} (${hint})` : candidate.label;
    if (seen.has(line)) continue;
    seen.add(line);
    rendered.push(line);
    if (rendered.length === 5) break;
  }
  return `More than one match for "${reference}": ${rendered.join('; ')}. Which one did you mean?`;
}
