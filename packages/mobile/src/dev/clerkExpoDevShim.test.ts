import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** base64url JSON segment → object (what the API's decodeUnverified does). */
function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf-8'));
}

// #1603 — the app sandbox is a system boundary: the Maestro harness writes a
// dev-auth identity file there (over `adb run-as`) and the shim reads it.
const h = vi.hoisted(() => ({ getInfo: vi.fn(), read: vi.fn() }));
vi.mock('expo-file-system', () => ({
  documentDirectory: 'file:///data/user/0/com.serviceos.app/files/',
  getInfoAsync: h.getInfo,
  readAsStringAsync: h.read,
}));

type Shim = typeof import('./clerk-expo-dev-shim');
// vi.importActual (not a dynamic import expression): the mobile tsconfig has no
// `module` setting that allows `import()`, and resetModules makes each load
// re-evaluate the shim's module-level guard.
const loadShim = () => vi.importActual<Shim>('./clerk-expo-dev-shim');

beforeEach(() => {
  vi.clearAllMocks();
  h.getInfo.mockResolvedValue({ exists: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('clerk-expo dev shim — PRD 3.3 mobile dev-auth path', () => {
  it('signs the app in and hands the API an unsigned dev token carrying the owner sub', async () => {
    const shim = await loadShim();
    const auth = shim.useAuth();
    expect(auth.isLoaded).toBe(true);
    expect(auth.isSignedIn).toBe(true);

    // The app asks with the `serviceos` JWT template (useApiClient / useOfflineSync).
    const token = await auth.getToken({ template: 'serviceos', skipCache: true });
    const [header, payload, sig] = (token ?? '').split('.');
    expect(sig).toBeTruthy();
    expect(decodeSegment(header)).toEqual({ alg: 'none', typ: 'JWT' });
    // The claims packages/api/src/auth/dev-auth-bypass.ts reads: sub → tenant
    // bootstrap, sid, role → owner (same defaults as web's clerk-dev-shim).
    expect(decodeSegment(payload)).toEqual({ sub: 'dev_owner', sid: 'dev-session', role: 'owner' });
  });

  it('signs in as the identity the harness wrote to the app sandbox (dev-auth.json), so one bundle serves owner AND technician flows (#1603)', async () => {
    h.getInfo.mockResolvedValue({ exists: true });
    h.read.mockResolvedValue('{"sub":"dev_tech","role":"technician"}');
    const shim = await loadShim();

    const token = await shim.useAuth().getToken({ template: 'serviceos' });
    const [, payload] = (token ?? '').split('.');
    // The API's dev-auth bypass keys the tenant on `sub` and honours `role`, so
    // a distinct sub + technician role lands in a technician-owned dev tenant.
    expect(decodeSegment(payload)).toEqual({ sub: 'dev_tech', sid: 'dev-session', role: 'technician' });
    expect(h.read).toHaveBeenCalledWith('file:///data/user/0/com.serviceos.app/files/dev-auth.json');
  });

  it('refuses to load in a release bundle (__DEV__ === false), so it can never sign a production app in', async () => {
    vi.stubGlobal('__DEV__', false);
    await expect(loadShim()).rejects.toThrow(/refused in a release bundle/);
  });
});
