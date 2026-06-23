import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import type { AuthedFetch } from '../../src/api/me';
import { getInteraction, type InteractionDetail } from '../../src/api/interactions';
import { ErrorState } from '../../src/components/ErrorState';
import { LabelValueTable } from '../../src/components/LabelValueTable';
import { ScreenShell } from '../../src/components/ScreenShell';
import { useApiClient } from '../../src/lib/useApiClient';

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function parseTranscriptLine(line: string): { speaker: string; text: string; isAgent: boolean } {
  const isAgent = line.startsWith('agent:');
  const text = line.replace(/^(agent|caller):\s*/i, '');
  return { speaker: isAgent ? 'Agent' : 'Caller', text, isAgent };
}

export default function CallDetail() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = firstParam(params.id);
  const api = useApiClient() as AuthedFetch;
  const [detail, setDetail] = useState<InteractionDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);

  const refetch = useCallback(async () => {
    if (!id) {
      setIsLoading(false);
      return;
    }
    const myVersion = ++versionRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await getInteraction(api, id);
      if (myVersion !== versionRef.current) return;
      setDetail(result);
    } catch (err) {
      if (myVersion !== versionRef.current) return;
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (myVersion === versionRef.current) setIsLoading(false);
    }
  }, [api, id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const customerName = detail?.customer?.displayName ?? 'Unknown caller';

  return (
    <ScreenShell title="Call detail" backLabel="‹ Calls">
      {error ? <ErrorState error={error} onRetry={() => void refetch()} className="mb-4" /> : null}

      {isLoading && !detail ? (
        <ActivityIndicator />
      ) : detail ? (
        <>
          <LabelValueTable
            rows={[
              { label: 'Customer', value: customerName },
              { label: 'Duration', value: formatDuration(detail.durationSeconds) },
              { label: 'Outcome', value: detail.outcome },
              { label: 'Started', value: detail.startedAt },
            ]}
          />

          <Text className="mb-3 mt-6 text-base font-semibold text-foreground">Transcript</Text>
          {detail.transcript.length === 0 ? (
            <Text className="text-base text-mutedForeground">No transcript recorded for this call.</Text>
          ) : (
            <View className="gap-2">
              {detail.transcript.map((line, i) => {
                const { speaker, text, isAgent } = parseTranscriptLine(line);
                return (
                  <View
                    key={`${i}-${speaker}`}
                    className={`max-w-[85%] rounded-2xl px-4 py-2 ${isAgent ? 'self-end bg-primary' : 'self-start bg-secondary'}`}
                  >
                    <Text
                      className={
                        isAgent
                          ? 'mb-0.5 text-xs font-medium text-primaryForeground/80'
                          : 'mb-0.5 text-xs font-medium text-secondaryForeground/80'
                      }
                    >
                      {speaker}
                    </Text>
                    <Text
                      className={
                        isAgent ? 'text-base text-primaryForeground' : 'text-base text-secondaryForeground'
                      }
                    >
                      {text}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}
        </>
      ) : !error ? (
        <Text className="text-base text-mutedForeground">Call not found.</Text>
      ) : null}
    </ScreenShell>
  );
}
