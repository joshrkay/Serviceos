import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Linking, Text, View } from 'react-native';
import { PrimaryButton, SecondaryButton } from '../../src/components/Buttons';
import { CollectPaymentPanel } from '../../src/components/CollectPaymentPanel';
import { ErrorState } from '../../src/components/ErrorState';
import { LabelValueTable } from '../../src/components/LabelValueTable';
import { RecordPaymentSheet } from '../../src/components/RecordPaymentSheet';
import { ScreenShell } from '../../src/components/ScreenShell';
import {
  createInvoicePaymentLink,
  issueInvoice,
  sendInvoice,
} from '../../src/api/invoices';
import { useDetailQuery } from '../../src/hooks/useDetailQuery';
import { useSavePhase } from '../../src/hooks/useSavePhase';
import { useApiClient } from '../../src/lib/useApiClient';
import { formatMoneyCents, formatShortDate } from '../../src/lib/format';

interface InvoiceDetail {
  id: string;
  invoiceNumber?: string;
  status?: string;
  dueDate?: string;
  amountDueCents?: number;
  sentAt?: string | null;
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

export default function InvoiceDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const client = useApiClient();
  const { data, isLoading, error, refetch } = useDetailQuery<InvoiceDetail>(
    id ? `/api/invoices/${id}` : null,
  );

  const issuePhase = useSavePhase();
  const sendPhase = useSavePhase();
  const linkPhase = useSavePhase();
  const [payLinkUrl, setPayLinkUrl] = useState<string | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);

  const title = data?.invoiceNumber ?? (id ? `Invoice ${id.slice(0, 8)}` : 'Invoice');
  const status = data?.status ?? '';
  const amountDue = data?.amountDueCents ?? data?.totals?.totalCents ?? 0;
  const isDraft = status === 'draft';
  const isPayable = PAYABLE.has(status) && amountDue > 0;
  const showCollect = Boolean(data) && isPayable;
  const linkUrl = payLinkUrl ?? data?.stripePaymentLinkUrl ?? null;

  const onIssue = () =>
    void issuePhase.run(async () => {
      await issueInvoice(client, id);
      await refetch();
    });

  const onSend = () =>
    void sendPhase.run(async () => {
      await sendInvoice(client, id);
      await refetch();
    });

  const onCreateLink = () =>
    void linkPhase.run(async () => {
      const { url } = await createInvoicePaymentLink(client, id);
      setPayLinkUrl(url);
    });

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

          {/* Draft → issue it (draft → open, stamps the due date). */}
          {isDraft ? (
            <View className="mt-6">
              <PrimaryButton
                label={issuePhase.phase === 'saving' ? 'Issuing…' : 'Issue invoice'}
                loading={issuePhase.phase === 'saving'}
                onPress={onIssue}
              />
              {issuePhase.phase === 'error' && issuePhase.error ? (
                <Text className="mt-2 text-sm text-destructive">{issuePhase.error}</Text>
              ) : null}
            </View>
          ) : null}

          {/* Open/partially-paid → send, share a pay link, or record a payment. */}
          {isPayable ? (
            <View className="mt-6 gap-3">
              <Text className="text-xs font-medium uppercase tracking-wide text-mutedForeground">
                Get paid
              </Text>
              <PrimaryButton
                label={
                  sendPhase.phase === 'saving'
                    ? 'Sending…'
                    : data.sentAt
                      ? 'Resend to customer'
                      : 'Send to customer'
                }
                loading={sendPhase.phase === 'saving'}
                onPress={onSend}
              />
              {sendPhase.phase === 'error' && sendPhase.error ? (
                <Text className="text-sm text-destructive">{sendPhase.error}</Text>
              ) : null}

              <SecondaryButton
                label={
                  linkPhase.phase === 'saving'
                    ? 'Creating link…'
                    : linkUrl
                      ? 'Open payment link'
                      : 'Create payment link'
                }
                loading={linkPhase.phase === 'saving'}
                onPress={() => (linkUrl ? void Linking.openURL(linkUrl) : onCreateLink())}
              />
              {linkUrl ? (
                <Text className="text-sm text-mutedForeground" numberOfLines={1}>
                  {linkUrl}
                </Text>
              ) : null}
              {linkPhase.phase === 'error' && linkPhase.error ? (
                <Text className="text-sm text-destructive">{linkPhase.error}</Text>
              ) : null}

              <SecondaryButton label="Record payment" onPress={() => setRecordOpen(true)} />
            </View>
          ) : null}

          {showCollect ? (
            <CollectPaymentPanel
              client={client}
              invoiceId={data.id}
              amountDueCents={amountDue}
              payLinkUrl={linkUrl}
              onCollected={() => void refetch()}
            />
          ) : null}

          <RecordPaymentSheet
            visible={recordOpen}
            onClose={() => setRecordOpen(false)}
            client={client}
            invoiceId={data.id}
            amountDueCents={amountDue}
            onRecorded={() => void refetch()}
          />
        </>
      ) : null}
    </ScreenShell>
  );
}
