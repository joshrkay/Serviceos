import { z } from 'zod';

export const tenantIdHeader = 'x-tenant-id';
export const correlationIdHeader = 'x-correlation-id';

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string(),
  environment: z.string(),
  timestamp: z.string(),
  checks: z.record(z.object({
    status: z.enum(['ok', 'degraded', 'down']),
    message: z.string().optional(),
  })).optional(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const createTenantSchema = z.object({
  ownerEmail: z.string().email(),
  name: z.string().min(1).max(255),
});

export const createUserSchema = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'dispatcher', 'technician']),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

export const createConversationSchema = z.object({
  title: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});

export const createMessageSchema = z.object({
  conversationId: z.string().uuid(),
  messageType: z.enum(['text', 'transcript', 'system_event', 'note']),
  content: z.string().optional(),
  fileId: z.string().uuid().optional(),
  source: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const uploadFileSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});

export const createAiRunSchema = z.object({
  taskType: z.string().min(1),
  model: z.string().min(1),
  promptVersionId: z.string().uuid().optional(),
  inputSnapshot: z.record(z.unknown()),
});

export const createPromptVersionSchema = z.object({
  taskType: z.string().min(1),
  template: z.string().min(1),
  model: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

export const createDocumentRevisionSchema = z.object({
  documentType: z.enum(['estimate', 'invoice', 'proposal']),
  documentId: z.string().min(1),
  snapshot: z.record(z.unknown()),
  source: z.enum(['manual', 'ai_generated', 'ai_revised']),
  aiRunId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const createDiffAnalysisSchema = z.object({
  documentType: z.string().min(1),
  documentId: z.string().min(1),
  fromRevisionId: z.string().uuid(),
  toRevisionId: z.string().uuid(),
});

// Vertical Packs (P4-001A)
export const verticalPackSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  terminologyMapId: z.string().min(1),
  taxonomyId: z.string().min(1),
  templateIds: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const createVerticalPackSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  terminologyMapId: z.string().min(1),
  taxonomyId: z.string().min(1),
  templateIds: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

// Terminology (P4-002A/003A)
export const terminologyEntrySchema = z.object({
  term: z.string().min(1),
  aliases: z.array(z.string()),
  definition: z.string().min(1),
  category: z.string().optional(),
});

export const createTerminologyMapSchema = z.object({
  verticalSlug: z.string().min(1),
  version: z.string().min(1),
  entries: z.array(terminologyEntrySchema),
});

// Taxonomy (P4-002B/003B)
export const serviceCategorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  parentId: z.string().optional(),
  description: z.string().min(1),
  tags: z.array(z.string()),
  sortOrder: z.number().int(),
});

export const createServiceTaxonomySchema = z.object({
  verticalSlug: z.string().min(1),
  version: z.string().min(1),
  categories: z.array(serviceCategorySchema),
});

// Vertical Activation (P4-001B)
export const createVerticalActivationSchema = z.object({
  verticalPackId: z.string().min(1),
  verticalSlug: z.string().min(1),
  config: z.record(z.unknown()).optional(),
});

// Estimate Templates (P4-004A)
export const lineItemTemplateSchema = z.object({
  description: z.string().min(1),
  defaultQuantity: z.number().optional(),
  defaultUnitPrice: z.number().optional(),
  category: z.string().optional(),
  isOptional: z.boolean(),
  sortOrder: z.number().int(),
});

export const createEstimateTemplateSchema = z.object({
  verticalSlug: z.string().min(1),
  categoryId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  lineItemTemplates: z.array(lineItemTemplateSchema),
  promptHints: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

// Wording Preferences (P4-007A)
export const createWordingPreferenceSchema = z.object({
  verticalSlug: z.string().min(1),
  originalPhrase: z.string().min(1),
  preferredPhrase: z.string().min(1),
  source: z.enum(['manual', 'learned']),
});

// Settings (P4-010B)
export const terminologyPreferenceUpdateSchema = z.object({
  verticalSlug: z.string().min(1),
  preferences: z.array(z.object({
    originalPhrase: z.string().min(1),
    preferredPhrase: z.string().min(1),
  })),
});
