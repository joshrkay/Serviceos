import { useRouter } from 'expo-router';
import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';
import { formatShortDate } from '../src/lib/format';

interface CallLogEntry {
  id: string;
  direction?: string;
  fromNumber?: string;
  toNumber?: string;
  startedAt?: string;
  durationSec?: number;
}

export default function Calls() {
  const router = useRouter();
  const { data, isLoading, error, refetch } = useListQuery<CallLogEntry>('/api/calls');

  return (
    <EntityList
      title="Calls"
      data={data}
      isLoading={isLoading}
      error={error}
      onRefresh={() => void refetch()}
      keyOf={(c) => c.id}
      renderRow={(c) => ({
        primary: c.direction ? `${c.direction} · ${c.fromNumber ?? c.toNumber ?? 'Unknown'}` : 'Call',
        secondary: c.startedAt ? formatShortDate(c.startedAt) : undefined,
      })}
      onPressRow={(c) => router.push(`/calls/${c.id}`)}
      emptyText="No calls logged yet."
    />
  );
}
