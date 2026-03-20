import { z } from 'zod';

const verticalTypeSchema = z.enum(['hvac', 'plumbing']);

const lineItemCategorySchema = z.enum(['labor', 'material', 'equipment', 'other']);

export const onboardingTenantSettingsPayloadSchema = z.object({
  businessName: z.string().min(1),
  city: z.string().optional(),
  state: z.string().optional(),
  verticalPacks: z.array(verticalTypeSchema).min(1),
});

export const onboardingServiceCategoryPayloadSchema = z.object({
  verticalType: verticalTypeSchema,
  categoryId: z.string().min(1),
  displayName: z.string().min(1),
});

const templateLineItemSchema = z.object({
  description: z.string().min(1),
  category: lineItemCategorySchema.optional(),
  defaultQuantity: z.number().min(0),
  defaultUnitPriceCents: z.number().int().min(0),
  taxable: z.boolean(),
  sortOrder: z.number().int().min(0),
});

export const onboardingEstimateTemplatePayloadSchema = z.object({
  verticalType: verticalTypeSchema,
  categoryId: z.string().min(1),
  templateName: z.string().min(1),
  lineItems: z.array(templateLineItemSchema).min(1),
  defaultNotes: z.string().optional(),
});

export const onboardingTeamMemberPayloadSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['technician', 'dispatcher', 'owner']),
});

const workingHoursEntrySchema = z.object({
  days: z.array(z.string()).min(1),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  seasonal: z.string().optional(),
});

export const onboardingSchedulePayloadSchema = z.object({
  workingHours: z.array(workingHoursEntrySchema).min(1),
  emergencySLA: z
    .object({
      hoursTarget: z.number().min(0),
      isGuarantee: z.boolean(),
    })
    .optional(),
});
