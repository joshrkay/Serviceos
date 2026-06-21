/**
 * Partner lead-channel adapters (LSA / Angi / Thumbtack) — interface + stubs.
 * Real partner wiring is sequenced separately as access lands; this module is
 * the deterministic mapping seam (raw partner payload → shared InboundLead).
 */
export * from './adapter';
export { googleLsaAdapter } from './google-lsa';
export { angiAdapter } from './angi';
export { thumbtackAdapter } from './thumbtack';
export { getPartnerAdapter, listPartnerAdapters } from './registry';
