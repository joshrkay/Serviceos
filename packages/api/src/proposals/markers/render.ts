/**
 * P2-035 — Derive human-readable confidence markers from proposal payloads.
 */
import type { ConfidenceMarker } from '@ai-service-os/shared';
import type { Proposal } from '../proposal';

const SMS_TAIL_MAX = 80;

export function deriveMarkersFromProposal(proposal: Proposal): ConfidenceMarker[] {
  const markers: ConfidenceMarker[] = [];
  const payload = proposal.payload ?? {};
  const sourceContext =
    proposal.sourceContext && typeof proposal.sourceContext === 'object'
      ? (proposal.sourceContext as Record<string, unknown>)
      : {};

  const lineItems = Array.isArray(payload.lineItems) ? payload.lineItems : [];
  lineItems.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const item = raw as Record<string, unknown>;
    const pricingSource = item.pricingSource;
    if (pricingSource === 'uncatalogued' || pricingSource === 'ambiguous') {
      markers.push({
        type: pricingSource === 'ambiguous' ? 'ambiguous_catalog' : 'uncatalogued_price',
        fieldPath: `lineItems[${index}].unitPriceCents`,
        explanation:
          pricingSource === 'ambiguous'
            ? `Line "${String(item.description ?? index + 1)}" matched multiple catalog items`
            : `Line "${String(item.description ?? index + 1)}" is not in your catalog`,
        lineIndex: index,
      });
    }
    if (item.needsPricing === true) {
      markers.push({
        type: 'unknown_part',
        fieldPath: `lineItems[${index}]`,
        explanation: `Pricing needed for "${String(item.description ?? 'line item')}"`,
        lineIndex: index,
      });
    }
  });

  const catalogResolution = sourceContext.catalogResolution;
  if (
    catalogResolution &&
    typeof catalogResolution === 'object' &&
    (catalogResolution as { status?: string }).status === 'ambiguous'
  ) {
    markers.push({
      type: 'ambiguous_catalog',
      explanation: 'One or more spoken items matched multiple catalog SKUs',
    });
  }

  if (
    proposal.proposalType === 'voice_clarification' &&
    payload.reason === 'ambiguous_entity'
  ) {
    markers.push({
      type: 'ambiguous_entity',
      explanation: `Multiple matches for "${String(payload.entityReference ?? 'reference')}"`,
    });
  }

  if (
    proposal.confidenceScore !== undefined &&
    proposal.confidenceScore < 0.8 &&
    (proposal.proposalType === 'emergency_dispatch' ||
      proposal.proposalType === 'create_booking')
  ) {
    markers.push({
      type: 'urgency_uncertain',
      explanation: 'Urgency classification was uncertain',
      aiRunId:
        typeof sourceContext.aiRunId === 'string' ? sourceContext.aiRunId : undefined,
    });
  }

  const brandDrift = sourceContext.brandVoiceDrift;
  if (brandDrift === true || brandDrift === 'true') {
    markers.push({
      type: 'brand_voice_drift',
      explanation: 'Draft copy may not match your brand voice',
    });
  }

  return markers;
}

export function formatMarkersForSms(markers: ConfidenceMarker[]): string {
  if (markers.length === 0) return '';
  const unique = [...new Set(markers.map((m) => m.explanation))].slice(0, 3);
  const tail = `Not sure: ${unique.join('; ')}`;
  return tail.length <= SMS_TAIL_MAX ? tail : `${tail.slice(0, SMS_TAIL_MAX - 1)}…`;
}

export function formatMarkersForInbox(markers: ConfidenceMarker[]): string[] {
  return markers.map((m) => m.explanation);
}
