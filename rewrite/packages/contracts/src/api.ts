import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  appointmentSchema,
  customerSchema,
  estimateSchema,
  eventSchema,
  invoiceSchema,
  jobSchema,
  meSchema,
  moneySummarySchema,
  scheduleEntrySchema,
  tenantSettingsSchema,
} from './entities';
import { lineItemInputSchema, taxRateBpsSchema } from './money';
import { proposalResponseSchema } from './proposals';

const c = initContract();

const errorSchema = z.object({ message: z.string() });
const idParam = z.object({ id: z.string().uuid() });

export const apiContract = c.router(
  {
    me: {
      method: 'GET',
      path: '/api/me',
      responses: { 200: meSchema },
      summary: 'Current user and tenant',
    },
    settings: c.router({
      get: {
        method: 'GET',
        path: '/api/settings',
        responses: { 200: tenantSettingsSchema },
      },
      update: {
        method: 'PATCH',
        path: '/api/settings',
        body: tenantSettingsSchema.partial(),
        responses: { 200: tenantSettingsSchema, 400: errorSchema },
      },
    }),
    customers: c.router({
      list: {
        method: 'GET',
        path: '/api/customers',
        query: z.object({ search: z.string().optional() }),
        responses: { 200: z.object({ customers: z.array(customerSchema) }) },
      },
      create: {
        method: 'POST',
        path: '/api/customers',
        body: z.object({
          name: z.string().min(1).max(200),
          phone: z.string().min(7).max(20),
          email: z.string().email().optional(),
          address: z.string().max(500).optional(),
          notes: z.string().max(2000).optional(),
        }),
        responses: { 201: customerSchema, 400: errorSchema, 409: errorSchema },
      },
    }),
    jobs: c.router({
      list: {
        method: 'GET',
        path: '/api/jobs',
        responses: {
          200: z.object({
            jobs: z.array(jobSchema.extend({ customerName: z.string() })),
          }),
        },
      },
      create: {
        method: 'POST',
        path: '/api/jobs',
        body: z.object({
          customerId: z.string().uuid(),
          title: z.string().min(1).max(200),
          description: z.string().max(2000).optional(),
        }),
        responses: { 201: jobSchema, 400: errorSchema },
      },
      schedule: {
        method: 'POST',
        path: '/api/jobs/:id/schedule',
        pathParams: idParam,
        body: z.object({
          startsAt: z.string().datetime(),
          durationMinutes: z.number().int().min(15).max(720),
        }),
        responses: { 201: appointmentSchema, 400: errorSchema, 404: errorSchema },
      },
    }),
    appointments: c.router({
      list: {
        method: 'GET',
        path: '/api/appointments',
        query: z.object({
          from: z.string().optional(),
        }),
        responses: { 200: z.object({ appointments: z.array(scheduleEntrySchema) }) },
      },
      complete: {
        method: 'POST',
        path: '/api/appointments/:id/complete',
        pathParams: idParam,
        body: z.object({}),
        responses: { 200: scheduleEntrySchema, 404: errorSchema, 409: errorSchema },
      },
    }),
    estimates: c.router({
      list: {
        method: 'GET',
        path: '/api/estimates',
        responses: { 200: z.object({ estimates: z.array(estimateSchema) }) },
      },
      create: {
        method: 'POST',
        path: '/api/estimates',
        body: z.object({
          customerId: z.string().uuid(),
          jobId: z.string().uuid().optional(),
          lineItems: z.array(lineItemInputSchema).min(1).max(50),
          taxRateBps: taxRateBpsSchema.optional(),
        }),
        responses: { 201: estimateSchema, 400: errorSchema },
      },
      send: {
        method: 'POST',
        path: '/api/estimates/:id/send',
        pathParams: idParam,
        body: z.object({}),
        responses: { 200: estimateSchema, 400: errorSchema, 404: errorSchema },
      },
      decide: {
        method: 'POST',
        path: '/api/estimates/:id/decide',
        pathParams: idParam,
        body: z.object({ decision: z.enum(['approved', 'declined']) }),
        responses: { 200: estimateSchema, 400: errorSchema, 404: errorSchema },
      },
    }),
    invoices: c.router({
      list: {
        method: 'GET',
        path: '/api/invoices',
        responses: { 200: z.object({ invoices: z.array(invoiceSchema) }) },
      },
      get: {
        method: 'GET',
        path: '/api/invoices/:id',
        pathParams: idParam,
        responses: { 200: invoiceSchema, 404: errorSchema },
      },
      create: {
        method: 'POST',
        path: '/api/invoices',
        body: z.object({
          customerId: z.string().uuid(),
          jobId: z.string().uuid().optional(),
          lineItems: z.array(lineItemInputSchema).min(1).max(50),
          taxRateBps: taxRateBpsSchema.optional(),
          dueDate: z.string().optional(),
        }),
        responses: { 201: invoiceSchema, 400: errorSchema },
      },
      send: {
        method: 'POST',
        path: '/api/invoices/:id/send',
        pathParams: idParam,
        body: z.object({}),
        responses: { 200: invoiceSchema, 400: errorSchema, 404: errorSchema },
      },
      recordPayment: {
        method: 'POST',
        path: '/api/invoices/:id/payments',
        pathParams: idParam,
        body: z.object({
          amountCents: z.number().int().min(1),
          method: z.enum(['card', 'cash', 'check', 'other']),
          externalRef: z.string().max(200).optional(),
        }),
        responses: { 200: invoiceSchema, 400: errorSchema, 404: errorSchema },
      },
    }),
    proposals: c.router({
      list: {
        method: 'GET',
        path: '/api/proposals',
        query: z.object({ status: z.string().optional() }),
        responses: { 200: z.object({ proposals: z.array(proposalResponseSchema) }) },
      },
      approve: {
        method: 'POST',
        path: '/api/proposals/:id/approve',
        pathParams: idParam,
        body: z.object({}),
        responses: { 200: proposalResponseSchema, 404: errorSchema, 409: errorSchema },
      },
      reject: {
        method: 'POST',
        path: '/api/proposals/:id/reject',
        pathParams: idParam,
        body: z.object({ reason: z.string().max(500).optional() }),
        responses: { 200: proposalResponseSchema, 404: errorSchema, 409: errorSchema },
      },
      undo: {
        method: 'POST',
        path: '/api/proposals/:id/undo',
        pathParams: idParam,
        body: z.object({}),
        responses: { 200: proposalResponseSchema, 404: errorSchema, 409: errorSchema },
      },
    }),
    events: c.router({
      list: {
        method: 'GET',
        path: '/api/events',
        query: z.object({
          entityType: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
        responses: { 200: z.object({ events: z.array(eventSchema) }) },
      },
    }),
    reports: c.router({
      moneySummary: {
        method: 'GET',
        path: '/api/reports/money-summary',
        responses: { 200: moneySummarySchema },
      },
    }),
  },
  {
    strictStatusCodes: true,
    commonResponses: {
      401: errorSchema,
      500: errorSchema,
    },
  },
);

export type ApiContract = typeof apiContract;
