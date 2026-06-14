import { ValidationError } from '../../shared/errors';
import { decrypt, encrypt } from '../crypto';

const ENCRYPTION_KEY_VAR = 'TENANT_ENCRYPTION_KEY';

function getKey(): string {
  const key = process.env[ENCRYPTION_KEY_VAR];
  if (!key) {
    throw new ValidationError(
      `${ENCRYPTION_KEY_VAR} env var is required for accounting token storage`,
    );
  }
  return key;
}

/** Dev-only marker when encryption key is absent in tests. Never persisted in prod. */
export function encryptAccountingToken(token: string): string {
  return encrypt(token, getKey());
}

export function decryptAccountingToken(ciphertext: string): string {
  return decrypt(ciphertext, getKey());
}
