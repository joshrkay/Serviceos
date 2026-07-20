import { useRouter } from 'expo-router';
import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';
import { useMe } from '../src/hooks/useMe';
import { describeRecurrence } from '../src/agreements/recurrence';
import { formatMoneyCents, formatShortDate } from '../src/lib/format';
import type { Agreement } from '../src/api/agreements';

function titleCase(value?: string): string | undefined {
  if (!value) return undefined;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Service agreements — recurring maintenance plans that auto-mint jobs/invoices. */
export default function Agreements() {
  const router = useRouter();
  const { me } = useMe();
  const { data, isLoading, error, refetch } = useListQuery<Agreement>('/api/agreements');

  return (
    <EntityList
      title="Agreements"
      data={data}
      isLoading={isLoading}
      error={error}
      onRefresh={() => void refetch()}
      keyOf={(a) => a.id}
      onPressRow={(a) => router.push(`/agreements/${a.id}`)}
      renderRow={(a) => ({
        primary: a.name,
        secondary: [
          describeRecurrence(a.recurrenceRule),
          formatMoneyCents(a.priceCents),
          titleCase(a.status),
          a.nextRunAt ? `next ${formatShortDate(a.nextRunAt, me?.timezone)}` : undefined,
        ]
          .filter(Boolean)
          .join(' · '),
      })}
      emptyText="No service agreements yet."
    />
  );
}
