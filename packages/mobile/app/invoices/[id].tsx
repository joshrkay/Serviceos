import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { issueInvoice, sendInvoice } from '../../src/api/invoices';
import { CollectPaymentPanel } from '../../src/components/CollectPaymentPanel';
import { ErrorState } from '../../src/components/ErrorState';
import { LabelValueTable } from '../../src/components/LabelValueTable';
import { ScreenShell } from '../../src/components/ScreenShell';
import { useDetailQuery } from '../../src/hooks/useDetailQuery';
import { copyForError } from '../../src/lib/errorCopy';
import { formatMoneyCents, formatShortDate } from '../../src/lib/format';
import { useApiClient } from '../../src/lib/useApiClient';

interface InvoiceDetail {
  id: string;
  invoiceNumber?: string;
  status?: string;
  dueDate?: string;
  amountDueCents?: number;
  stripePaymentLinkUrl?: string | null;
  totals?: { totalCents?: number; subtotalCents?: number; taxCents?: number };
  customer?: {
    displayName?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
}

function customerName(inv?: InvoiceDetail): string | undefined {
  const c = inv?.customer;
  if (!c) return undefined;
  return c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ');
}

const PAYABLE = new Set(['open', 'partially_paid']);

// A2/A3 — the two direct, human-initiated invoice actions. Both mirror the U1
// proposal-review confirm pattern (packages/mobile/app/proposals/[id].tsx): an
// explicit, action-naming sheet before anything fires. Issue moves the invoice
// into the money-owing state (money lane); Send messages the customer (comms
// lane). Late-fee / payment-reminder are deliberately NOT here — see the U5 note
// below the action row.
type PendingAction = 'issue' | 'send';

export default function InvoiceDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const client = useApiClient();
  const { data, isLoading, error, refetch } = useDetailQuery<InvoiceDetail>(
    id ? `/api/invoices/${id}` : null,
  );

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const title = data?.invoiceNumber ?? (id ? `Invoice ${id.slice(0, 8)}` : 'Invoice');
  const amountDue = data?.amountDueCents ?? data?.totals?.totalCents ?? 0;
  const status = data?.status ?? '';
  const isDraft = status === 'draft';
  const isPayable = PAYABLE.has(status);
  const showCollect = data ? isPayable && amountDue > 0 : false;

  async function runAction(action: PendingAction) {
    if (!data || busy) return; // double-tap guard
    setBusy(true);
    setActionError(null);
    try {
      if (action === 'issue') await issueInvoice(client, data.id);
      else await sendInvoice(client, data.id);
      setPending(null);
      await refetch(); // no optimistic state — re-read the server's new status
    } catch (err) {
      setActionError(copyForError(err).body);
    } finally {
      setBusy(false);
    }
  }

  const confirmCopy =
    pending === 'issue'
      ? {
          lane: 'money' as const,
          title: `Issue ${title} and start the clock?`,
          body: 'The invoice becomes payable and its due date is set.',
          confirmLabel: 'Issue it',
        }
      : {
          lane: 'comms' as const,
          title: `Send ${title} — this messages your customer.`,
          body: 'The customer gets the invoice and a link to pay.',
          confirmLabel: 'Send it',
        };

  return (
    <ScreenShell title={title} backLabel="‹ Invoices">
      {isLoading ? <ActivityIndicator /> : null}
      {error ? <ErrorState error={error} showRetry onRetry={() => void refetch()} className="mb-4" /> : null}

      {data ? (
        <>
          <Text className="mb-4 text-2xl font-semibold text-foreground">
            {formatMoneyCents(data.totals?.totalCents ?? 0)}
          </Text>
          <LabelValueTable
            rows={[
              { label: 'Status', value: data.status },
              { label: 'Due', value: data.dueDate ? formatShortDate(data.dueDate) : undefined },
              { label: 'Customer', value: customerName(data) },
              { label: 'Email', value: data.customer?.email },
              { label: 'Subtotal', value: formatMoneyCents(data.totals?.subtotalCents ?? 0) },
              { label: 'Tax', value: formatMoneyCents(data.totals?.taxCents ?? 0) },
              { label: 'Amount due', value: formatMoneyCents(amountDue) },
            ]}
          />

          {/* Status-aware action row. Nothing renders for paid/void — the
              invoice is settled and has no forward action. */}
          {isDraft || isPayable ? (
            <View className="mt-5 gap-3">
              {actionError ? (
                <Text className="text-base text-destructive">{actionError}</Text>
              ) : null}

              {pending ? (
                <View className="rounded-lg border border-border bg-card p-4">
                  <Text className="text-base font-medium text-foreground">{confirmCopy.title}</Text>
                  <Text className="mt-2 text-base text-mutedForeground">{confirmCopy.body}</Text>
                  <View className="mt-3 flex-row gap-3">
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Cancel"
                      onPress={() => setPending(null)}
                      disabled={busy}
                      className="min-h-11 flex-1 items-center justify-center rounded-md border border-border px-4 py-3"
                    >
                      <Text className="text-base text-foreground">Cancel</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={confirmCopy.confirmLabel}
                      onPress={() => void runAction(pending)}
                      disabled={busy}
                      className="min-h-11 flex-1 items-center justify-center rounded-md bg-primary px-4 py-3"
                    >
                      {busy ? (
                        <ActivityIndicator color="#ffffff" />
                      ) : (
                        <Text className="text-base font-semibold text-primaryForeground">
                          {confirmCopy.confirmLabel}
                        </Text>
                      )}
                    </Pressable>
                  </View>
                </View>
              ) : (
                <>
                  {isDraft ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Issue invoice"
                      onPress={() => {
                        setActionError(null);
                        setPending('issue');
                      }}
                      className="min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
                    >
                      <Text className="text-base font-semibold text-primaryForeground">
                        Issue invoice
                      </Text>
                    </Pressable>
                  ) : null}

                  {isPayable ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Send invoice"
                      onPress={() => {
                        setActionError(null);
                        setPending('send');
                      }}
                      className="min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
                    >
                      <Text className="text-base font-semibold text-foreground">Send</Text>
                    </Pressable>
                  ) : null}
                </>
              )}
            </View>
          ) : null}

          {showCollect ? (
            <CollectPaymentPanel
              client={client}
              invoiceId={data.id}
              amountDueCents={amountDue}
              payLinkUrl={data.stripePaymentLinkUrl}
              onCollected={() => void refetch()}
            />
          ) : null}

          {/* A8/A9 (Remind / Late fee) — DEFERRED in U5. These are money/comms
              proposal actions, but there is no client mint path for their types:
              POST /api/proposals only accepts the four scheduling types
              (reschedule/reassign/add-crew/remove-crew) and 400s
              UNSUPPORTED_PROPOSAL_TYPE for apply_late_fee / send_payment_reminder,
              and the task forbids inventing a server route in this unit. Until a
              direct route (or a broadened mint surface) lands, surface them as the
              sanctioned voice affordance so the owner still has a path. */}
          {isPayable ? (
            <Text className="mt-4 text-sm text-mutedForeground">
              To send a payment reminder or add a late fee, say it out loud — it lands
              in Approvals for you to confirm.
            </Text>
          ) : null}
        </>
      ) : null}
    </ScreenShell>
  );
}
