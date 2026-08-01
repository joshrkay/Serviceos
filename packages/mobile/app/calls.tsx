import { useRouter } from 'expo-router';
import { EntityList } from '../src/components/EntityList';
import { useInteractionsList } from '../src/hooks/useInteractionsList';
import { formatShortDate } from '../src/lib/format';
import type { InteractionSummary } from '../src/api/interactions';

function channelLabel(channel: string): string {
  if (channel === 'voice_inbound') return 'Inbound call';
  if (channel === 'inapp_voice') return 'In-app voice';
  return channel;
}

function rowPrimary(interaction: InteractionSummary): string {
  return interaction.customer?.displayName ?? channelLabel(interaction.channel);
}

function rowSecondary(interaction: InteractionSummary): string | undefined {
  const parts: string[] = [];
  if (interaction.startedAt) parts.push(formatShortDate(interaction.startedAt));
  const excerpt = interaction.excerpt ?? interaction.outcome;
  if (excerpt) parts.push(excerpt);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export default function Calls() {
  const router = useRouter();
  const { data, isLoading, error, refetch } = useInteractionsList();

  return (
    <EntityList
      title="Calls"
      data={data}
      isLoading={isLoading}
      error={error}
      onRefresh={() => void refetch()}
      keyOf={(c) => c.id}
      renderRow={(c) => ({
        primary: rowPrimary(c),
        secondary: rowSecondary(c),
      })}
      onPressRow={(c) => router.push(`/calls/${c.id}`)}
      emptyText="No calls logged yet."
    />
  );
}
