import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Text } from 'react-native';
import { ErrorState } from '../../src/components/ErrorState';
import { LabelValueTable } from '../../src/components/LabelValueTable';
import { ScreenShell } from '../../src/components/ScreenShell';
import { useDetailQuery } from '../../src/hooks/useDetailQuery';
import { formatMoneyCents, formatShortDate } from '../../src/lib/format';

interface EstimateDetail {
  id: string;
  estimateNumber?: string;
  status?: string;
  validUntil?: string;
  totals?: { totalCents?: number; subtotalCents?: number; taxCents?: number };
  customer?: {
    displayName?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
}

function customerName(est?: EstimateDetail): string | undefined {
  const c = est?.customer;
  if (!c) return undefined;
  return c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ');
}

export default function EstimateDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const { data, isLoading, error, refetch } = useDetailQuery<EstimateDetail>(
    id ? `/api/estimates/${id}` : null,
  );

  const title = data?.estimateNumber ?? (id ? `Estimate ${id.slice(0, 8)}` : 'Estimate');

  return (
    <ScreenShell title={title} backLabel="‹ Estimates">
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
              { label: 'Valid until', value: data.validUntil ? formatShortDate(data.validUntil) : undefined },
              { label: 'Customer', value: customerName(data) },
              { label: 'Email', value: data.customer?.email },
              { label: 'Subtotal', value: formatMoneyCents(data.totals?.subtotalCents ?? 0) },
              { label: 'Tax', value: formatMoneyCents(data.totals?.taxCents ?? 0) },
            ]}
          />
        </>
      ) : null}
    </ScreenShell>
  );
}
