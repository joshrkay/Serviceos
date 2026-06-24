/**
 * Partner-channel adapter registry — the single lookup the future signed
 * partner-intake wiring will use to resolve `channel → adapter`. Keeping it
 * here means adding a real partner is a one-line registration once its live
 * delivery + auth are built.
 */
import { PartnerChannel, PartnerLeadAdapter } from './adapter';
import { googleLsaAdapter } from './google-lsa';
import { angiAdapter } from './angi';
import { thumbtackAdapter } from './thumbtack';

const ADAPTERS: Record<PartnerChannel, PartnerLeadAdapter> = {
  google_lsa: googleLsaAdapter,
  angi: angiAdapter,
  thumbtack: thumbtackAdapter,
};

/** Resolve the adapter for a partner channel, or null for an unknown channel. */
export function getPartnerAdapter(channel: string): PartnerLeadAdapter | null {
  return (ADAPTERS as Record<string, PartnerLeadAdapter>)[channel] ?? null;
}

/** All registered partner adapters (for listing / health surfaces). */
export function listPartnerAdapters(): PartnerLeadAdapter[] {
  return Object.values(ADAPTERS);
}
