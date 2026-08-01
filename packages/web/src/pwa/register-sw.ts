/**
 * R4 (native-mobile parity) — service worker registration.
 *
 * Registers /sw.js so Rivet is installable and opens offline. Deps are
 * injectable + the guard is a pure function so the policy is unit-testable
 * without a real browser. Registration is skipped in dev (the SW would cache
 * the Vite dev server and fight HMR) and where the API is unsupported.
 */
export interface RegisterEnv {
  /** import.meta.env.PROD — only register in production builds. */
  prod: boolean;
}

export interface RegisterDeps {
  navigator?: Pick<Navigator, 'serviceWorker'> | undefined;
  location?: Pick<Location, 'protocol' | 'hostname'>;
}

/**
 * Whether a service worker should be registered in this context. SW requires a
 * secure context (https) — except localhost, which browsers treat as secure for
 * dev/preview. Returns false in dev builds and where the API is absent.
 */
export function shouldRegisterServiceWorker(env: RegisterEnv, deps: RegisterDeps): boolean {
  if (!env.prod) return false;
  if (!deps.navigator || !('serviceWorker' in deps.navigator)) return false;
  const loc = deps.location;
  if (!loc) return false;
  const isLocalhost = loc.hostname === 'localhost' || loc.hostname === '127.0.0.1';
  return loc.protocol === 'https:' || isLocalhost;
}

export async function registerServiceWorker(
  env: RegisterEnv = { prod: import.meta.env.PROD },
  deps: RegisterDeps = {
    navigator: typeof navigator !== 'undefined' ? navigator : undefined,
    location: typeof location !== 'undefined' ? location : undefined,
  },
): Promise<ServiceWorkerRegistration | null> {
  if (!shouldRegisterServiceWorker(env, deps)) return null;
  try {
    // Non-null: shouldRegister guaranteed navigator.serviceWorker exists.
    const sw = (deps.navigator as Navigator).serviceWorker;
    return await sw.register('/sw.js', { scope: '/' });
  } catch {
    // A failed registration must never break app boot.
    return null;
  }
}
