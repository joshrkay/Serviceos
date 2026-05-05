import { DEFAULT_API_REDACTION_POLICY, redactObject } from './redaction';

export function isSecretKey(key: string): boolean {
  return DEFAULT_API_REDACTION_POLICY.sensitiveKeyPatterns.some((re) => re.test(key));
}

export function redactSecrets<T>(input: T): T {
  return redactObject(input, DEFAULT_API_REDACTION_POLICY);
}
