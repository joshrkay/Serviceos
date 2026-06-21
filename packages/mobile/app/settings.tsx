import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useMe } from '../src/hooks/useMe';
import { useDeleteAccount } from '../src/hooks/useDeleteAccount';
import { useSignOut } from '../src/push/useSignOut';
import { getCallbackNumber, saveCallbackNumber } from '../src/calls/callbackStorage';
import { ErrorState } from '../src/components/ErrorState';
import { PushDeniedNotice } from '../src/components/PushDeniedNotice';

export default function Settings() {
  const router = useRouter();
  const { me, isLoading, error, refetch } = useMe();
  const signOut = useSignOut();
  const { phase: deletePhase, error: deleteError, deleteAccount } = useDeleteAccount();

  const [callback, setCallback] = useState('');
  const [callbackStatus, setCallbackStatus] = useState<'idle' | 'saved' | 'invalid'>('idle');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const onConfirmDelete = async () => {
    const deleted = await deleteAccount();
    // On success the tenant is being purged server-side; sign out so the auth
    // gate returns the (now account-less) user to the sign-in screen.
    if (deleted) await signOut();
  };

  useEffect(() => {
    void getCallbackNumber().then((n) => {
      if (n) setCallback(n);
    });
  }, []);

  const onSaveCallback = async () => {
    const stored = await saveCallbackNumber(callback);
    if (!stored) {
      setCallbackStatus('invalid');
      return;
    }
    setCallback(stored);
    setCallbackStatus('saved');
  };

  const rows: Array<{ label: string; value?: string }> = [
    { label: 'Role', value: me?.role },
    { label: 'Mode', value: me?.current_mode },
    { label: 'Field-capable', value: me ? (me.can_field_serve ? 'Yes' : 'No') : undefined },
    { label: 'Tenant', value: me?.tenant_id },
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
          <Text className="text-base text-mutedForeground">‹ Back</Text>
        </Pressable>
        <Text className="mt-2 text-2xl font-semibold text-foreground">Settings</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 24 }}>
        {isLoading ? <ActivityIndicator /> : null}
        {error ? (
          <ErrorState error={error} showRetry onRetry={() => void refetch()} className="mb-4" />
        ) : null}

        <PushDeniedNotice className="mb-4" />

        <View className="rounded-lg border border-border">
          {rows
            .filter((r) => r.value !== undefined)
            .map((r) => (
              <View key={r.label} className="flex-row justify-between border-b border-border px-4 py-3">
                <Text className="text-base text-mutedForeground">{r.label}</Text>
                <Text className="text-base text-foreground">{r.value}</Text>
              </View>
            ))}
        </View>

        {/* Click-to-call callback number — the phone we ring first when you call
            a customer. Stored on this device only. */}
        <Text className="mt-8 text-base font-medium text-foreground">Your callback number</Text>
        <Text className="mt-1 text-sm text-mutedForeground">
          We ring this phone first, then connect you to the customer from your business number.
        </Text>
        <TextInput
          className="mt-3 min-h-11 rounded-md border border-border px-4 py-2 text-base text-foreground"
          placeholder="+1 555 123 4567"
          keyboardType="phone-pad"
          value={callback}
          onChangeText={(t) => {
            setCallback(t);
            setCallbackStatus('idle');
          }}
        />
        {callbackStatus === 'invalid' ? (
          <Text className="mt-1 text-sm text-destructive">Enter a valid phone number.</Text>
        ) : null}
        {callbackStatus === 'saved' ? (
          <Text className="mt-1 text-sm text-mutedForeground">Saved.</Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save callback number"
          onPress={() => void onSaveCallback()}
          className="mt-3 min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
        >
          <Text className="text-base font-semibold text-primaryForeground">Save</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          onPress={() => void signOut()}
          className="mt-8 min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
        >
          <Text className="text-base text-destructive">Sign out</Text>
        </Pressable>

        {/* Danger zone — self-serve account deletion required by Apple App Store
            Review Guideline 5.1.1(v). Owner-only on the API; a non-owner's tap
            returns 403 and surfaces below as an error. */}
        <View className="mt-10 rounded-lg border border-destructive p-4">
          <Text className="text-base font-medium text-destructive">Delete account</Text>
          <Text className="mt-1 text-sm text-mutedForeground">
            Permanently deletes your business account and all of its data — customers, jobs,
            estimates, invoices, and messages. This cannot be undone.
          </Text>

          {!confirmingDelete ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Delete account"
              onPress={() => setConfirmingDelete(true)}
              className="mt-3 min-h-11 items-center justify-center rounded-md border border-destructive px-4 py-3"
            >
              <Text className="text-base font-semibold text-destructive">Delete account</Text>
            </Pressable>
          ) : (
            <View className="mt-3">
              <Text className="text-sm font-medium text-foreground">
                Are you sure? This is permanent.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Confirm delete account"
                disabled={deletePhase === 'deleting'}
                onPress={() => void onConfirmDelete()}
                className="mt-3 min-h-11 flex-row items-center justify-center rounded-md bg-destructive px-4 py-3"
              >
                {deletePhase === 'deleting' ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text className="text-base font-semibold text-destructiveForeground">
                    Yes, delete everything
                  </Text>
                )}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel delete account"
                disabled={deletePhase === 'deleting'}
                onPress={() => setConfirmingDelete(false)}
                className="mt-2 min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
              >
                <Text className="text-base text-foreground">Cancel</Text>
              </Pressable>
            </View>
          )}

          {deleteError ? (
            <Text className="mt-2 text-sm text-destructive">{deleteError}</Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
