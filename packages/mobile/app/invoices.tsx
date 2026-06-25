import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';
import { formatMoneyCents } from '../src/lib/format';

interface Invoice {
  id: string;
  invoiceNumber?: string;
  totals?: { totalCents?: number };
  status?: string;
}

export default function Invoices() {
  const router = useRouter();
  const { data, isLoading, error, refetch } = useListQuery<Invoice>('/api/invoices');
  const [search, setSearch] = useState('');

  const filtered = search.trim()
    ? data.filter((i) =>
        `${i.invoiceNumber ?? i.id} ${i.status ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : data;

  return (
    <EntityList
      title="Invoices"
      data={filtered}
      isLoading={isLoading}
      error={error}
      onRefresh={() => void refetch()}
      keyOf={(i) => i.id}
      renderRow={(i) => ({
        primary: `${i.invoiceNumber ?? `#${i.id.slice(0, 8)}`} · ${formatMoneyCents(i.totals?.totalCents ?? 0)}`,
        secondary: i.status === 'draft' ? `${i.status} · tap to edit` : i.status,
      })}
      onPressRow={(i) => router.push(`/invoices/${i.id}`)}
      emptyText="No invoices yet."
      searchQuery={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search invoices…"
      headerAction={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New invoice"
          onPress={() => router.push('/invoices/new')}
          className="min-h-11 justify-center px-2"
        >
          <Text className="text-base font-semibold text-primary">+ New</Text>
        </Pressable>
      }
    />
  );
}
