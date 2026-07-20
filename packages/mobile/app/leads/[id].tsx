import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, TextInput, View } from 'react-native';
import { ErrorState } from '../../src/components/ErrorState';
import { LabelValueTable } from '../../src/components/LabelValueTable';
import { ScreenShell } from '../../src/components/ScreenShell';
import { useToast } from '../../src/components/Toast';
import { useDetailQuery } from '../../src/hooks/useDetailQuery';
import { useApiClient } from '../../src/lib/useApiClient';
import { formatMoneyCents } from '../../src/lib/format';
import { buildMailtoUrl, buildSmsUrl, buildTelUrl } from '../../src/lib/deviceLinks';
import { convertLead, markLeadLost } from '../../src/api/leads';

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
  convertedCustomerId?: string;
}

function leadName(l?: LeadDetail): string {
  if (!l) return 'Lead';
  const person = [l.firstName, l.lastName].filter(Boolean).join(' ');
  return l.companyName || person || 'Unnamed lead';
}

export default function LeadDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const router = useRouter();
  const api = useApiClient();
  const { showToast } = useToast();
  const { data, isLoading, error, refetch } = useDetailQuery<LeadDetail>(
    id ? `/api/leads/${id}` : null,
  );

  const [showConvertConfirm, setShowConvertConfirm] = useState(false);
  const [converting, setConverting] = useState(false);
  const [showLostForm, setShowLostForm] = useState(false);
  const [lostReason, setLostReason] = useState('');
  const [losing, setLosing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const telUrl = buildTelUrl(data?.primaryPhone);
  const smsUrl = buildSmsUrl(data?.primaryPhone);
  const mailtoUrl = buildMailtoUrl(data?.email);

  // A converted or lost lead is terminal — hide the lifecycle actions so the
  // owner can't re-convert (a 400) or re-lose it.
  const isConverted = Boolean(data?.convertedCustomerId) || data?.stage === 'won';
  const isLost = data?.stage === 'lost';
  const canConvert = Boolean(data) && !isConverted && !isLost;
  const canLose = Boolean(data) && !isConverted && !isLost;

  async function onConfirmConvert() {
    if (!id || converting) return;
    setActionError(null);
    setConverting(true);
    try {
      // C4 — capture-class direct route. On success the lead's own jobs are
      // relinked to the new customer server-side; we re-fetch to reflect the
      // terminal 'won' stage, then hand the owner the customer record.
      const result = await convertLead(api, id);
      setShowConvertConfirm(false);
      await refetch();
      showToast({ title: 'Lead converted to a customer', tone: 'info' });
      router.push(`/customers/${result.customer.id}`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not convert this lead.');
    } finally {
      setConverting(false);
    }
  }

  async function onConfirmLost() {
    const reason = lostReason.trim();
    if (!id || !reason || losing) return;
    setActionError(null);
    setLosing(true);
    try {
      await markLeadLost(api, id, reason);
      setShowLostForm(false);
      setLostReason('');
      await refetch();
      showToast({ title: 'Lead marked lost', tone: 'info' });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not mark this lead lost.');
    } finally {
      setLosing(false);
    }
  }

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

          {/* C4 / C5 — lifecycle actions. Convert is a capture confirm; mark-lost
              mirrors the reject-reason form (a required reason field). */}
          {canConvert || canLose ? (
            <View className="mb-4 gap-2">
              {actionError ? (
                <Text className="text-base text-destructive">{actionError}</Text>
              ) : null}

              {canConvert && !showConvertConfirm && !showLostForm ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Convert to customer"
                  onPress={() => {
                    setActionError(null);
                    setShowConvertConfirm(true);
                  }}
                  className="min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
                >
                  <Text className="text-base font-semibold text-primaryForeground">
                    Convert to customer
                  </Text>
                </Pressable>
              ) : null}

              {showConvertConfirm ? (
                <View className="rounded-lg border border-border bg-card p-4">
                  <Text className="text-base font-medium text-foreground">
                    Convert this lead to a customer?
                  </Text>
                  <Text className="mt-2 text-base text-mutedForeground">
                    Creates a customer and service location from this lead and moves any jobs over.
                  </Text>
                  <View className="mt-3 flex-row gap-3">
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Cancel convert"
                      onPress={() => setShowConvertConfirm(false)}
                      disabled={converting}
                      className="min-h-11 flex-1 items-center justify-center rounded-md border border-border px-4 py-3"
                    >
                      <Text className="text-base text-foreground">Cancel</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Confirm convert"
                      onPress={() => void onConfirmConvert()}
                      disabled={converting}
                      className="min-h-11 flex-1 items-center justify-center rounded-md bg-primary px-4 py-3"
                    >
                      {converting ? (
                        <ActivityIndicator color="#ffffff" />
                      ) : (
                        <Text className="text-base font-semibold text-primaryForeground">
                          Convert
                        </Text>
                      )}
                    </Pressable>
                  </View>
                </View>
              ) : null}

              {canLose && !showConvertConfirm && !showLostForm ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Mark lost"
                  onPress={() => {
                    setActionError(null);
                    setShowLostForm(true);
                  }}
                  className="min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
                >
                  <Text className="text-base font-semibold text-foreground">Mark lost</Text>
                </Pressable>
              ) : null}

              {showLostForm ? (
                <View className="rounded-lg border border-border bg-card p-4">
                  <Text className="text-base font-medium text-foreground">Why was it lost?</Text>
                  <TextInput
                    accessibilityLabel="Lost reason"
                    value={lostReason}
                    onChangeText={setLostReason}
                    placeholder="e.g. went with a competitor"
                    placeholderTextColor="#94a3b8"
                    className="mt-3 min-h-11 rounded-md border border-border px-4 py-3 text-base text-foreground"
                  />
                  <View className="mt-3 flex-row gap-3">
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Cancel mark lost"
                      onPress={() => {
                        setShowLostForm(false);
                        setLostReason('');
                      }}
                      disabled={losing}
                      className="min-h-11 flex-1 items-center justify-center rounded-md border border-border px-4 py-3"
                    >
                      <Text className="text-base text-foreground">Cancel</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Confirm mark lost"
                      onPress={() => void onConfirmLost()}
                      disabled={!lostReason.trim() || losing}
                      className="min-h-11 flex-1 items-center justify-center rounded-md bg-destructive px-4 py-3"
                    >
                      {losing ? (
                        <ActivityIndicator color="#ffffff" />
                      ) : (
                        <Text className="text-base font-semibold text-destructiveForeground">
                          Mark lost
                        </Text>
                      )}
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>
          ) : null}

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
