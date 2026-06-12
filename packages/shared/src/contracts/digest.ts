/**
 * P5-020 — End-of-day digest contracts.
 */
import { z } from 'zod';

export const digestDeliveryStatusSchema = z.enum([
  'pending',
  'sent',
  'failed',
  'acked',
]);

export type DigestDeliveryStatus = z.infer<typeof digestDeliveryStatusSchema>;

export const digestSectionsSchema = z.object({
  today: z.string().optional(),
  pipeline: z.string().optional(),
  followUps: z.string().optional(),
  tomorrow: z.string().optional(),
  uncertain: z.string().optional(),
  learned: z.string().optional(),
});

export type DigestSections = z.infer<typeof digestSectionsSchema>;

export const DIGEST_ACK_KEYWORDS = ['looks', 'good', 'looks good'] as const;
