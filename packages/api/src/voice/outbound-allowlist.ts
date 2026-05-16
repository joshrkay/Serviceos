const PREMIUM_NPAS = new Set(['900', '976']);

export interface OutboundCheck {
  allowed: boolean;
  reason?: 'non_nanp' | 'premium_npa' | 'malformed';
}

export function isOutboundAllowed(e164: string): OutboundCheck {
  if (!/^\+1\d{10}$/.test(e164)) {
    if (!/^\+\d{6,15}$/.test(e164)) return { allowed: false, reason: 'malformed' };
    return { allowed: false, reason: 'non_nanp' };
  }
  const npa = e164.slice(2, 5);
  if (PREMIUM_NPAS.has(npa)) return { allowed: false, reason: 'premium_npa' };
  return { allowed: true };
}
