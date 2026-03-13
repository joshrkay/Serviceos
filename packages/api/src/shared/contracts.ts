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

// Phase 1 — Core Business Entity Contracts

export const createCustomerSchema = z.object({
  firstName: z.string().max(100).default(''),
  lastName: z.string().max(100).default(''),
  companyName: z.string().max(255).optional(),
  primaryPhone: z.string().optional(),
  secondaryPhone: z.string().optional(),
  email: z.string().email().optional(),
  preferredChannel: z.enum(['phone', 'email', 'sms', 'none']).default('none'),
  smsConsent: z.boolean().default(false),
  communicationNotes: z.string().optional(),
});

export const createServiceLocationSchema = z.object({
  customerId: z.string().min(1),
  label: z.string().optional(),
  street1: z.string().min(1),
  street2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(1),
  postalCode: z.string().min(1),
  country: z.string().default('US'),
  accessNotes: z.string().optional(),
  isPrimary: z.boolean().default(false),
});

export const createJobSchema = z.object({
  customerId: z.string().min(1),
  locationId: z.string().min(1),
  summary: z.string().min(1).max(500),
  problemDescription: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
});

export const createAppointmentSchema = z.object({
  jobId: z.string().min(1),
  scheduledStart: z.string().datetime(),
  scheduledEnd: z.string().datetime(),
  arrivalWindowStart: z.string().datetime().optional(),
  arrivalWindowEnd: z.string().datetime().optional(),
  timezone: z.string().min(1),
  notes: z.string().optional(),
});

export const lineItemSchema = z.object({
  id: z.string(),
  description: z.string().min(1),
  category: z.enum(['labor', 'material', 'equipment', 'other']).optional(),
  quantity: z.number().nonnegative(),
  unitPriceCents: z.number().int().nonnegative(),
  totalCents: z.number().int(),
  sortOrder: z.number().int(),
  taxable: z.boolean().default(true),
});

export const createEstimateSchema = z.object({
  jobId: z.string().min(1),
  lineItems: z.array(lineItemSchema).min(1),
  discountCents: z.number().int().nonnegative().default(0),
  taxRateBps: z.number().int().nonnegative().max(10000).default(0),
  validUntil: z.string().datetime().optional(),
  customerMessage: z.string().optional(),
  internalNotes: z.string().optional(),
});

export const createInvoiceSchema = z.object({
  jobId: z.string().min(1),
  estimateId: z.string().optional(),
  lineItems: z.array(lineItemSchema).min(1),
  discountCents: z.number().int().nonnegative().default(0),
  taxRateBps: z.number().int().nonnegative().max(10000).default(0),
  customerMessage: z.string().optional(),
});

export const recordPaymentSchema = z.object({
  invoiceId: z.string().min(1),
  amountCents: z.number().int().positive(),
  method: z.enum(['cash', 'check', 'credit_card', 'bank_transfer', 'other']),
  providerReference: z.string().optional(),
  note: z.string().optional(),
});

export const createNoteSchema = z.object({
  entityType: z.enum(['customer', 'location', 'job', 'estimate', 'invoice']),
  entityId: z.string().min(1),
  content: z.string().min(1),
  isPinned: z.boolean().default(false),
});

export const updateSettingsSchema = z.object({
  businessName: z.string().min(1).optional(),
  businessPhone: z.string().optional(),
  businessEmail: z.string().email().optional(),
  timezone: z.string().optional(),
  estimatePrefix: z.string().min(1).optional(),
  invoicePrefix: z.string().min(1).optional(),
  defaultPaymentTermDays: z.number().int().nonnegative().optional(),
  terminologyPreferences: z.record(z.string()).optional(),
});
