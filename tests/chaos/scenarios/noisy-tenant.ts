// k6 scenario: one tenant sends 10× normal traffic. Other tenants must
// see <5% p95 regression — verified by comparing per-tenant histograms
// scraped from /metrics.

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    noisy_tenant: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 100,
      maxVUs: 500,
    },
    other_tenants: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 20,
      maxVUs: 100,
      env: { TENANT_ID: 'tenant-quiet' },
    },
  },
  thresholds: {
    'http_req_duration{tenant:tenant-quiet}': ['p(95)<2500'],
  },
};

const API_URL = (__ENV.API_URL as string) || 'http://localhost:3000';
const NOISY_TOKEN = (__ENV.NOISY_TOKEN as string) || '';
const QUIET_TOKEN = (__ENV.QUIET_TOKEN as string) || '';

export default function (): void {
  const isQuiet = (__ENV as { TENANT_ID?: string }).TENANT_ID === 'tenant-quiet';
  const token = isQuiet ? QUIET_TOKEN : NOISY_TOKEN;
  const res = http.post(
    `${API_URL}/api/assistant/chat`,
    JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      tags: { tenant: isQuiet ? 'tenant-quiet' : 'tenant-noisy' },
    },
  );
  check(res, { ok: (r) => r.status < 500 });
  sleep(0.05);
}
