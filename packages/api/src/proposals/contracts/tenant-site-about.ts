import { z } from 'zod';

/** Longest about copy the site shows; the draft and the owner's edit share it. */
export const TENANT_SITE_ABOUT_MAX_LENGTH = 1200;

/**
 * D-044 / #1769 — update_tenant_site_about proposal payload: the "about" copy
 * for the hosted tenant site. Plain text (paragraphs split on blank lines); the
 * page escapes it, so no markup is ever interpreted. The owner edits this one
 * field on the card before approving.
 */
export const updateTenantSiteAboutPayloadSchema = z.object({
  aboutText: z.string().trim().min(1).max(TENANT_SITE_ABOUT_MAX_LENGTH),
});

export type UpdateTenantSiteAboutPayload = z.infer<typeof updateTenantSiteAboutPayloadSchema>;
