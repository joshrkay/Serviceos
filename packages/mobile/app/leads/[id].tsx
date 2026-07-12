import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native';
import { ErrorState } from '../../src/components/ErrorState';
import { LabelValueTable } from '../../src/components/LabelValueTable';
import { ScreenShell } from '../../src/components/ScreenShell';
import { useDetailQuery } from '../../src/hooks/useDetailQuery';
import { formatMoneyCents } from '../../src/lib/format';
import { buildMailtoUrl, buildSmsUrl, buildTelUrl } from '../../src/lib/deviceLinks';

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

  const telUrl = buildTelUrl(data?.primaryPhone);
  const smsUrl = buildSmsUrl(data?.primaryPhone);
  const mailtoUrl = buildMailtoUrl(data?.email);

  return (
    <ScreenShell title={leadName(data ?? undefined)} backLabel="‹ Leads">
      {isLoading ? <ActivityIndicator /> : null}
      {error ? <ErrorState error={error} showRetry onRetry={() => void refetch()} className="mb-4" /> : null}

      {data ? (
        <View>
          <View className="mb-4 flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={telUrl ? 'Call lead' : 'Call unavailable — no phone on file'}
              disabled={!telUrl}
              onPress={() => telUrl && void Linking.openURL(telUrl)}
              className={`min-h-11 flex-1 items-center justify-center rounded-md bg-primary px-4 py-3 ${
                telUrl ? '' : 'opacity-50'
              }`}
            >
              <Text className="text-base font-semibold text-primaryForeground">Call</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={smsUrl ? 'Text lead' : 'Text unavailable — no phone on file'}
              disabled={!smsUrl}
              onPress={() => smsUrl && void Linking.openURL(smsUrl)}
              className={`min-h-11 flex-1 items-center justify-center rounded-md border border-border px-4 py-3 ${
                smsUrl ? '' : 'opacity-50'
              }`}
            >
              <Text className="text-base text-foreground">Text</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={mailtoUrl ? 'Email lead' : 'Email unavailable — no email on file'}
              disabled={!mailtoUrl}
              onPress={() => mailtoUrl && void Linking.openURL(mailtoUrl)}
              className={`min-h-11 flex-1 items-center justify-center rounded-md border border-border px-4 py-3 ${
                mailtoUrl ? '' : 'opacity-50'
              }`}
            >
              <Text className="text-base text-foreground">Email</Text>
            </Pressable>
          </View>

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
        </View>
      ) : null}
    </ScreenShell>
  );
}
