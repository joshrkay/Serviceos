import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Text, View } from 'react-native';
import { ErrorState } from '../../src/components/ErrorState';
import { LabelValueTable } from '../../src/components/LabelValueTable';
import { ScreenShell } from '../../src/components/ScreenShell';
import { useDetailQuery } from '../../src/hooks/useDetailQuery';
import { useMe } from '../../src/hooks/useMe';
import { formatMoneyCents, formatShortDate } from '../../src/lib/format';
import {
  agreementCustomerName,
  humanizeRecurrence,
  type AgreementDetail,
} from '../../src/api/agreements';

interface CustomerLite {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
}

// U10 (E5b) — service-agreement detail (read-only oversight surface). The
// agreement embeds only `customerId`, so the display name is joined via a
// second GET /api/customers/:id. `nextRunAt`/`lastRunAt` are UTC instants
// rendered in the tenant timezone; `scheduledFor` on each run is a plain
// calendar date. Price is integer cents via formatMoneyCents.
export default function AgreementDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const { me } = useMe();
  const tz = me?.timezone;

  const { data, isLoading, error, refetch } = useDetailQuery<AgreementDetail>(
    id ? `/api/agreements/${id}` : null,
  );

  // Customer-name join — only fires once the agreement's customerId is known.
  const { data: customer } = useDetailQuery<CustomerLite>(
    data?.customerId ? `/api/customers/${data.customerId}` : null,
  );

  const title = data?.name ?? 'Agreement';
  const runs = data?.recentRuns ?? [];

  return (
    <ScreenShell title={title} backLabel="‹ Agreements">
      {isLoading ? <ActivityIndicator /> : null}
      {error ? (
        <ErrorState error={error} showRetry onRetry={() => void refetch()} className="mb-4" />
      ) : null}

      {data ? (
        <View>
          <Text className="mb-4 text-2xl font-semibold text-foreground">
            {formatMoneyCents(data.priceCents ?? 0)}
          </Text>

          <LabelValueTable
            rows={[
              { label: 'Status', value: data.status },
              { label: 'Cadence', value: humanizeRecurrence(data.recurrenceRule) },
              { label: 'Customer', value: agreementCustomerName(customer) },
              {
                label: 'Next invoice',
                value: data.nextRunAt ? formatShortDate(data.nextRunAt, tz) : undefined,
              },
              {
                label: 'Last run',
                value: data.lastRunAt ? formatShortDate(data.lastRunAt, tz) : undefined,
              },
              { label: 'Starts', value: data.startsOn ? formatShortDate(data.startsOn) : undefined },
              { label: 'Ends', value: data.endsOn ? formatShortDate(data.endsOn) : undefined },
              { label: 'Auto-invoice', value: data.autoGenerateInvoice ? 'Yes' : 'No' },
              { label: 'Auto-job', value: data.autoGenerateJob ? 'Yes' : 'No' },
              { label: 'Auto-renew', value: data.autoRenew ? 'Yes' : undefined },
            ]}
          />

          {data.description ? (
            <Text className="mt-4 text-base text-mutedForeground">{data.description}</Text>
          ) : null}

          <Text className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-mutedForeground">
            Recent runs
          </Text>
          {runs.length === 0 ? (
            <Text className="text-base text-mutedForeground">No runs yet.</Text>
          ) : (
            <View className="rounded-lg border border-border">
              {runs.map((run, i) => (
                <View
                  key={run.id}
                  className={`flex-row justify-between px-4 py-3 ${
                    i < runs.length - 1 ? 'border-b border-border' : ''
                  }`}
                >
                  <Text className="text-base text-foreground">
                    {formatShortDate(run.scheduledFor)}
                  </Text>
                  <Text className="max-w-[55%] text-right text-base text-mutedForeground">
                    {run.status}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>
      ) : null}
    </ScreenShell>
  );
}
