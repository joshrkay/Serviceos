/**
 * Push registration + tap handling (mobile).
 *
 * Orchestration over injected ports so it is testable without the native
 * FirebaseMessaging plugin:
 *   - register(): request permission → obtain the unified FCM token → POST
 *     /api/devices (only after login, since tokens are tenant/user-scoped
 *     server-side).
 *   - handleNotificationTap(): route a notification's deep-link payload
 *     through the deep-link parser → navigate.
 *   - unregister(): DELETE the token on logout so a device that switches
 *     tenants stops receiving the prior tenant's pushes.
 *
 * No-op on web (the native wiring only constructs this under isNativePlatform).
 */
export interface PushPorts {
  requestPermission: () => Promise<boolean>;
  /** Unified FCM token (via @capacitor-firebase/messaging on native). */
  getToken: () => Promise<string | null>;
  platform: () => 'ios' | 'android';
  /** POST /api/devices. */
  registerToken: (platform: 'ios' | 'android', token: string) => Promise<void>;
  /** DELETE /api/devices/:token. */
  unregisterToken: (token: string) => Promise<void>;
  /** Parse a deep-link URL to an in-app path (bind deepLinks.parseDeepLink). */
  parseLink: (url: string) => string | null;
  navigate: (path: string) => void;
}

export interface RegisterResult {
  registered: boolean;
  token: string | null;
}

export interface PushClient {
  register(): Promise<RegisterResult>;
  handleNotificationTap(data: Record<string, string> | undefined): void;
  unregister(): Promise<void>;
}

export function createPushClient(ports: PushPorts): PushClient {
  let registeredToken: string | null = null;

  return {
    async register(): Promise<RegisterResult> {
      const granted = await ports.requestPermission();
      if (!granted) return { registered: false, token: null };

      const token = await ports.getToken();
      if (!token) return { registered: false, token: null };

      try {
        await ports.registerToken(ports.platform(), token);
        registeredToken = token;
        return { registered: true, token };
      } catch {
        // Registration POST failed (offline / transient). The app continues;
        // the native wiring re-registers on next login or enqueues the POST.
        return { registered: false, token };
      }
    },

    handleNotificationTap(data: Record<string, string> | undefined): void {
      if (!data) return;
      // Payload may carry a full link (universal/custom-scheme) or a bare path.
      if (data.link) {
        const path = ports.parseLink(data.link);
        if (path) ports.navigate(path);
        return;
      }
      if (data.path && data.path.startsWith('/')) {
        ports.navigate(data.path);
      }
    },

    async unregister(): Promise<void> {
      if (!registeredToken) return;
      const token = registeredToken;
      registeredToken = null;
      await ports.unregisterToken(token);
    },
  };
}
