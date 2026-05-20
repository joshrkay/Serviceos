export const PROPOSALS_CHANGED = 'serviceos:proposals-changed';

export function emitProposalsChanged(): void {
  window.dispatchEvent(new CustomEvent(PROPOSALS_CHANGED));
}
