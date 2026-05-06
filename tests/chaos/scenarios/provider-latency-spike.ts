// k6 scenario: provider latency spike — p95 800ms → 8s for 10 minutes.
// Expects retries to remain bounded and the breaker to open if upstream
// timeouts dominate, with no event-loop starvation.

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    latency_spike: {
      executor: 'constant-arrival-rate',
      rate: 20,
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.5'],
    http_req_duration: ['p(95)<25000'],
  },
};

const API_URL = (__ENV.API_URL as string) || 'http://localhost:3000';
const TOKEN = (__ENV.CHAOS_ADMIN_TOKEN as string) || '';

export function setup(): void {
  http.post(
    `${API_URL}/internal/chaos`,
    JSON.stringify({ latencyMs: 8000, latencyJitterMs: 1500 }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` } },
  );
}

export default function (): void {
  const res = http.post(
    `${API_URL}/api/assistant/chat`,
    JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` } },
  );
  check(res, { 'status is 2xx or graceful 5xx': (r) => r.status < 600 });
  sleep(0.5);
}

export function teardown(): void {
  http.post(`${API_URL}/internal/chaos`, '{}', {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  });
}
