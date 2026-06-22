// Resolve-time stub for @clerk/clerk-expo. Mobile-only dep with no
// jsdom-resolvable entry in the root-only CI lane; mocked per test via vi.mock,
// so this body never runs. See ./expo-audio.ts for the rationale.
export const useAuth = () => ({ userId: null as string | null, orgId: null as string | null });
