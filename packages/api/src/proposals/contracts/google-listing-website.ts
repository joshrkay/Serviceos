import { z } from 'zod';

const publicUrl = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) link');

/**
 * D-044 / #1771 — update_google_listing_website proposal payload: the website
 * and (optionally) the booking link to show on the owner's Google listing. A
 * public change to their listing, so it is approved by the owner, never auto.
 */
export const updateGoogleListingWebsitePayloadSchema = z.object({
  websiteUri: publicUrl,
  /** The public booking page; omitted when the deployment has no web origin. */
  bookingUri: publicUrl.optional(),
});

export type UpdateGoogleListingWebsitePayload = z.infer<
  typeof updateGoogleListingWebsitePayloadSchema
>;
