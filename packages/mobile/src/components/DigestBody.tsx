import { ActivityIndicator, Text } from 'react-native';
import type { DigestResponse } from '../api/digest';
import { formatDigestPayloadSummary } from '../api/digest';
import { formatMoneyCents, formatShortDate } from '../lib/format';
import { ErrorState } from './ErrorState';
import { LabelValueTable } from './LabelValueTable';

const NO_DIGEST_MESSAGE = 'No digest for this day';

export interface DigestBodyProps {
  data: DigestResponse | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/** Shared digest read view — loading, empty, error, and snapshot content. */
export function DigestBody({ data, isLoading, error, refetch }: DigestBodyProps) {
  const isEmpty = error === NO_DIGEST_MESSAGE;

  if (isLoading && !data) {
    return <ActivityIndicator accessibilityLabel="Loading digest" />;
  }

  if (error && !isEmpty) {
    return <ErrorState error={error} onRetry={() => void refetch()} className="mb-4" />;
  }

  if (isEmpty || !data) {
    return <Text className="text-base text-mutedForeground">{NO_DIGEST_MESSAGE}</Text>;
  }

  const rows = [
    { label: 'Date', value: data.date },
    { label: 'Generated', value: formatShortDate(data.generatedAt) },
    ...(typeof data.payload.revenueCents === 'number'
      ? [{ label: 'Revenue', value: formatMoneyCents(data.payload.revenueCents) }]
      : []),
    {
      label: 'Summary',
      value: formatDigestPayloadSummary(data.payload, formatMoneyCents),
    },
  ];

  return (
    <>
      {data.narrative ? (
        <Text className="mb-4 text-base leading-relaxed text-foreground">{data.narrative}</Text>
      ) : null}

      <LabelValueTable rows={rows} />
    </>
  );
}
