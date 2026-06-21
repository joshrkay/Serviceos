export interface Testimonial {
  quote: string;
  /**
   * First name only. Full names read as stock-photo fabrication; the
   * first-name + trade + city format is both the highest-converting and the
   * most privacy-respecting for owner-operators.
   */
  name: string;
  /** e.g. "HVAC" / "Plumbing". */
  trade: string;
  /** e.g. "Phoenix, AZ". */
  city: string;
  /** ISO date the quote was given; rendered as "Mar 2026". */
  date: string;
}

/**
 * Real customer testimonials. EMPTY BY DESIGN.
 *
 * Rivet is in early access and we do not ship fabricated social proof — no
 * invented quotes, customer counts, or star ratings. When real, attributable
 * quotes exist, add them here. The SocialProof section reads this array and
 * renders the testimonial grid when it is non-empty, falling back to the
 * honest early-access block when it is empty — so populating proof later is a
 * one-file data edit with no component change.
 */
export const testimonials: Testimonial[] = [];

/** Render an ISO date as "Mar 2026" for the testimonial byline. */
export function formatTestimonialDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
