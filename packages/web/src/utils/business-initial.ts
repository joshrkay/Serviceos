/** First letter for tenant avatar chips when no logo URL exists yet. */
export function businessInitial(businessName: string | undefined | null): string {
  const trimmed = businessName?.trim();
  if (!trimmed) return '?';
  return trimmed.charAt(0).toUpperCase();
}
