import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { EntityList } from '../../src/components/EntityList';
import { useListQuery } from '../../src/hooks/useListQuery';

interface Customer {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  primaryPhone?: string;
  email?: string;
}

function customerName(c: Customer): string {
  return c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unnamed customer';
}

export default function Customers() {
  const router = useRouter();
  const { data, isLoading, error, refetch } = useListQuery<Customer>('/api/customers');
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data;
    return data.filter((c) => customerName(c).toLowerCase().includes(q));
  }, [data, search]);

  return (
    <EntityList
      title="Customers"
      data={filtered}
      isLoading={isLoading}
      error={error}
      onRefresh={() => void refetch()}
      keyOf={(c) => c.id}
      renderRow={(c) => ({ primary: customerName(c), secondary: c.primaryPhone ?? c.email })}
      onPressRow={(c) => router.push(`/customers/${c.id}`)}
      emptyText="No customers yet."
      showBack={false}
      searchQuery={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search customers…"
      headerAction={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add customer"
          onPress={() => router.push('/customers/new')}
          className="min-h-11 justify-center px-2"
        >
          <Text className="text-base font-semibold text-primary">+ Add</Text>
        </Pressable>
      }
    />
  );
}
