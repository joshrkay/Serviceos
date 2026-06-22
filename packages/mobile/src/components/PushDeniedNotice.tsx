/**
 * "Turn on notifications" nudge.
 *
 * Push otherwise fails silently when the owner declined the permission prompt —
 * they just stop getting alerts and never learn why. When the root push
 * registration reports `'denied'`, this row appears on Settings (and Home) with
 * the fix. Renders nothing for any other status, so screens can mount it
 * unconditionally.
 */
import { Text, View } from 'react-native';
import { usePushStatus } from '../push/pushStatusContext';
import { PUSH_DENIED_COPY } from '../lib/errorCopy';

export function PushDeniedNotice({ className }: { className?: string }) {
  const status = usePushStatus();
  if (status !== 'denied') return null;

  return (
    <View
      className={`rounded-lg border border-border bg-accent p-4 ${className ?? ''}`}
      accessibilityRole="alert"
      accessibilityLabel={PUSH_DENIED_COPY.title}
    >
      <Text className="text-base font-medium text-accentForeground">{PUSH_DENIED_COPY.title}</Text>
      <Text className="mt-1 text-sm text-mutedForeground">{PUSH_DENIED_COPY.body}</Text>
    </View>
  );
}
