import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { typeLabel } from '../proposals/proposalReview';

export interface ProposalCardItem {
  id: string;
  summary: string;
  proposalType: string;
  confidenceScore?: number;
}

export interface ProposalCardProps {
  proposal: ProposalCardItem;
}

/** Rich proposal row for the approvals inbox — confidence + type + summary. */
export function ProposalCard({ proposal }: ProposalCardProps) {
  const router = useRouter();
  const confidencePct = Math.round((proposal.confidenceScore ?? 0.75) * 100);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Review ${typeLabel(proposal.proposalType)}: ${proposal.summary}`}
      onPress={() => router.push(`/proposals/${proposal.id}`)}
      className="mb-3 min-h-11 rounded-lg border border-border bg-card p-4"
    >
      <View className="flex-row items-center justify-between">
        <Text className="text-sm font-medium uppercase tracking-wide text-mutedForeground">
          {typeLabel(proposal.proposalType)}
        </Text>
        <Text className="text-sm text-mutedForeground">{confidencePct}% sure</Text>
      </View>
      <Text className="mt-1 text-base text-foreground">{proposal.summary}</Text>
      <View className="mt-3 h-2 overflow-hidden rounded-full bg-secondary">
        <View className="h-full rounded-full bg-primary" style={{ width: `${confidencePct}%` }} />
      </View>
    </Pressable>
  );
}
