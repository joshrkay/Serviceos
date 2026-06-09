import { z } from 'zod';
import type { ProposalPayloads, ProposalType } from '@rivet/contracts';
import { proposalPayloadSchemas } from '@rivet/contracts';
import { defineCommand, type CommandCtx } from '../../core/commands';
import { resolveOrCreateCustomer, createCustomerCommand } from '../crm/customers';
import { createJobCommand, findNextAvailableSlot, scheduleAppointmentCommand } from '../money/jobs';
import { createInvoiceCommand, sendInvoiceCommand } from '../money/invoices';

/**
 * Execution handlers: the deterministic side of the proposal gate. Each
 * handler turns an approved, typed payload into ordinary commands inside one
 * transaction (shared event buffer, shared atomicity).
 */
type Handler<T extends ProposalType> = (
  ctx: CommandCtx,
  payload: ProposalPayloads[T],
) => Promise<Record<string, unknown>>;

const handlers: { [T in ProposalType]: Handler<T> } = {
  create_customer: async (ctx, payload) => {
    const customer = await ctx.invoke(createCustomerCommand, {
      name: payload.name,
      phone: payload.phone,
      email: payload.email,
      address: payload.address,
    });
    return { customerId: customer.id };
  },

  schedule_job: async (ctx, payload) => {
    const customer = await resolveOrCreateCustomer(ctx, {
      customerId: payload.customerId,
      name: payload.customerName,
      phone: payload.customerPhone,
    });
    const job = await ctx.invoke(createJobCommand, {
      customerId: customer.id,
      title: payload.title,
      description: payload.description,
    });
    // One crew: never double-book. Slide past conflicts from the caller's
    // requested time.
    const slot = await findNextAvailableSlot(
      ctx.client,
      ctx.tenantId,
      new Date(payload.startsAt),
      payload.durationMinutes,
    );
    const appointment = await ctx.invoke(scheduleAppointmentCommand, {
      jobId: job.id,
      startsAt: slot.startsAt.toISOString(),
      durationMinutes: payload.durationMinutes,
    });
    // Close the loop with the caller: confirm the booked time by SMS.
    ctx.enqueue({
      topic: 'comms.booking-confirmation',
      payload: { appointmentId: appointment.id },
      dedupeKey: `booking-confirmation:${appointment.id}`,
    });
    return {
      customerId: customer.id,
      jobId: job.id,
      appointmentId: appointment.id,
      scheduledFor: appointment.startsAt,
      requestedFor: payload.startsAt,
      adjustedForConflict: slot.adjusted,
    };
  },

  draft_invoice: async (ctx, payload) => {
    const customer = await resolveOrCreateCustomer(ctx, {
      customerId: payload.customerId,
      name: payload.customerName,
    });
    const invoice = await ctx.invoke(createInvoiceCommand, {
      customerId: customer.id,
      jobId: payload.jobId,
      lineItems: payload.lineItems,
      taxRateBps: payload.taxRateBps,
    });
    return { invoiceId: invoice.id, totalCents: invoice.totalCents };
  },

  send_invoice: async (ctx, payload) => {
    const invoice = await ctx.invoke(sendInvoiceCommand, { invoiceId: payload.invoiceId });
    return { invoiceId: invoice.id, status: invoice.status };
  },
};

export const executeProposalPayloadCommand = defineCommand({
  name: 'proposals.execute_payload',
  input: z.object({
    type: z.string(),
    payload: z.record(z.unknown()),
  }),
  async run(ctx, input): Promise<Record<string, unknown>> {
    const type = input.type as ProposalType;
    const schema = proposalPayloadSchemas[type];
    if (!schema) throw new Error(`no handler for proposal type ${input.type}`);
    const payload = schema.parse(input.payload);
    const handler = handlers[type] as Handler<ProposalType>;
    return handler(ctx, payload as never);
  },
});
