import { Tabs } from 'expo-router';
import { Text, View } from 'react-native';
import { VoiceOverlay } from '../../src/components/VoiceOverlay';
import { usePendingProposals } from '../../src/hooks/usePendingProposals';

function TabIcon({ label, badge }: { label: string; badge?: number }) {
  return (
    <View className="items-center">
      <Text className="text-xs text-foreground">{label}</Text>
      {badge && badge > 0 ? (
        <View className="absolute -right-2 -top-1 h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1">
          <Text className="text-[10px] font-semibold text-destructiveForeground">
            {badge > 9 ? '9+' : badge}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export default function TabLayout() {
  const { count } = usePendingProposals();

  return (
    <View className="flex-1">
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: '#1F5FD6',
          tabBarInactiveTintColor: '#5B6675',
          tabBarStyle: {
            backgroundColor: '#FFFFFF',
            borderTopColor: '#ECE8E0',
            height: 64,
            paddingBottom: 8,
            paddingTop: 8,
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Home',
            tabBarIcon: () => <TabIcon label="Home" badge={count} />,
          }}
        />
        <Tabs.Screen
          name="voice"
          options={{
            title: 'Assistant',
            tabBarIcon: () => <TabIcon label="Assistant" />,
          }}
        />
        <Tabs.Screen
          name="customers"
          options={{
            title: 'Customers',
            tabBarIcon: () => <TabIcon label="Customers" />,
          }}
        />
        <Tabs.Screen
          name="jobs"
          options={{
            title: 'Jobs',
            tabBarIcon: () => <TabIcon label="Jobs" />,
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: 'Settings',
            tabBarIcon: () => <TabIcon label="Settings" />,
          }}
        />
      </Tabs>
      <VoiceOverlay />
    </View>
  );
}
