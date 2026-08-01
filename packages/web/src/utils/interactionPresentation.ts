export function formatInteractionDuration(seconds: unknown): string {
  if (
    typeof seconds !== 'number'
    || !Number.isFinite(seconds)
    || seconds < 0
  ) {
    return '—';
  }

  const wholeSeconds = Math.round(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}
