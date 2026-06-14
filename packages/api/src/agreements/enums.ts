/**
 * P9-003 — Service agreement enums and Zod contracts.
 *
 * Tightly scoped enum module used by agreement-service, repositories, and
 * routes. Keeping the enums in one place ensures DB CHECK constraints and
 * runtime validation stay in lockstep.
 */
import { z } from 'zod';

export const RECURRENCE_FREQUENCIES = ['monthly', 'quarterly', 'yearly'] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

export const AGREEMENT_STATUSES = ['active', 'paused', 'cancelled'] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];

export const RUN_STATUSES = ['pending', 'generated', 'skipped', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const recurrenceFrequencySchema = z.enum(RECURRENCE_FREQUENCIES);
export const agreementStatusSchema = z.enum(AGREEMENT_STATUSES);
export const runStatusSchema = z.enum(RUN_STATUSES);

/**
 * Money is integer cents — never floating point.
 * Refuse decimals at the schema layer so callers can't sneak fractional
 * cents through the JSON body.
 */
export const priceCentsSchema = z
  .number()
  .int('price_cents must be an integer (whole cents, no decimals)')
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

/**
 * RRULE-subset string. We only accept the 3 keys the recurrence engine
 * understands. A regex pre-flight catches the obvious garbage; the parser
 * (recurrence.ts) does the deep validation.
 */
export const recurrenceRuleSchema = z
  .string()
  .min(1, 'recurrence_rule is required')
  .regex(
    /^FREQ=(MONTHLY|QUARTERLY|YEARLY)(;INTERVAL=\d+)?(;BYMONTHDAY=\d+)?$/,
    'recurrence_rule must look like "FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15"',
  );

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

/**
 * Membership term length (in whole months) the auto-renew sweep rolls
 * `ends_on` forward by. 1..120 caps a single renewal at a decade so a typo
 * can't push a term centuries out. The auto_renew⇒(endsOn + term) invariant
 * is enforced in the service layer, where the existing agreement's values are
 * also in scope on update.
 */
export const renewalTermMonthsSchema = z
  .number()
  .int('renewalTermMonths must be a whole number of months')
  .min(1)
  .max(120);

/**
 * Member discount in basis points (0..10000 = 0..100%). A membership with a
 * non-zero member discount confers it on the customer's estimates/invoices.
 */
export const memberDiscountBpsSchema = z
  .number()
  .int('memberDiscountBps must be an integer (basis points)')
  .min(0)
  .max(10000);

export const createAgreementSchema = z.object({
  customerId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  recurrenceRule: recurrenceRuleSchema,
  priceCents: priceCentsSchema,
  autoGenerateInvoice: z.boolean().optional(),
  autoGenerateJob: z.boolean().optional(),
  startsOn: isoDateSchema,
  endsOn: isoDateSchema.optional(),
  autoRenew: z.boolean().optional(),
  renewalTermMonths: renewalTermMonthsSchema.optional(),
  memberDiscountBps: memberDiscountBpsSchema.optional(),
});

export const updateAgreementSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  recurrenceRule: recurrenceRuleSchema.optional(),
  priceCents: priceCentsSchema.optional(),
  autoGenerateInvoice: z.boolean().optional(),
  autoGenerateJob: z.boolean().optional(),
  endsOn: isoDateSchema.nullable().optional(),
  autoRenew: z.boolean().optional(),
  renewalTermMonths: renewalTermMonthsSchema.nullable().optional(),
  memberDiscountBps: memberDiscountBpsSchema.optional(),
});
