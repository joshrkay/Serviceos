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
  messageType: z.enum(['text', 'transcript', 'system_event', 'note', 'clarification', 'proposal']),
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

export const triggerEvaluationSchema = z.object({
  workflowType: z.string().min(1),
  hasTranscript: z.boolean(),
  hasExistingProposal: z.boolean(),
  userRole: z.string().min(1),
});

export const estimateLinkInputSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid().optional(),
  proposalRevisionId: z.string().uuid(),
  estimateId: z.string().uuid(),
});

export const conversationAccessSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(['owner', 'dispatcher', 'technician']),
  tenantId: z.string().min(1),
});
