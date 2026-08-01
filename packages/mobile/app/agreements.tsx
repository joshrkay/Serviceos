import { useRouter } from 'expo-router';
import { useState } from 'react';
import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';
import { useMe } from '../src/hooks/useMe';
import { formatMoneyCents, formatShortDate } from '../src/lib/format';
import { humanizeRecurrence, type Agreement } from '../src/api/agreements';

// U10 (E5b) — service-agreements read list (oversight/owner surface). Mirrors
// the invoices read-screen pattern: EntityList + useListQuery. Each row shows
// the agreement name + recurring price (integer cents) on the primary line and
// the humanized cadence + next-invoice date (tenant tz) + status on the
// secondary line.
export default function Agreements() {
  const router = useRouter();
  const { me } = useMe();
  const tz = me?.timezone;
  const { data, isLoading, error, refetch } = useListQuery<Agreement>('/api/agreements');
  const [search, setSearch] = useState('');

  const filtered = search.trim()
    ? data.filter((a) =>
        `${a.name} ${a.status ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : data;

  return (
    <EntityList
      title="Agreements"
      data={filtered}
      isLoading={isLoading}
      error={error}
      onRefresh={() => void refetch()}
      keyOf={(a) => a.id}
      renderRow={(a) => ({
        primary: `${a.name} · ${formatMoneyCents(a.priceCents ?? 0)}`,
        secondary: [
          humanizeRecurrence(a.recurrenceRule),
          a.nextRunAt ? `next ${formatShortDate(a.nextRunAt, tz)}` : undefined,
          a.status,
        ]
          .filter(Boolean)
          .join(' · '),
      })}
      onPressRow={(a) => router.push(`/agreements/${a.id}`)}
      emptyText="No agreements yet."
      searchQuery={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search agreements…"
    />
  );
}
