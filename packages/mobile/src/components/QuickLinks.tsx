import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import type { PersonaQuickLink } from '../navigation/personaNav';

/**
 * The persona's quick-link grid (Home; and Today for personas without a Home
 * tab — #1603). One component so the 44px tap-target contract and the layout
 * are pinned once for both screens.
 */
export function QuickLinks({ links }: { links: readonly PersonaQuickLink[] }) {
  const router = useRouter();
  return (
    <>
      <Text className="mb-2 mt-7 text-xs font-medium uppercase tracking-wide text-mutedForeground">
        Quick links
      </Text>
      <View className="w-full max-w-full flex-row flex-wrap justify-between">
        {links.map((link) => (
          <Pressable
            key={link.label}
            accessibilityRole="button"
            accessibilityLabel={link.label}
            onPress={() => router.push(link.route)}
            className="mb-3 min-h-11 min-w-0 items-center justify-center rounded-md border border-border bg-card px-3 py-3"
            style={{ width: '47%' }}
          >
            <Text className="text-base text-foreground">{link.label}</Text>
          </Pressable>
        ))}
      </View>
    </>
  );
}
