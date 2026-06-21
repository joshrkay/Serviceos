/**
 * OwnerNotificationService — the single fan-out point for every owner-facing
 * push. Generalizes the proposal-only notifier: a typed descriptor registry
 * maps each `NotificationType` to (a) the permission that gates who receives it
 * and (b) how to build the push copy + `data` payload from typed context.
 *
 * Targeting: when a `resolveUserIds` resolver is provided, only the devices of
 * users holding the descriptor's permission receive the push (so a technician
 * who signs into the app never gets payment/escalation content). With no
 * resolver, all tenant devices receive it (back-compat with the original
 * proposal notifier).
 *
 * Failure-isolated: a push error NEVER propagates — notifications must never
 * break the call/SMS/appointment/proposal path that triggered them. Dead tokens
 * (Expo `DeviceNotRegistered`) are pruned as a side effect.
 */
import {
  type NotificationData,
  type NotificationType,
} from '@ai-service-os/shared';
import { type Permission } from '../auth/rbac';
import { type Logger } from '../logging/logger';
import { type DeviceTokenRepository } from '../push/device-token-service';
import { type PushDeliveryProvider, type PushMessage } from './push-delivery-provider';

/** Typed context each notification kind needs to render its copy + deep link. */
export interface NotificationContextMap {
  proposal_needs_approval: { proposalId: string; summary: string };
  proposal_executed: { proposalId: string; summary?: string };
  incoming_call: { customerId?: string; callerLabel: string };
  inbound_sms: { conversationId: string; customerName: string; preview: string };
  appointment_reminder: { appointmentId: string; customerName: string; whenLabel: string };
  appointment_cancellation: { appointmentId: string; customerName: string; whenLabel: string };
  payment_received: { invoiceId: string; customerName: string; amountLabel: string };
  invoice_overdue: { invoiceId: string; customerName: string; amountLabel: string };
  lead_captured: { leadId: string; leadLabel: string };
  escalation: { reason: string; proposalId?: string; customerId?: string };
  emergency: { reason: string; proposalId?: string; customerId?: string };
}

interface BuiltNotification {
  title: string;
  body: string;
  data: NotificationData;
}

type Descriptor<K extends NotificationType> = {
  /** Permission a user's role must grant to receive this notification type. */
  permission: Permission;
  build(ctx: NotificationContextMap[K]): BuiltNotification;
};

type DescriptorMap = { [K in NotificationType]: Descriptor<K> };

/**
 * Copy is short, blame-free, and action-first (matches the app's existing
 * voice). `screen` deep-links to an existing mobile route; the client validates
 * it against an allowlist.
 */
export const NOTIFICATION_DESCRIPTORS: DescriptorMap = {
  proposal_needs_approval: {
    permission: 'proposals:approve',
    build: (ctx) => ({
      title: 'Approval needed',
      body: ctx.summary || 'A draft is ready for your review.',
      data: {
        type: 'proposal_needs_approval',
        screen: `/proposals/${ctx.proposalId}`,
        entityId: ctx.proposalId,
        proposalId: ctx.proposalId,
        kind: 'needs_approval',
      },
    }),
  },
  proposal_executed: {
    permission: 'proposals:approve',
    build: (ctx) => ({
      title: 'Done',
      body: ctx.summary || 'Your action is done.',
      data: {
        type: 'proposal_executed',
        screen: `/proposals/${ctx.proposalId}`,
        entityId: ctx.proposalId,
        proposalId: ctx.proposalId,
        kind: 'executed',
      },
    }),
  },
  incoming_call: {
    permission: 'conversations:manage',
    build: (ctx) => ({
      title: 'Incoming call',
      body: `${ctx.callerLabel} is calling.`,
      data: {
        type: 'incoming_call',
        // Known caller → their customer record; an unknown caller has only a
        // CRM lead (separate id space, no mobile detail route) → the customers
        // list, so the tap never 404s.
        screen: ctx.customerId ? `/customers/${ctx.customerId}` : '/customers',
        ...(ctx.customerId ? { entityId: ctx.customerId } : {}),
      },
    }),
  },
  inbound_sms: {
    permission: 'conversations:manage',
    build: (ctx) => ({
      title: `New text from ${ctx.customerName}`,
      body: ctx.preview,
      data: {
        type: 'inbound_sms',
        screen: `/messages/${ctx.conversationId}`,
        entityId: ctx.conversationId,
      },
    }),
  },
  appointment_reminder: {
    permission: 'dispatch:view',
    build: (ctx) => ({
      title: 'Upcoming appointment',
      body: `${ctx.customerName} — ${ctx.whenLabel}.`,
      data: {
        type: 'appointment_reminder',
        screen: '/schedule',
        entityId: ctx.appointmentId,
      },
    }),
  },
  appointment_cancellation: {
    permission: 'dispatch:view',
    build: (ctx) => ({
      title: 'Appointment cancelled',
      body: `${ctx.customerName}'s appointment (${ctx.whenLabel}) was cancelled.`,
      data: {
        type: 'appointment_cancellation',
        screen: '/schedule',
        entityId: ctx.appointmentId,
      },
    }),
  },
  payment_received: {
    permission: 'payments:create',
    build: (ctx) => ({
      title: 'Payment received',
      body: `${ctx.customerName} paid ${ctx.amountLabel}.`,
      data: {
        type: 'payment_received',
        screen: '/invoices',
        entityId: ctx.invoiceId,
      },
    }),
  },
  invoice_overdue: {
    permission: 'invoices:update',
    build: (ctx) => ({
      title: 'Invoice overdue',
      body: `${ctx.customerName}'s invoice (${ctx.amountLabel}) is overdue.`,
      data: {
        type: 'invoice_overdue',
        screen: '/invoices',
        entityId: ctx.invoiceId,
      },
    }),
  },
  lead_captured: {
    permission: 'customers:create',
    build: (ctx) => ({
      title: 'New lead',
      body: `${ctx.leadLabel} just came in.`,
      data: {
        type: 'lead_captured',
        // A lead is not a customer (separate id space, no mobile detail route),
        // so deep-link to the customers list. `entityId` carries the lead id.
        screen: '/customers',
        entityId: ctx.leadId,
      },
    }),
  },
  escalation: {
    permission: 'proposals:approve',
    build: (ctx) => ({
      title: 'Needs your attention',
      body: ctx.reason,
      data: {
        type: 'escalation',
        screen: ctx.proposalId ? `/proposals/${ctx.proposalId}` : '/approvals',
        ...(ctx.proposalId ? { entityId: ctx.proposalId, proposalId: ctx.proposalId } : {}),
      },
    }),
  },
  emergency: {
    permission: 'proposals:approve',
    build: (ctx) => ({
      title: 'Emergency',
      body: ctx.reason,
      data: {
        type: 'emergency',
        screen: ctx.proposalId ? `/proposals/${ctx.proposalId}` : '/approvals',
        ...(ctx.proposalId ? { entityId: ctx.proposalId, proposalId: ctx.proposalId } : {}),
      },
    }),
  },
};

export interface OwnerNotificationServiceDeps {
  deviceTokenRepo: Pick<DeviceTokenRepository, 'listByTenant' | 'remove'>;
  provider: PushDeliveryProvider;
  /**
   * Restrict a notification to the devices of users holding its descriptor's
   * permission. Omit to send to every tenant device (back-compat).
   */
  resolveUserIds?: (tenantId: string, permission: Permission) => Promise<Set<string>>;
  logger?: Logger;
}

export class OwnerNotificationService {
  constructor(private readonly deps: OwnerNotificationServiceDeps) {}

  /**
   * Send the push for `type` to the tenant's eligible devices. Resolves to
   * void and never throws (errors are logged and swallowed).
   */
  async notify<K extends NotificationType>(
    tenantId: string,
    type: K,
    ctx: NotificationContextMap[K],
  ): Promise<void> {
    const descriptor = NOTIFICATION_DESCRIPTORS[type];
    const built = descriptor.build(ctx);
    await this.dispatch(tenantId, descriptor.permission, built);
  }

  private async dispatch(
    tenantId: string,
    permission: Permission,
    built: BuiltNotification,
  ): Promise<void> {
    try {
      const tokens = await this.deps.deviceTokenRepo.listByTenant(tenantId);
      if (tokens.length === 0) return;

      let recipients = tokens;
      if (this.deps.resolveUserIds) {
        const allowed = await this.deps.resolveUserIds(tenantId, permission);
        recipients = tokens.filter((t) => allowed.has(t.userId));
      }
      if (recipients.length === 0) return;

      const messages: PushMessage[] = recipients.map((t) => ({
        to: t.expoPushToken,
        title: built.title,
        body: built.body,
        data: built.data,
      }));
      const results = await this.deps.provider.sendPush(messages);

      for (const r of results) {
        if (r.deviceNotRegistered) {
          try {
            await this.deps.deviceTokenRepo.remove(tenantId, r.to);
          } catch {
            // pruning is best-effort
          }
        }
      }
    } catch (err) {
      this.deps.logger?.warn('owner notification failed', {
        tenantId,
        permission,
        type: built.data.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
