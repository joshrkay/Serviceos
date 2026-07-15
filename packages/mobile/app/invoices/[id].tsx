import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Text } from 'react-native';
import { CollectPaymentPanel } from '../../src/components/CollectPaymentPanel';
import { ErrorState } from '../../src/components/ErrorState';
import { LabelValueTable } from '../../src/components/LabelValueTable';
import { ScreenShell } from '../../src/components/ScreenShell';
import { useDetailQuery } from '../../src/hooks/useDetailQuery';
import { useApiClient } from '../../src/lib/useApiClient';
import { formatMoneyCents, formatShortDate } from '../../src/lib/format';

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

export default function InvoiceDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const client = useApiClient();
  const { data, isLoading, error, refetch } = useDetailQuery<InvoiceDetail>(
    id ? `/api/invoices/${id}` : null,
  );

  const title = data?.invoiceNumber ?? (id ? `Invoice ${id.slice(0, 8)}` : 'Invoice');
  const amountDue = data?.amountDueCents ?? data?.totals?.totalCents ?? 0;
  const showCollect = data && PAYABLE.has(data.status ?? '') && amountDue > 0;

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
          {showCollect ? (
            <CollectPaymentPanel
              client={client}
              invoiceId={data.id}
              amountDueCents={amountDue}
              payLinkUrl={data.stripePaymentLinkUrl}
              onCollected={() => void refetch()}
            />
          ) : null}
        </>
      ) : null}
    </ScreenShell>
  );
}
