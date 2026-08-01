import { Text, View } from 'react-native';
import type { SavePhase } from '../hooks/useSavePhase';
import { PrimaryButton } from './Buttons';

export interface SavePhaseButtonProps {
  phase: SavePhase;
  error?: string | null;
  idleLabel: string;
  savingLabel: string;
  savedLabel: string;
  onPress: () => void;
  disabled?: boolean;
}

export function SavePhaseButton({
  phase,
  error,
  idleLabel,
  savingLabel,
  savedLabel,
  onPress,
  disabled,
}: SavePhaseButtonProps) {
  const label =
    phase === 'saving' ? savingLabel : phase === 'saved' ? savedLabel : idleLabel;

  return (
    <View>
      <PrimaryButton
        label={label}
        loading={phase === 'saving'}
        disabled={disabled || phase === 'saved'}
        onPress={onPress}
      />
      {phase === 'saved' ? (
        <Text className="mt-2 text-sm text-success">{savedLabel}</Text>
      ) : null}
      {phase === 'error' && error ? (
        <Text className="mt-2 text-sm text-destructive">{error}</Text>
      ) : null}
    </View>
  );
}
