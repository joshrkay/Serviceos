import { ActivityIndicator, Pressable, Text, type PressableProps } from 'react-native';

type ButtonProps = PressableProps & {
  label: string;
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'destructive';
};

const variantClass: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'bg-primary',
  secondary: 'border border-border bg-transparent',
  destructive: 'bg-destructive',
};

const labelClass: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'text-primaryForeground',
  secondary: 'text-foreground',
  destructive: 'text-destructiveForeground',
};

export function PrimaryButton({ label, loading, disabled, className, ...rest }: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      className={`min-h-11 items-center justify-center rounded-md px-4 py-3 ${variantClass.primary} ${className ?? ''}`}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator color="#ffffff" />
      ) : (
        <Text className={`text-base font-semibold ${labelClass.primary}`}>{label}</Text>
      )}
    </Pressable>
  );
}

export function SecondaryButton({ label, loading, disabled, className, ...rest }: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      className={`min-h-11 items-center justify-center rounded-md px-4 py-3 ${variantClass.secondary} ${className ?? ''}`}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator />
      ) : (
        <Text className={`text-base font-semibold ${labelClass.secondary}`}>{label}</Text>
      )}
    </Pressable>
  );
}

export function DestructiveButton({ label, loading, disabled, className, ...rest }: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      className={`min-h-11 items-center justify-center rounded-md px-4 py-3 ${variantClass.destructive} ${className ?? ''}`}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator color="#ffffff" />
      ) : (
        <Text className={`text-base font-semibold ${labelClass.destructive}`}>{label}</Text>
      )}
    </Pressable>
  );
}
