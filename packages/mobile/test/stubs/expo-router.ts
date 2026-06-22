// Resolve-time stub for expo-router under the jsdom test env (mobile-only dep,
// no root-only-lane resolution). Screen tests override useRouter via vi.mock to
// assert navigation; this default keeps imports resolvable.
export const useRouter = () => ({
  push: () => {},
  back: () => {},
  replace: () => {},
});
