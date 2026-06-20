import { useRouter } from 'expo-router';
import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';

interface Customer {
  id: string;
  name?: string;
  phone?: string;
  email?: string;
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
      renderRow={(c) => ({ primary: c.name ?? 'Unnamed customer', secondary: c.phone ?? c.email })}
      onPressRow={(c) => router.push(`/customers/${c.id}`)}
      emptyText="No customers yet."
    />
  );
}
