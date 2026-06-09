import { z } from 'zod';
import {
  ACTOR_TYPES,
  APPOINTMENT_STATUSES,
  INVOICE_STATUSES,
  JOB_STATUSES,
  ROLES,
} from './enums';
import { centsSchema, documentTotalsSchema, lineItemSchema } from './money';

export const customerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type Customer = z.infer<typeof customerSchema>;

export const jobSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(JOB_STATUSES),
  createdAt: z.string().datetime(),
});
export type Job = z.infer<typeof jobSchema>;

export const appointmentSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  status: z.enum(APPOINTMENT_STATUSES),
});
export type Appointment = z.infer<typeof appointmentSchema>;

export const invoiceSchema = documentTotalsSchema.extend({
  id: z.string().uuid(),
  customerId: z.string().uuid(),
  customerName: z.string(),
  jobId: z.string().uuid().nullable(),
  status: z.enum(INVOICE_STATUSES),
  lineItems: z.array(lineItemSchema),
  dueDate: z.string().nullable(),
  sentAt: z.string().datetime().nullable(),
  paidAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

export const paymentSchema = z.object({
  id: z.string().uuid(),
  invoiceId: z.string().uuid(),
  amountCents: centsSchema,
  method: z.string(),
  externalRef: z.string().nullable(),
  receivedAt: z.string().datetime(),
});
export type Payment = z.infer<typeof paymentSchema>;

export const eventSchema = z.object({
  id: z.string(),
  eventType: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  actorType: z.enum(ACTOR_TYPES),
  actorId: z.string().nullable(),
  correlationId: z.string().nullable(),
  payload: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});
export type EventRecord = z.infer<typeof eventSchema>;

export const meSchema = z.object({
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string(),
  role: z.enum(ROLES),
  tenant: z.object({
    name: z.string(),
    phone: z.string().nullable(),
    timezone: z.string(),
  }),
});
export type Me = z.infer<typeof meSchema>;

export const tenantSettingsSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().max(20).nullable(),
  timezone: z.string().min(1).max(64),
  defaultTaxRateBps: z.number().int().min(0).max(10_000),
  aiDailyQuota: z.number().int().min(0).max(100_000),
});
export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

export const moneySummarySchema = z.object({
  outstandingCents: centsSchema,
  paidLast30DaysCents: centsSchema,
  overdueCents: centsSchema,
  draftCount: z.number().int(),
  sentCount: z.number().int(),
  paidCount: z.number().int(),
});
export type MoneySummary = z.infer<typeof moneySummarySchema>;
