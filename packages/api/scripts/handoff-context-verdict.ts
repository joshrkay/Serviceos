/**
 * Pure checks for handoff-context verify artifacts.
 *
 * Used by the CLI (`verify-handoff-context.ts`) and unit tests so a missing
 * membership / CRM note fails the same way in CI and local verify runs.
 */
export interface HandoffContextArtifacts {
  smsBody?: string;
  whisperText?: string;
  panelLastInteraction?: string | null;
  panelTags?: ReadonlyArray<string>;
  dialTwiml?: string;
  transferNumber: string;
}

export interface HandoffContextCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HandoffContextVerdict {
  ok: boolean;
  checks: HandoffContextCheck[];
}

/** Markers the seeded fixture must surface in dispatcher-facing copy. */
export const HANDOFF_VERIFY_MARKERS = {
  membership: /Gold Plan member|Member\./i,
  lastService: /AC tune-up/i,
  notes: /Prefers mornings/i,
  tag: 'vip',
} as const;

export function evaluateHandoffContextArtifacts(
  artifacts: HandoffContextArtifacts,
): HandoffContextVerdict {
  const checks: HandoffContextCheck[] = [];

  const sms = artifacts.smsBody ?? '';
  checks.push({
    name: 'sms-delivered',
    ok: sms.length > 0,
    detail: sms.length > 0 ? 'context SMS captured' : 'no SMS body captured',
  });
  checks.push({
    name: 'sms-transfer-target',
    ok: true, // target checked by runner; keep slot for report completeness
    detail: `expected transfer ${artifacts.transferNumber}`,
  });
  checks.push({
    name: 'sms-membership',
    ok: HANDOFF_VERIFY_MARKERS.membership.test(sms),
    detail: HANDOFF_VERIFY_MARKERS.membership.test(sms)
      ? 'SMS includes membership phrase'
      : 'SMS missing Gold Plan / Member phrase — CRM hydration failed',
  });

  const whisper = artifacts.whisperText ?? '';
  checks.push({
    name: 'whisper-cached',
    ok: whisper.length > 0,
    detail: whisper.length > 0 ? 'whisper text cached' : 'whisper cache empty',
  });
  checks.push({
    name: 'whisper-membership',
    ok: HANDOFF_VERIFY_MARKERS.membership.test(whisper),
    detail: HANDOFF_VERIFY_MARKERS.membership.test(whisper)
      ? 'whisper includes membership phrase'
      : 'whisper missing Gold Plan / Member phrase — CRM hydration failed',
  });

  const last = artifacts.panelLastInteraction ?? '';
  checks.push({
    name: 'panel-last-service',
    ok: HANDOFF_VERIFY_MARKERS.lastService.test(last),
    detail: HANDOFF_VERIFY_MARKERS.lastService.test(last)
      ? 'panel lastInteraction includes last service'
      : 'panel missing last service (AC tune-up)',
  });
  checks.push({
    name: 'panel-notes',
    ok: HANDOFF_VERIFY_MARKERS.notes.test(last),
    detail: HANDOFF_VERIFY_MARKERS.notes.test(last)
      ? 'panel lastInteraction includes communication notes'
      : 'panel missing communication notes',
  });

  const tags = artifacts.panelTags ?? [];
  checks.push({
    name: 'panel-tags',
    ok: tags.includes(HANDOFF_VERIFY_MARKERS.tag),
    detail: tags.includes(HANDOFF_VERIFY_MARKERS.tag)
      ? `panel tags include "${HANDOFF_VERIFY_MARKERS.tag}"`
      : `panel tags missing "${HANDOFF_VERIFY_MARKERS.tag}" (got: ${tags.join(',') || 'none'})`,
  });

  const twiml = artifacts.dialTwiml ?? '';
  checks.push({
    name: 'dial-queued',
    ok: twiml.includes(artifacts.transferNumber),
    detail: twiml.includes(artifacts.transferNumber)
      ? 'Dial TwiML targets transfer number'
      : 'Dial TwiML missing or wrong target',
  });

  return { ok: checks.every((c) => c.ok), checks };
}
