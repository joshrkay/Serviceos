import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, TextInput, View } from 'react-native';
import { convertLead, loseLead } from '../../src/api/leads';
import { DestructiveButton, PrimaryButton, SecondaryButton } from '../../src/components/Buttons';
import { ConvertLeadSheet } from '../../src/components/ConvertLeadSheet';
import { ErrorState } from '../../src/components/ErrorState';
import { LabelValueTable } from '../../src/components/LabelValueTable';
import { ScreenShell } from '../../src/components/ScreenShell';
import { useToast } from '../../src/components/Toast';
import { useDetailQuery } from '../../src/hooks/useDetailQuery';
import { useMe } from '../../src/hooks/useMe';
import { useSavePhase } from '../../src/hooks/useSavePhase';
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
  lostReason?: string;
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  accessNotes?: string;
  convertedCustomerId?: string;
}

function leadName(l?: LeadDetail): string {
  if (!l) return 'Lead';
  const person = [l.firstName, l.lastName].filter(Boolean).join(' ');
  return l.companyName || person || 'Unnamed lead';
}

/** A lead can only convert when it carries a full service address; otherwise the
 * server 400s and we collect one first. */
function hasCompleteAddress(l?: LeadDetail | null): boolean {
  return Boolean(l?.street1 && l?.city && l?.state && l?.postalCode);
}

const TERMINAL_STAGES = new Set(['won', 'lost']);

export default function LeadDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const router = useRouter();
  const client = useApiClient();
  const { me } = useMe();
  const api = useApiClient();
  const { showToast } = useToast();
  const { data, isLoading, error, refetch } = useDetailQuery<LeadDetail>(
    id ? `/api/leads/${id}` : null,
  );

  const convertPhase = useSavePhase();
  const losePhase = useSavePhase();
  const [addressOpen, setAddressOpen] = useState(false);
  const [loseOpen, setLoseOpen] = useState(false);
  const [reason, setReason] = useState('');

  const telUrl = buildTelUrl(data?.primaryPhone);
  const smsUrl = buildSmsUrl(data?.primaryPhone);
  const mailtoUrl = buildMailtoUrl(data?.email);

  const perms = me?.permissions ?? [];
  const canConvert = perms.includes('customers:create');
  const canLose = perms.includes('customers:update');
  const isTerminal = TERMINAL_STAGES.has(data?.stage ?? '');
  const stage = data?.stage ?? '';

  const goToCustomer = (customerId: string) => {
    if (customerId) router.replace(`/customers/${customerId}`);
    else void refetch();
  };

  const onConvert = () => {
    if (hasCompleteAddress(data)) {
      void convertPhase.run(async () => {
        const { customerId } = await convertLead(client, id);
        goToCustomer(customerId);
      });
    } else {
      setAddressOpen(true);
    }
  };

  const onLose = () => {
    const trimmed = reason.trim();
    if (!trimmed) return;
    void losePhase.run(async () => {
      await loseLead(client, id, trimmed);
      setLoseOpen(false);
      setReason('');
      await refetch();
    });
  };

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
              { label: 'Lost reason', value: data.lostReason },
              { label: 'Notes', value: data.notes },
            ]}
          />

          {/* Terminal leads show their outcome; active leads show the actions. */}
          {stage === 'won' ? (
            <Text className="mt-6 text-base text-success">✓ Converted to a customer.</Text>
          ) : stage === 'lost' ? (
            <Text className="mt-6 text-base text-mutedForeground">This lead was marked lost.</Text>
          ) : null}

          {!isTerminal && (canConvert || canLose) ? (
            <View className="mt-6 gap-3">
              <Text className="text-xs font-medium uppercase tracking-wide text-mutedForeground">
                Move this lead
              </Text>

              {canConvert ? (
                <>
                  <PrimaryButton
                    label={convertPhase.phase === 'saving' ? 'Converting…' : 'Convert to customer'}
                    loading={convertPhase.phase === 'saving'}
                    onPress={onConvert}
                  />
                  {convertPhase.phase === 'error' && convertPhase.error ? (
                    <Text className="text-sm text-destructive">{convertPhase.error}</Text>
                  ) : null}
                </>
              ) : null}

              {canLose && !loseOpen ? (
                <SecondaryButton label="Mark lost" onPress={() => setLoseOpen(true)} />
              ) : null}

              {canLose && loseOpen ? (
                <View className="rounded-lg border border-border bg-card p-4">
                  <Text className="text-base font-medium text-foreground">Why is it lost?</Text>
                  <TextInput
                    accessibilityLabel="Lost reason"
                    value={reason}
                    onChangeText={setReason}
                    placeholder="e.g. went with a competitor"
                    placeholderTextColor="#94a3b8"
                    className="mt-3 min-h-11 rounded-md border border-border px-4 py-3 text-base text-foreground"
                  />
                  {losePhase.phase === 'error' && losePhase.error ? (
                    <Text className="mt-2 text-sm text-destructive">{losePhase.error}</Text>
                  ) : null}
                  <View className="mt-3 flex-row gap-2">
                    <SecondaryButton
                      label="Cancel"
                      onPress={() => {
                        setLoseOpen(false);
                        setReason('');
                      }}
                      className="flex-1"
                    />
                    <View className="flex-1">
                      <DestructiveButton
                        label={losePhase.phase === 'saving' ? 'Saving…' : 'Mark lost'}
                        loading={losePhase.phase === 'saving'}
                        disabled={!reason.trim()}
                        onPress={onLose}
                      />
                    </View>
                  </View>
                </View>
              ) : null}
            </View>
          ) : null}

          <ConvertLeadSheet
            visible={addressOpen}
            onClose={() => setAddressOpen(false)}
            client={client}
            leadId={id}
            initial={{
              street1: data.street1,
              street2: data.street2,
              city: data.city,
              state: data.state,
              postalCode: data.postalCode,
            }}
            onConverted={(customerId) => {
              setAddressOpen(false);
              goToCustomer(customerId);
            }}
          />
        </View>
      ) : null}
    </ScreenShell>
  );
}
