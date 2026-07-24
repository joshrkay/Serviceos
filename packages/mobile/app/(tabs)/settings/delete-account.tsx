import { useAuth } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useApiClient } from '../../../src/lib/useApiClient';

/**
 * Map a DELETE /api/users/me failure to owner-friendly copy. The server's
 * message is authoritative when present — for the unconfirmable-deletion
 * 502 it carries the ONLY recovery instruction (contact support; a retry
 * cannot work because the deactivated membership is rejected at auth).
 */
function deleteErrorMessage(status: number, serverMessage?: string): string {
  if (serverMessage) return serverMessage;
  if (status === 409) {
    return 'You are the only owner. Transfer ownership to a teammate first, or contact support to close the whole workspace.';
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
  // Clerk's signOut directly — NOT useSignOut: that helper first sends an
  // authenticated DELETE /api/devices, which the now-deactivated membership
  // can only 401, flashing the session-expired toast/redirect over the
  // deletion outcome. The server already purged the push tokens.
  const { signOut } = useAuth();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Deletion succeeded server-side but Clerk sign-out failed (e.g. offline).
  // Navigating to /sign-in would bounce straight back: the root layout
  // redirects any signed-in session out of the auth group, trapping the
  // user in-app with a dead account. Show a terminal instruction instead.
  const [signOutStuck, setSignOutStuck] = useState(false);

  // Clear the LOCAL session and leave. Must actually succeed before
  // navigating — with the cached session still active, /sign-in bounces
  // back into the app (root-layout auth gate).
  const completeSignOut = async () => {
    let signedOut = false;
    for (let attempt = 0; attempt < 2 && !signedOut; attempt += 1) {
      try {
        await signOut();
        signedOut = true;
      } catch {
        // Retry once — transient network blips are the common cause.
      }
    }
    if (!signedOut) {
      setSignOutStuck(true);
      return;
    }
    router.replace('/sign-in');
  };

  const onDelete = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api('/api/users/me', { method: 'DELETE' });
      if (!res.ok) {
        // A 401/403 here means the membership is ALREADY deactivated — the
        // classic case is a retry after a first attempt whose success
        // response was lost. Offering another retry would trap the user
        // (every authed call 401s, the cached session bounces /sign-in
        // back into the app) — finish the local sign-out instead.
        if (res.status === 401 || res.status === 403) {
          await completeSignOut();
          return;
        }
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
      await completeSignOut();
    } catch {
      // Transport error — the DELETE may have reached the API and
      // deactivated the account even though the response was lost.
      // Reconcile before advertising a retry that could only 401.
      try {
        const probe = await api('/api/me');
        // ONLY an authentication rejection confirms the deletion landed —
        // a 429/5xx probe is the server having a bad moment, not evidence
        // the account is gone, and must keep the retry flow.
        if (probe.status === 401 || probe.status === 403) {
          await completeSignOut();
          return;
        }
      } catch {
        // Still unreachable — genuinely ambiguous; the retry copy below is
        // safe because a retry after a landed deletion hits the 401 branch
        // above and transitions into sign-out.
      }
      setError('Could not delete your account right now. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const onRetrySignOut = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await signOut();
      router.replace('/sign-in');
    } catch {
      // Still stuck — keep showing the instruction.
    } finally {
      setBusy(false);
    }
  };

  if (signOutStuck) {
    return (
      <ScrollView
        className="flex-1 bg-background"
        contentContainerStyle={{ paddingTop: 64, paddingBottom: 96 }}
      >
        <View className="px-6">
          <Text className="font-heading text-2xl font-semibold text-foreground">
            Account deleted
          </Text>
          <Text className="mt-3 text-base text-mutedForeground">
            Your account was deleted, but we couldn&apos;t finish signing this
            device out — you may be offline. Please close and reopen the app,
            or try again below.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try signing out again"
            onPress={() => void onRetrySignOut()}
            disabled={busy}
            className="mt-8 min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
          >
            {busy ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text className="text-base font-semibold text-primaryForeground">
                Try signing out again
              </Text>
            )}
          </Pressable>
        </View>
      </ScrollView>
    );
  }

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
