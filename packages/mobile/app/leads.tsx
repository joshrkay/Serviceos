import { useRouter } from 'expo-router';
import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';

interface Lead {
  id: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  primaryPhone?: string;
  source?: string;
  stage?: string;
}

function leadName(l: Lead): string {
  const person = [l.firstName, l.lastName].filter(Boolean).join(' ');
  return l.companyName || person || 'Unnamed lead';
}

export default function Leads() {
  const router = useRouter();
  const { data, isLoading, error, refetch } = useListQuery<Lead>('/api/leads');

  return (
    <EntityList
      title="Leads"
      data={data}
      isLoading={isLoading}
      error={error}
      onRefresh={() => void refetch()}
      keyOf={(l) => l.id}
      renderRow={(l) => ({
        primary: leadName(l),
        secondary: [l.stage, l.source, l.primaryPhone].filter(Boolean).join(' · '),
      })}
      onPressRow={(l) => router.push(`/leads/${l.id}`)}
      emptyText="No leads yet."
    />
  );
}
