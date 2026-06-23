import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';
import { formatMoneyCents } from '../src/lib/format';

interface Estimate {
  id: string;
  estimateNumber?: string;
  totals?: { totalCents?: number };
  status?: string;
}

export default function Estimates() {
  const router = useRouter();
  const { data, isLoading, error, refetch } = useListQuery<Estimate>('/api/estimates');
  const [search, setSearch] = useState('');

  const filtered = search.trim()
    ? data.filter((e) =>
        `${e.estimateNumber ?? e.id} ${e.status ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : data;

  return (
    <EntityList
      title="Estimates"
      data={filtered}
      isLoading={isLoading}
      error={error}
      onRefresh={() => void refetch()}
      keyOf={(e) => e.id}
      renderRow={(e) => ({
        primary: `${e.estimateNumber ?? `#${e.id.slice(0, 8)}`} · ${formatMoneyCents(e.totals?.totalCents ?? 0)}`,
        secondary: e.status === 'draft' ? `${e.status} · tap to edit` : e.status,
      })}
      onPressRow={(e) => {
        if (e.status === 'draft') router.push('/estimates/new');
        else router.push(`/estimates/${e.id}`);
      }}
      emptyText="No estimates yet."
      searchQuery={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search estimates…"
      headerAction={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New estimate"
          onPress={() => router.push('/estimates/new')}
          className="min-h-11 justify-center px-2"
        >
          <Text className="text-base font-semibold text-primary">+ New</Text>
        </Pressable>
      }
    />
  );
}
