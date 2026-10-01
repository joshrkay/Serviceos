import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Metro bundle must build. Maestro device run 36765536371 (2026-09-30)
 * never reached a screen: Metro answered every bundle request with
 * `Cannot find module 'react-native-worklets/plugin'`.
 *
 * babel.config.js loads `nativewind/babel`, which is react-native-css-interop's
 * Babel preset. From css-interop 0.2.0 that preset lists
 * "react-native-worklets/plugin" (Reanimated 4's plugin); 0.1.x lists
 * "react-native-reanimated/plugin" (Reanimated 3's). This app is Expo SDK 52 on
 * Reanimated 3, so the installed css-interop must be 0.1.x — or the worklets
 * package must be present. Read from the lockfile the CI install uses, since
 * this lane runs without the mobile node_modules.
 */
const LOCK = path.resolve(__dirname, '../../package-lock.json');

function installed(lock: { packages: Record<string, { version?: string }> }, name: string) {
  return lock.packages[`node_modules/${name}`]?.version;
}

describe('mobile Babel toolchain — every plugin the NativeWind preset names is installable', () => {
  it('pairs react-native-css-interop with the Reanimated generation it was built for', () => {
    const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
    const interop = installed(lock, 'react-native-css-interop');
    const reanimated = installed(lock, 'react-native-reanimated');
    const worklets = installed(lock, 'react-native-worklets');
    expect(interop, 'react-native-css-interop in the lockfile').toBeTruthy();
    expect(reanimated, 'react-native-reanimated in the lockfile').toBeTruthy();

    const [interopMajor, interopMinor] = (interop as string).split('.').map(Number);
    const presetNeedsWorklets = interopMajor > 0 || interopMinor >= 2;
    if (presetNeedsWorklets) {
      expect(
        worklets,
        `react-native-css-interop ${interop} names react-native-worklets/plugin, which is not installed (Reanimated ${reanimated})`,
      ).toBeTruthy();
    } else {
      expect(Number((reanimated as string).split('.')[0])).toBeLessThan(4);
    }
  });
});
