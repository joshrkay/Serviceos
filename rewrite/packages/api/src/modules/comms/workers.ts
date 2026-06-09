import { z } from 'zod';
import type { CommandBus } from '../../core/commands';
import { withTenantTransaction, type Db } from '../../core/db';
import type { JobRunner } from '../../core/jobs';
import { formatCents } from '../money/billing-engine';
import { recordOutboundMessageCommand } from './messages';
import type { SmsProvider } from './sms-provider';

const SYSTEM_ACTOR = { type: 'system' as const, id: 'comms' };

interface CommsDeps {
  db: Db;
  bus: CommandBus;
  jobs: JobRunner;
  sms: SmsProvider;
}

async function getOwner(db: Db, tenantId: string): Promise<{ phone: string | null; tenantPhone: string | null }> {
  return withTenantTransaction(db, tenantId, async (client) => {
    const owner = await client.query<{ phone: string | null }>(
      `SELECT phone FROM users WHERE tenant_id = $1 AND role = 'owner' AND phone IS NOT NULL LIMIT 1`,
      [tenantId],
    );
    const tenant = await client.query<{ phone: string | null }>(
      `SELECT phone FROM tenants WHERE id = $1`,
      [tenantId],
    );
    return { phone: owner.rows[0]?.phone ?? null, tenantPhone: tenant.rows[0]?.phone ?? null };
  });
}

async function sendAndRecordSms(deps: CommsDeps, tenantId: string, to: string, from: string, body: string): Promise<void> {
  const { externalId } = await deps.sms.send({ to, from, body });
  await deps.bus.execute(
    recordOutboundMessageCommand,
    { tenantId, actor: SYSTEM_ACTOR },
    { channel: 'sms', to, from, body, externalId },
  );
}

/** SMS the owner when a proposal lands in their inbox: "reply YES n / NO n". */
async function registerProposalNotifyWorker(deps: CommsDeps): Promise<void> {
  const dataSchema = z.object({ tenantId: z.string().uuid(), proposalId: z.string().uuid() });
  await deps.jobs.work('comms.proposal-notify', async (raw) => {
    const { tenantId, proposalId } = dataSchema.parse(raw);
    const proposal = await withTenantTransaction(deps.db, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT short_code, summary, status FROM proposals WHERE tenant_id = $1 AND id = $2`,
        [tenantId, proposalId],
      );
      return rows[0] as { short_code: number; summary: string; status: string } | undefined;
    });
    if (!proposal || proposal.status !== 'ready_for_review') return;
    const owner = await getOwner(deps.db, tenantId);
    if (!owner.phone || !owner.tenantPhone) return;
    await sendAndRecordSms(
      deps,
      tenantId,
      owner.phone,
      owner.tenantPhone,
      `Rivet: ${proposal.summary} — reply YES ${proposal.short_code} to approve or NO ${proposal.short_code} to reject.`,
    );
  });
}

/** Generic owner notification (invoice paid, etc.). */
async function registerNotifyOwnerWorker(deps: CommsDeps): Promise<void> {
  const dataSchema = z.object({ tenantId: z.string().uuid(), text: z.string().min(1) });
  await deps.jobs.work('comms.notify-owner', async (raw) => {
    const { tenantId, text } = dataSchema.parse(raw);
    const owner = await getOwner(deps.db, tenantId);
    if (!owner.phone || !owner.tenantPhone) return;
    await sendAndRecordSms(deps, tenantId, owner.phone, owner.tenantPhone, text);
  });
}

/** SMS the customer when an invoice is sent. */
async function registerInvoiceSmsWorker(deps: CommsDeps): Promise<void> {
  const dataSchema = z.object({ tenantId: z.string().uuid(), invoiceId: z.string().uuid() });
  await deps.jobs.work('comms.invoice-sms', async (raw) => {
    const { tenantId, invoiceId } = dataSchema.parse(raw);
    const details = await withTenantTransaction(deps.db, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT i.total_cents, c.phone AS customer_phone, t.name AS tenant_name, t.phone AS tenant_phone
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id
         JOIN tenants t ON t.id = i.tenant_id
         WHERE i.tenant_id = $1 AND i.id = $2 AND i.status = 'sent'`,
        [tenantId, invoiceId],
      );
      return rows[0] as
        | { total_cents: string; customer_phone: string; tenant_name: string; tenant_phone: string | null }
        | undefined;
    });
    if (!details || !details.tenant_phone) return;
    await sendAndRecordSms(
      deps,
      tenantId,
      details.customer_phone,
      details.tenant_phone,
      `${details.tenant_name}: your invoice for ${formatCents(Number(details.total_cents))} is ready. Reference ${invoiceId.slice(0, 8)}.`,
    );
  });
}

/** SMS the customer when an estimate is sent. */
async function registerEstimateSmsWorker(deps: CommsDeps): Promise<void> {
  const dataSchema = z.object({ tenantId: z.string().uuid(), estimateId: z.string().uuid() });
  await deps.jobs.work('comms.estimate-sms', async (raw) => {
    const { tenantId, estimateId } = dataSchema.parse(raw);
    const details = await withTenantTransaction(deps.db, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT e.total_cents, c.phone AS customer_phone, t.name AS tenant_name, t.phone AS tenant_phone
         FROM estimates e
         JOIN customers c ON c.id = e.customer_id
         JOIN tenants t ON t.id = e.tenant_id
         WHERE e.tenant_id = $1 AND e.id = $2 AND e.status = 'sent'`,
        [tenantId, estimateId],
      );
      return rows[0] as
        | { total_cents: string; customer_phone: string; tenant_name: string; tenant_phone: string | null }
        | undefined;
    });
    if (!details || !details.tenant_phone) return;
    await sendAndRecordSms(
      deps,
      tenantId,
      details.customer_phone,
      details.tenant_phone,
      `${details.tenant_name}: your estimate for ${formatCents(Number(details.total_cents))} is ready. Reference ${estimateId.slice(0, 8)}.`,
    );
  });
}

/**
 * Booking confirmation to the customer after an approved schedule_job
 * executes: the caller hears back with the actual booked time, rendered in
 * the tenant's timezone.
 */
async function registerBookingConfirmationWorker(deps: CommsDeps): Promise<void> {
  const dataSchema = z.object({ tenantId: z.string().uuid(), appointmentId: z.string().uuid() });
  await deps.jobs.work('comms.booking-confirmation', async (raw) => {
    const { tenantId, appointmentId } = dataSchema.parse(raw);
    const details = await withTenantTransaction(deps.db, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT a.starts_at, a.ends_at, c.phone AS customer_phone,
                t.name AS tenant_name, t.phone AS tenant_phone, t.timezone
         FROM appointments a
         JOIN jobs j ON j.id = a.job_id
         JOIN customers c ON c.id = j.customer_id
         JOIN tenants t ON t.id = a.tenant_id
         WHERE a.tenant_id = $1 AND a.id = $2 AND a.status = 'scheduled'`,
        [tenantId, appointmentId],
      );
      return rows[0] as
        | {
            starts_at: Date;
            ends_at: Date;
            customer_phone: string;
            tenant_name: string;
            tenant_phone: string | null;
            timezone: string;
          }
        | undefined;
    });
    if (!details || !details.tenant_phone) return;
    const when = new Intl.DateTimeFormat('en-US', {
      timeZone: details.timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(details.starts_at);
    await sendAndRecordSms(
      deps,
      tenantId,
      details.customer_phone,
      details.tenant_phone,
      `${details.tenant_name}: you're booked for ${when}. Reply to this number if you need to change it.`,
    );
  });
}

/** Daily digest: pending approvals + yesterday's money, per tenant. */
async function registerDailyDigestWorker(deps: CommsDeps): Promise<void> {
  await deps.jobs.work('comms.daily-digest', async () => {
    const tenants = await deps.db.admin.query<{ id: string }>(`SELECT id FROM tenants`);
    for (const tenant of tenants.rows) {
      const digest = await withTenantTransaction(deps.db, tenant.id, async (client) => {
        const pending = await client.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM proposals WHERE tenant_id = $1 AND status = 'ready_for_review'`,
          [tenant.id],
        );
        const money = await client.query<{ paid: string; outstanding: string }>(
          `SELECT
             COALESCE(SUM(total_cents) FILTER (WHERE status = 'paid' AND paid_at > now() - interval '1 day'), 0) AS paid,
             COALESCE(SUM(total_cents) FILTER (WHERE status IN ('sent', 'overdue')), 0) AS outstanding
           FROM invoices WHERE tenant_id = $1`,
          [tenant.id],
        );
        return {
          pending: Number(pending.rows[0]!.count),
          paid: Number(money.rows[0]!.paid),
          outstanding: Number(money.rows[0]!.outstanding),
        };
      });
      if (digest.pending === 0 && digest.paid === 0) continue;
      const owner = await getOwner(deps.db, tenant.id);
      if (!owner.phone || !owner.tenantPhone) continue;
      await sendAndRecordSms(
        deps,
        tenant.id,
        owner.phone,
        owner.tenantPhone,
        `Rivet daily: ${digest.pending} approval(s) waiting, ${formatCents(digest.paid)} collected yesterday, ${formatCents(digest.outstanding)} outstanding.`,
      );
    }
  });
}

export async function registerCommsWorkers(deps: CommsDeps): Promise<void> {
  await registerProposalNotifyWorker(deps);
  await registerNotifyOwnerWorker(deps);
  await registerInvoiceSmsWorker(deps);
  await registerEstimateSmsWorker(deps);
  await registerBookingConfirmationWorker(deps);
  await registerDailyDigestWorker(deps);
}
