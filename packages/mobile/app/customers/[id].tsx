import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { useDetailQuery } from '../../src/hooks/useDetailQuery';
import { useApiClient } from '../../src/lib/useApiClient';
import { addCustomerNote, createServiceLocation } from '../../src/api/customers';
import { startCustomerConversation } from '../../src/messaging/startCustomerConversation';
import { useStartCall } from '../../src/calls/useStartCall';
import { ErrorState } from '../../src/components/ErrorState';
import { useToast } from '../../src/components/Toast';
import { useReconnectRetry } from '../../src/lib/useReconnectRetry';

interface Customer {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  primaryPhone?: string;
  secondaryPhone?: string;
  email?: string;
}

function customerName(c?: Customer): string {
  if (!c) return 'Customer';
  return c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unnamed customer';
}

export default function CustomerDetail() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const router = useRouter();
  const api = useApiClient();
  const { showToast, showErrorToast } = useToast();
  const { data, isLoading, error, refetch } = useDetailQuery<Customer>(
    id ? `/api/customers/${id}` : null,
  );
  const { startCall, isCalling, error: callError } = useStartCall();
  const [messaging, setMessaging] = useState(false);

  // C3 — add-service-location form (DIRECT POST /api/locations). The server
  // requires street1/city/state/postalCode; we enforce the same four before
  // submit so a missing field surfaces inline, not as a server round-trip.
  const [showLocationForm, setShowLocationForm] = useState(false);
  const [loc, setLoc] = useState({ label: '', street1: '', city: '', state: '', postalCode: '' });
  const [savingLocation, setSavingLocation] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  // C6 — manual note composer (DIRECT POST /api/notes, entityType 'customer').
  const [showNoteForm, setShowNoteForm] = useState(false);
  const [noteContent, setNoteContent] = useState('');
  const [notePinned, setNotePinned] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  const locationComplete = Boolean(
    loc.street1.trim() && loc.city.trim() && loc.state.trim() && loc.postalCode.trim(),
  );

  async function onSaveLocation() {
    if (!id || savingLocation) return;
    if (!locationComplete) {
      setLocationError('Street, city, state, and ZIP are all required.');
      return;
    }
    setLocationError(null);
    setSavingLocation(true);
    try {
      await createServiceLocation(api, {
        customerId: id,
        street1: loc.street1.trim(),
        city: loc.city.trim(),
        state: loc.state.trim(),
        postalCode: loc.postalCode.trim(),
        ...(loc.label.trim() ? { label: loc.label.trim() } : {}),
      });
      setShowLocationForm(false);
      setLoc({ label: '', street1: '', city: '', state: '', postalCode: '' });
      showToast({ title: 'Service location added', tone: 'info' });
    } catch (e) {
      setLocationError(e instanceof Error ? e.message : 'Could not add the location.');
    } finally {
      setSavingLocation(false);
    }
  }

  async function onSaveNote() {
    const content = noteContent.trim();
    if (!id || savingNote) return;
    if (!content) {
      setNoteError('Write something before saving.');
      return;
    }
    setNoteError(null);
    setSavingNote(true);
    try {
      await addCustomerNote(api, { customerId: id, content, isPinned: notePinned });
      setShowNoteForm(false);
      setNoteContent('');
      setNotePinned(false);
      showToast({ title: 'Note added', tone: 'info' });
    } catch (e) {
      setNoteError(e instanceof Error ? e.message : 'Could not add the note.');
    } finally {
      setSavingNote(false);
    }
  }

  // Heal the detail on reconnect if the load failed while offline.
  useReconnectRetry(refetch, Boolean(error));

  // useStartCall keeps its own (already-friendly) error — surface it as a toast
  // so a call failure doesn't push a destructive line into the contact card.
  useEffect(() => {
    if (callError) showToast({ title: callError, tone: 'error' });
  }, [callError, showToast]);

  const name = customerName(data ?? undefined);

  const onMessage = async () => {
    if (!id || messaging) return;
    setMessaging(true);
    try {
      const conversationId = await startCustomerConversation(api, id);
      router.push({ pathname: '/messages/[id]', params: { id: conversationId, title: name } });
    } catch {
      showToast({
        title: "Couldn't open the conversation",
        body: 'Give it another try in a moment.',
        tone: 'error',
      });
    } finally {
      setMessaging(false);
    }
  };

  const rows: Array<{ label: string; value?: string }> = [
    { label: 'Phone', value: data?.primaryPhone },
    { label: 'Alt phone', value: data?.secondaryPhone },
    { label: 'Email', value: data?.email },
  ];

  return (
    <View className="flex-1 bg-background pt-16">
      <View className="px-6">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          className="min-h-11 justify-center"
        >
          <Text className="text-base text-mutedForeground">‹ Customers</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 24 }}>
        {isLoading ? <ActivityIndicator /> : null}
        {error ? <ErrorState error={error} showRetry onRetry={() => void refetch()} /> : null}

        {data ? (
          <View>
            <Text className="text-2xl font-semibold text-foreground">{name}</Text>

            <View className="mt-4 flex-row gap-2">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Message"
                onPress={() => void onMessage()}
                disabled={messaging}
                className="min-h-11 flex-1 items-center justify-center rounded-md bg-primary px-4 py-3"
              >
                {messaging ? (
                  <ActivityIndicator />
                ) : (
                  <Text className="text-base font-semibold text-primaryForeground">Message</Text>
                )}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Call"
                onPress={() => void startCall(id)}
                disabled={isCalling || !data.primaryPhone}
                className="min-h-11 flex-1 items-center justify-center rounded-md border border-border px-4 py-3"
              >
                {isCalling ? (
                  <ActivityIndicator />
                ) : (
                  <Text className="text-base text-foreground">Call</Text>
                )}
              </Pressable>
            </View>

            <View className="mt-5 rounded-lg border border-border">
              {rows
                .filter((r) => r.value)
                .map((r) => (
                  <View key={r.label} className="flex-row justify-between border-b border-border px-4 py-3">
                    <Text className="text-base text-mutedForeground">{r.label}</Text>
                    <Text className="text-base text-foreground">{r.value}</Text>
                  </View>
                ))}
            </View>

            <View className="mt-6 flex-row flex-wrap gap-2">
              {[
                { label: 'New job', route: `/jobs/new?customerId=${id}` as const },
                { label: 'New estimate', route: `/estimates/new?customerId=${id}` as const },
                { label: 'New invoice', route: `/invoices/new?customerId=${id}` as const },
                { label: 'Edit', route: `/customers/${id}/edit` as const },
              ].map((action) => (
                <Pressable
                  key={action.label}
                  accessibilityRole="button"
                  onPress={() => router.push(action.route)}
                  className="min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
                >
                  <Text className="text-base text-foreground">{action.label}</Text>
                </Pressable>
              ))}
            </View>

            {/* C3 — add a service location. */}
            <View className="mt-6">
              {!showLocationForm ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Add location"
                  onPress={() => {
                    setLocationError(null);
                    setShowLocationForm(true);
                  }}
                  className="min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
                >
                  <Text className="text-base font-semibold text-foreground">Add location</Text>
                </Pressable>
              ) : (
                <View className="rounded-lg border border-border bg-card p-4">
                  <Text className="text-base font-medium text-foreground">New service location</Text>
                  {locationError ? (
                    <Text className="mt-2 text-base text-destructive">{locationError}</Text>
                  ) : null}
                  <TextInput
                    accessibilityLabel="Location label"
                    value={loc.label}
                    onChangeText={(v) => setLoc((s) => ({ ...s, label: v }))}
                    placeholder="Label (optional, e.g. Rental unit)"
                    placeholderTextColor="#94a3b8"
                    className="mt-3 min-h-11 rounded-md border border-border px-4 py-3 text-base text-foreground"
                  />
                  <TextInput
                    accessibilityLabel="Street"
                    value={loc.street1}
                    onChangeText={(v) => setLoc((s) => ({ ...s, street1: v }))}
                    placeholder="Street address"
                    placeholderTextColor="#94a3b8"
                    className="mt-3 min-h-11 rounded-md border border-border px-4 py-3 text-base text-foreground"
                  />
                  <TextInput
                    accessibilityLabel="City"
                    value={loc.city}
                    onChangeText={(v) => setLoc((s) => ({ ...s, city: v }))}
                    placeholder="City"
                    placeholderTextColor="#94a3b8"
                    className="mt-3 min-h-11 rounded-md border border-border px-4 py-3 text-base text-foreground"
                  />
                  <View className="mt-3 flex-row gap-3">
                    <TextInput
                      accessibilityLabel="State"
                      value={loc.state}
                      onChangeText={(v) => setLoc((s) => ({ ...s, state: v }))}
                      placeholder="State"
                      placeholderTextColor="#94a3b8"
                      className="min-h-11 flex-1 rounded-md border border-border px-4 py-3 text-base text-foreground"
                    />
                    <TextInput
                      accessibilityLabel="ZIP"
                      value={loc.postalCode}
                      onChangeText={(v) => setLoc((s) => ({ ...s, postalCode: v }))}
                      placeholder="ZIP"
                      placeholderTextColor="#94a3b8"
                      className="min-h-11 flex-1 rounded-md border border-border px-4 py-3 text-base text-foreground"
                    />
                  </View>
                  <View className="mt-3 flex-row gap-3">
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Cancel add location"
                      onPress={() => {
                        setShowLocationForm(false);
                        setLocationError(null);
                      }}
                      disabled={savingLocation}
                      className="min-h-11 flex-1 items-center justify-center rounded-md border border-border px-4 py-3"
                    >
                      <Text className="text-base text-foreground">Cancel</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Save location"
                      onPress={() => void onSaveLocation()}
                      disabled={savingLocation}
                      className="min-h-11 flex-1 items-center justify-center rounded-md bg-primary px-4 py-3"
                    >
                      {savingLocation ? (
                        <ActivityIndicator color="#ffffff" />
                      ) : (
                        <Text className="text-base font-semibold text-primaryForeground">Save</Text>
                      )}
                    </Pressable>
                  </View>
                </View>
              )}
            </View>

            {/* C6 — manual note composer. */}
            <View className="mt-4">
              {!showNoteForm ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Add note"
                  onPress={() => {
                    setNoteError(null);
                    setShowNoteForm(true);
                  }}
                  className="min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
                >
                  <Text className="text-base font-semibold text-foreground">Add note</Text>
                </Pressable>
              ) : (
                <View className="rounded-lg border border-border bg-card p-4">
                  <Text className="text-base font-medium text-foreground">New note</Text>
                  {noteError ? (
                    <Text className="mt-2 text-base text-destructive">{noteError}</Text>
                  ) : null}
                  <TextInput
                    accessibilityLabel="Note content"
                    value={noteContent}
                    onChangeText={setNoteContent}
                    placeholder="Add a note about this customer"
                    placeholderTextColor="#94a3b8"
                    multiline
                    className="mt-3 min-h-11 rounded-md border border-border px-4 py-3 text-base text-foreground"
                  />
                  <View className="mt-3 flex-row items-center justify-between">
                    <Text className="text-base text-foreground">Pin to top</Text>
                    <Switch
                      accessibilityLabel="Pin note"
                      value={notePinned}
                      onValueChange={setNotePinned}
                    />
                  </View>
                  <View className="mt-3 flex-row gap-3">
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Cancel add note"
                      onPress={() => {
                        setShowNoteForm(false);
                        setNoteError(null);
                      }}
                      disabled={savingNote}
                      className="min-h-11 flex-1 items-center justify-center rounded-md border border-border px-4 py-3"
                    >
                      <Text className="text-base text-foreground">Cancel</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Save note"
                      onPress={() => void onSaveNote()}
                      disabled={savingNote}
                      className="min-h-11 flex-1 items-center justify-center rounded-md bg-primary px-4 py-3"
                    >
                      {savingNote ? (
                        <ActivityIndicator color="#ffffff" />
                      ) : (
                        <Text className="text-base font-semibold text-primaryForeground">Save</Text>
                      )}
                    </Pressable>
                  </View>
                </View>
              )}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
