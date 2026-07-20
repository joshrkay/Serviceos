// Resolve-time stub for `expo/fetch` under the jsdom/node test env. The
// streaming `expo/fetch` implementation is native-only (no jsdom-resolvable
// entry in the root-only CI lane); the assistant transport that uses it is
// device-only and excluded from unit coverage, so this only needs to be
// importable. Screen tests mock the session hook, so this body never runs.
export const fetch = async (): Promise<never> => {
  throw new Error('expo/fetch is native-only; not available under the test env');
};
