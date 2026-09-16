const MICRO_CENTS_PER_CENT = 1_000_000;

/** Contract rate is cents per audio hour. */
export function deepgramCostMicroCents(
  audioSeconds: number,
  centsPerHour: number,
): number {
  return Math.round(
    (audioSeconds * centsPerHour * MICRO_CENTS_PER_CENT) / 3600,
  );
}

/** Contract rate is cents per 1,000 synthesized characters. */
export function elevenLabsCostMicroCents(
  characters: number,
  centsPerThousand: number,
): number {
  return Math.round(
    (characters * centsPerThousand * MICRO_CENTS_PER_CENT) / 1000,
  );
}

/** Twilio represents call price as a signed USD decimal (normally negative). */
export function twilioPriceToMicroCents(
  priceUsd: string | null | undefined,
): number | null {
  if (priceUsd == null || priceUsd.trim() === "") return null;
  const dollars = Number(priceUsd);
  if (!Number.isFinite(dollars)) return null;
  return Math.round(Math.abs(dollars) * 100 * MICRO_CENTS_PER_CENT);
}
