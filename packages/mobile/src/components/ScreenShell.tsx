import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, Text, View, type ScrollViewProps } from 'react-native';

export interface ScreenShellProps {
  title: string;
  backLabel?: string;
  showBack?: boolean;
  subtitle?: string;
  headerRight?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
  contentClassName?: string;
  contentContainerStyle?: ScrollViewProps['contentContainerStyle'];
}

/** Shared screen chrome: optional back, title, scroll body with tab-bar clearance. */
export function ScreenShell({
  title,
  backLabel = '‹ Back',
  showBack = true,
  subtitle,
  headerRight,
  children,
  scroll = true,
  contentClassName = 'pb-20',
  contentContainerStyle,
}: ScreenShellProps) {
  const router = useRouter();
  const padding = {
    paddingHorizontal: 24,
    paddingTop: 64,
    paddingBottom: 48,
  } satisfies NonNullable<ScrollViewProps['contentContainerStyle']>;

  const header = (
    <View className="px-6">
      {showBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          className="min-h-11 justify-center"
        >
          <Text className="text-base text-mutedForeground">{backLabel}</Text>
        </Pressable>
      ) : null}
      <View className="mt-2 flex-row items-start justify-between">
        <View className="flex-1 pr-3">
          <Text className="font-heading text-2xl font-semibold text-foreground">{title}</Text>
          {subtitle ? <Text className="mt-1 text-base text-mutedForeground">{subtitle}</Text> : null}
        </View>
        {headerRight}
      </View>
    </View>
  );

  if (!scroll) {
    return (
      <View className={`flex-1 bg-background ${contentClassName}`}>
        {header}
        <View className="flex-1 px-6">{children}</View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      {header}
      <ScrollView className={contentClassName} contentContainerStyle={contentContainerStyle ?? padding}>
        {children}
      </ScrollView>
    </View>
  );
}
