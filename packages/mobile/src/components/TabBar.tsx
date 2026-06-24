import { Pressable, Text, View } from 'react-native';
import { type Href, usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// The five primary destinations from the prototype's shared bottom nav
// (designs/Nav.dc.html): Home · Assistant · Customers · Jobs · Settings.
// Rendered once in the app shell (AppChrome) so every primary screen shares it,
// rather than a per-screen control. Colors come from semantic tokens, so the
// bar adopts the brand automatically when the Path A token values land.
interface Tab {
  label: string;
  route: Href;
  /** Path prefix that marks this tab active. */
  match: string;
}

const TABS: Tab[] = [
  { label: 'Home', route: '/', match: '/' },
  { label: 'Assistant', route: '/voice', match: '/voice' },
  { label: 'Customers', route: '/customers', match: '/customers' },
  { label: 'Jobs', route: '/jobs', match: '/jobs' },
  { label: 'Settings', route: '/settings', match: '/settings' },
];

/** A tab is active on its own route and any nested detail route beneath it.
 *  Home (`/`) matches only the exact root so it isn't active everywhere. */
export function isTabActive(pathname: string, match: string): boolean {
  if (match === '/') return pathname === '/';
  return pathname === match || pathname.startsWith(`${match}/`);
}

export function TabBar() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();

  return (
    <View
      className="flex-row border-t border-border bg-card"
      // Clear the home indicator on devices that have one; keep a min on the rest.
      style={{ paddingBottom: Math.max(insets.bottom, 8) }}
    >
      {TABS.map((tab) => {
        const active = isTabActive(pathname, tab.match);
        return (
          <Pressable
            key={tab.label}
            accessibilityRole="button"
            accessibilityLabel={tab.label}
            // `navigate` (not `push`) so re-tapping a tab doesn't stack
            // duplicate routes.
            onPress={() => router.navigate(tab.route)}
            className="min-h-11 flex-1 items-center justify-center px-1 py-2"
          >
            <Text
              className={`text-xs ${
                active ? 'font-semibold text-primary' : 'text-mutedForeground'
              }`}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
