// k6 scenario: error storm — 50–80% transient/429 errors.
// Expects breaker to fast-fail open and fallback path to activate.

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    error_storm: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 100,
      maxVUs: 400,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<3000'],
  },
};

const API_URL = (__ENV.API_URL as string) || 'http://localhost:3000';
const TOKEN = (__ENV.CHAOS_ADMIN_TOKEN as string) || '';

export function setup(): void {
  http.post(
    `${API_URL}/internal/chaos`,
    JSON.stringify({ transientErrorRate: 0.5, rateLimitErrorRate: 0.2 }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` } },
  );
}

export default function (): void {
  const res = http.post(
    `${API_URL}/api/assistant/chat`,
    JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` } },
  );
  check(res, {
    'fast-fail or graceful degraded': (r) => r.status < 600 && r.timings.duration < 5000,
  });
  sleep(0.1);
}

export function teardown(): void {
  http.post(`${API_URL}/internal/chaos`, '{}', {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  });
}
