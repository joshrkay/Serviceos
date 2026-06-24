import { useRouter } from 'expo-router';
import { EntityList, type EntityBadge } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';

interface Customer {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  primaryPhone?: string;
  email?: string;
  // GET /api/customers carries the account classification; used for the row tag.
  accountType?: 'residential' | 'b2b' | 'property_manager';
}

function customerName(c: Customer): string {
  return c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unnamed customer';
}

/** First letters of the first + last word (or first two chars of a single word). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Non-residential accounts get a segment tag; residential stays clean. */
function accountBadge(c: Customer): EntityBadge | undefined {
  if (c.accountType === 'b2b') return { label: 'Business', tone: 'info' };
  if (c.accountType === 'property_manager') return { label: 'Property mgr', tone: 'info' };
  return undefined;
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
      renderRow={(c) => {
        const name = customerName(c);
        return {
          leading: initials(name),
          primary: name,
          secondary: c.primaryPhone ?? c.email,
          badge: accountBadge(c),
        };
      }}
      onPressRow={(c) => router.push(`/customers/${c.id}`)}
      emptyText="No customers yet."
    />
  );
}
