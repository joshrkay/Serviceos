import { useRouter } from 'expo-router';
import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';

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

  return (
    <EntityList
      title="Customers"
      data={data}
      isLoading={isLoading}
      error={error}
      onRefresh={() => void refetch()}
      keyOf={(c) => c.id}
      renderRow={(c) => ({ primary: customerName(c), secondary: c.primaryPhone ?? c.email })}
      onPressRow={(c) => router.push(`/customers/${c.id}`)}
      emptyText="No customers yet."
    />
  );
}
