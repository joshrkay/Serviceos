import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useApiClient } from '../../../src/lib/useApiClient';
import { useSignOut } from '../../../src/push/useSignOut';

/** Map a DELETE /api/users/me failure to owner-friendly copy. */
function deleteErrorMessage(status: number, serverMessage?: string): string {
  if (status === 409) {
    return (
      serverMessage ??
      'You are the only owner. Transfer ownership to a teammate first, or contact support to close the whole workspace.'
    );
  }
  return 'Could not delete your account right now. Please try again.';
}

/**
 * Guideline 5.1.1(v) — in-app account deletion. Two-step, fully in-app:
 * an explicit warning, then a typed-out destructive confirmation button.
 * On success the account is deleted server-side (Clerk + soft-delete) and
 * we sign out locally, landing back on the sign-in screen.
 */
export default function DeleteAccount() {
  const api = useApiClient();
  const signOut = useSignOut();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onDelete = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api('/api/users/me', { method: 'DELETE' });
      if (!res.ok) {
        let serverMessage: string | undefined;
        try {
          const body = (await res.json()) as { message?: string };
          serverMessage = body.message;
        } catch {
          // Non-JSON error body — fall through to the generic copy.
        }
        setError(deleteErrorMessage(res.status, serverMessage));
        return;
      }
      // Account is gone server-side; clear the local session. Sign-out
      // failures are irrelevant at this point — the token is already dead.
      try {
        await signOut();
      } catch {
        // Ignore — Clerk already invalidated the session server-side.
      }
      router.replace('/sign-in');
    } catch {
      setError('Could not delete your account right now. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingTop: 64, paddingBottom: 96 }}
    >
      <View className="px-6">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to Settings"
          onPress={() => router.back()}
          className="min-h-11 justify-center"
        >
          <Text className="text-sm text-primary">← Settings</Text>
        </Pressable>

        <Text className="mt-2 font-heading text-2xl font-semibold text-foreground">
          Delete account
        </Text>
        <Text className="mt-3 text-base text-mutedForeground">
          Deleting your account permanently signs you out everywhere and removes
          your access to this workspace. This cannot be undone.
        </Text>
        <Text className="mt-3 text-base text-mutedForeground">
          Business records you created (jobs, invoices, messages) stay with the
          workspace for bookkeeping and audit purposes.
        </Text>
        <Text className="mt-3 text-base text-mutedForeground">
          If you are the only owner, transfer ownership to a teammate first, or
          contact support to close the whole workspace.
        </Text>

        {error ? (
          <View
            className="mt-6 rounded-lg border border-border bg-accent p-4"
            accessibilityRole="alert"
          >
            <Text className="text-base text-destructive">{error}</Text>
          </View>
        ) : null}

        {!confirming ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delete my account"
            onPress={() => setConfirming(true)}
            className="mt-8 min-h-11 items-center justify-center rounded-md border border-destructive px-4 py-3"
          >
            <Text className="text-base font-semibold text-destructive">Delete my account</Text>
          </Pressable>
        ) : (
          <View className="mt-8">
            <Text className="text-base font-medium text-foreground">
              Are you sure? This is permanent.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Yes, permanently delete my account"
              onPress={() => void onDelete()}
              disabled={busy}
              className="mt-3 min-h-11 items-center justify-center rounded-md bg-destructive px-4 py-3"
            >
              {busy ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text className="text-base font-semibold text-destructiveForeground">
                  Yes, permanently delete my account
                </Text>
              )}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={() => setConfirming(false)}
              disabled={busy}
              className="mt-3 min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
            >
              <Text className="text-base text-foreground">Cancel</Text>
            </Pressable>
          </View>
        )}
      </View>
    </ScrollView>
  );
}
