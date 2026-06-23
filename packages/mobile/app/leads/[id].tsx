import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Text } from 'react-native';
import { ErrorState } from '../../src/components/ErrorState';
import { LabelValueTable } from '../../src/components/LabelValueTable';
import { ScreenShell } from '../../src/components/ScreenShell';
import { useDetailQuery } from '../../src/hooks/useDetailQuery';
import { formatMoneyCents } from '../../src/lib/format';

interface LeadDetail {
  id: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  primaryPhone?: string;
  email?: string;
  source?: string;
  stage?: string;
  estimatedValueCents?: number;
  notes?: string;
}

function leadName(l?: LeadDetail): string {
  if (!l) return 'Lead';
  const person = [l.firstName, l.lastName].filter(Boolean).join(' ');
  return l.companyName || person || 'Unnamed lead';
}

export default function LeadDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const { data, isLoading, error, refetch } = useDetailQuery<LeadDetail>(
    id ? `/api/leads/${id}` : null,
  );

  return (
    <ScreenShell title={leadName(data ?? undefined)} backLabel="‹ Leads">
      {isLoading ? <ActivityIndicator /> : null}
      {error ? <ErrorState error={error} showRetry onRetry={() => void refetch()} className="mb-4" /> : null}

      {data ? (
        <LabelValueTable
          rows={[
            { label: 'Stage', value: data.stage },
            { label: 'Source', value: data.source },
            { label: 'Phone', value: data.primaryPhone },
            { label: 'Email', value: data.email },
            {
              label: 'Est. value',
              value:
                data.estimatedValueCents !== undefined
                  ? formatMoneyCents(data.estimatedValueCents)
                  : undefined,
            },
            { label: 'Notes', value: data.notes },
          ]}
        />
      ) : null}
    </ScreenShell>
  );
}
