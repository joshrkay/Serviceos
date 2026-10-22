/**
 * D-044 / #1765 — call forwarding codes. The owner keeps their number and
 * forwards it to their Rivet line; this is the one table of carrier dial
 * codes (Settings → Phone, the "Calls reach the AI" checklist item and the
 * onboarding phone step all read it).
 *
 * Codes are the carriers' published GSM/CDMA short codes. Changes made at the
 * carrier are never detectable (D-044), so this module only builds strings.
 */

export const CALL_FORWARDING_CARRIERS = ['verizon', 'att', 'tmobile', 'other'] as const;
export type CallForwardingCarrier = (typeof CALL_FORWARDING_CARRIERS)[number];

/** missed — only when unanswered or busy (default); all — every call. */
export const CALL_FORWARDING_MODES = ['missed', 'all'] as const;
export type CallForwardingMode = (typeof CALL_FORWARDING_MODES)[number];

export const DEFAULT_CALL_FORWARDING_MODE: CallForwardingMode = 'missed';

export const CALL_FORWARDING_CARRIER_LABELS: Record<CallForwardingCarrier, string> = {
  verizon: 'Verizon',
  att: 'AT&T',
  tmobile: 'T-Mobile',
  other: 'Other',
};

export function isCallForwardingCarrier(v: unknown): v is CallForwardingCarrier {
  return typeof v === 'string' && (CALL_FORWARDING_CARRIERS as readonly string[]).includes(v);
}

export function isCallForwardingMode(v: unknown): v is CallForwardingMode {
  return typeof v === 'string' && (CALL_FORWARDING_MODES as readonly string[]).includes(v);
}

type CodeBuilder = (national: string) => string;

interface CarrierCodes {
  missed: { on: CodeBuilder; off: string };
  all: { on: CodeBuilder; off: string };
}

/** `national` is the 10-digit US number without the country code. */
const CODES: Record<Exclude<CallForwardingCarrier, 'other'>, CarrierCodes> = {
  verizon: {
    missed: { on: (n) => `*71${n}`, off: '*73' },
    all: { on: (n) => `*72${n}`, off: '*73' },
  },
  att: {
    missed: { on: (n) => `**61*${n}#`, off: '##61#' },
    all: { on: (n) => `**21*${n}#`, off: '##21#' },
  },
  tmobile: {
    // **004* sets forwarding for busy, no-answer and unreachable together.
    missed: { on: (n) => `**004*1${n}#`, off: '##004#' },
    all: { on: (n) => `**21*1${n}#`, off: '##21#' },
  },
};

export type CallForwardingInstructions =
  | {
      kind: 'codes';
      /** The code to dial from the business phone, with the Rivet number filled in. */
      dial: string;
      /** The code that turns forwarding back off. */
      off: string;
      dialHref: string;
      offHref: string;
    }
  | { kind: 'generic'; steps: string[] };

/** Digits only, US country code dropped. Empty when no usable number. */
export function nationalDigits(e164: string | null | undefined): string {
  if (!e164) return '';
  const digits = e164.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return national.length === 10 ? national : '';
}

/** `#` must be percent-encoded in a tel: URI or the dialer drops it. */
function telHref(code: string): string {
  return `tel:${code.replace(/#/g, '%23')}`;
}

export function buildCallForwardingInstructions(input: {
  carrier: CallForwardingCarrier;
  mode: CallForwardingMode;
  /** The Rivet number, E.164 or national. Null when no line exists yet. */
  rivetNumber: string | null | undefined;
}): CallForwardingInstructions | null {
  if (input.carrier === 'other') {
    return {
      kind: 'generic',
      steps: [
        input.mode === 'all'
          ? 'Ask your carrier for "unconditional call forwarding" (forward all calls).'
          : 'Ask your carrier for "no-answer and busy call forwarding" (forward missed calls).',
        'Give them your Rivet number as the number to forward to.',
        'Ask for the code that turns forwarding off, and keep it somewhere handy.',
      ],
    };
  }
  const national = nationalDigits(input.rivetNumber);
  if (!national) return null;
  const entry = CODES[input.carrier][input.mode];
  const dial = entry.on(national);
  return { kind: 'codes', dial, off: entry.off, dialHref: telHref(dial), offHref: telHref(entry.off) };
}
