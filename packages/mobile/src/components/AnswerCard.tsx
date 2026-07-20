import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type {
  VoiceAnswerEntityKind,
  VoiceAnswerRow,
  VoiceLookupAnswer,
} from '@ai-service-os/shared';
import { formatMoneyCents } from '../lib/format';
import { LabelValueTable, type LabelValueRow } from './LabelValueTable';

/**
 * U3 — E-lane answer card: renders a spoken read-only ask's answer inline
 * on the capture screen (summary + structured rows + a deep link to the
 * obvious read screen). Money rows arrive as INTEGER CENTS and format
 * client-side via the canonical formatter — never pre-formatted strings.
 */

/** Flatten typed answer rows into LabelValueTable rows (money via cents). */
export function answerRowsToLabelValues(rows: VoiceAnswerRow[]): LabelValueRow[] {
  return rows.map((row) => {
    switch (row.kind) {
      case 'money':
        return { label: row.label, value: formatMoneyCents(row.amountCents) };
      case 'count':
        return { label: row.label, value: row.count.toLocaleString('en-US') };
      case 'text':
      default:
        return { label: row.label, value: row.text };
    }
  });
}

/**
 * The CLIENT owns entity-kind → screen mapping (the server never emits
 * routes). Agreements land on customer detail until the dedicated
 * agreements screen exists (U10) — the server already refs 'customer'
 * for those, but 'agreement' maps there too as a belt-and-braces.
 */
export function answerDeepLink(
  answer: VoiceLookupAnswer,
): { href: string; label: string } | null {
  const ref = answer.entityRef;
  if (!ref) return null;
  const routes: Record<VoiceAnswerEntityKind, { list: string; detail?: (id: string) => string; label: string }> = {
    customer: { list: '/customers', detail: (id) => `/customers/${id}`, label: 'View customer' },
    invoice: { list: '/invoices', detail: (id) => `/invoices/${id}`, label: 'View invoices' },
    estimate: { list: '/estimates', detail: (id) => `/estimates/${id}`, label: 'View estimates' },
    job: { list: '/jobs', detail: (id) => `/jobs/${id}`, label: 'View job' },
    agreement: { list: '/customers', detail: (id) => `/customers/${id}`, label: 'View customer' },
    appointment: { list: '/schedule', label: 'Open schedule' },
  };
  const route = routes[ref.kind];
  if (!route) return null;
  const href = ref.id && route.detail ? route.detail(ref.id) : route.list;
  return { href, label: route.label };
}

export interface AnswerCardProps {
  answer: VoiceLookupAnswer;
}

export function AnswerCard({ answer }: AnswerCardProps) {
  const router = useRouter();
  const rows = answerRowsToLabelValues(answer.rows);
  const link = answer.result === 'found' ? answerDeepLink(answer) : null;

  return (
    <View className="w-full rounded-lg border border-border bg-card p-4">
      <Text className="text-base text-mutedForeground">
        {answer.result === 'refused' ? 'Not available' : 'Answer'}
      </Text>
      <Text className="mt-1 text-lg text-foreground">{answer.summary}</Text>
      {rows.length > 0 ? (
        <View className="mt-4">
          <LabelValueTable rows={rows} />
        </View>
      ) : null}
      {link ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push(link.href)}
          className="mt-4 min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
        >
          <Text className="text-base font-semibold text-primaryForeground">{link.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
