export type SendgridProvisionSuccess = {
  ok: true;
  apiKeyId: string;
  secretRef: string;
};

export type SendgridProvisionFailure = {
  ok: false;
  error: {
    code: 'SENDGRID_ENCRYPTION_FAILED' | 'SENDGRID_STORAGE_FAILED';
    message: string;
    details?: Record<string, unknown>;
  };
};

export type SendgridProvisionResult = SendgridProvisionSuccess | SendgridProvisionFailure;

type ProvisionDeps = {
  encryptApiKey: (rawApiKey: string) => Promise<{ ciphertext: string; keyId: string }>;
  storeSecret: (payload: { ciphertext: string; keyId: string }) => Promise<{ secretRef: string }>;
};

const SENSITIVE_FIELD_NAMES = new Set(['apiKey', 'rawApiKey', 'token', 'authorization', 'secret']);

export function redactSensitiveFields<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = SENSITIVE_FIELD_NAMES.has(key) ? '[REDACTED]' : value;
  }
  return out as T;
}

function sanitizeText(value: string, secrets: readonly string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

function sanitizeDetails(details: Record<string, unknown>, secrets: readonly string[]): Record<string, unknown> {
  const redacted = redactSensitiveFields(details);
  return Object.fromEntries(
    Object.entries(redacted).map(([key, value]) => {
      if (typeof value === 'string') {
        return [key, sanitizeText(value, secrets)];
      }
      return [key, value];
    }),
  );
}

export async function provisionSendgridApiKey(
  apiKeyId: string,
  rawApiKey: string,
  deps: ProvisionDeps,
): Promise<SendgridProvisionResult> {
  try {
    const encrypted = await deps.encryptApiKey(rawApiKey);
    try {
      const stored = await deps.storeSecret(encrypted);
      return {
        ok: true,
        apiKeyId,
        secretRef: stored.secretRef,
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'SENDGRID_STORAGE_FAILED',
          message: 'Failed to persist encrypted SendGrid API key',
          details: sanitizeDetails(
            {
            apiKeyId,
            rawApiKey,
            reason: error instanceof Error ? error.message : String(error),
            },
            [rawApiKey],
          ),
        },
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'SENDGRID_ENCRYPTION_FAILED',
        message: 'Failed to encrypt SendGrid API key',
        details: sanitizeDetails(
          {
            apiKeyId,
            rawApiKey,
            reason: error instanceof Error ? error.message : String(error),
          },
          [rawApiKey],
        ),
      },
    };
  }
}
