// k6 scenario: reconnect storm — 20k WS reconnects in 60s.
// Expects handshake throttling and stable memory/CPU.

import ws from 'k6/ws';
import { check } from 'k6';

export const options = {
  scenarios: {
    reconnect_storm: {
      executor: 'constant-arrival-rate',
      rate: 350,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 200,
      maxVUs: 1000,
    },
  },
  thresholds: {
    ws_session_duration: ['p(95)<5000'],
  },
};

const API_URL = (__ENV.API_URL as string) || 'ws://localhost:3000';
const TOKEN = (__ENV.CHAOS_ADMIN_TOKEN as string) || '';

export default function (): void {
  const url = `${API_URL.replace(/^http/, 'ws')}/api/ws?token=${TOKEN}`;
  const res = ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ kind: 'subscribe', channel: 'assistant' }));
      socket.setTimeout(() => socket.close(), 200);
    });
  });
  check(res, { 'accepted or 429': (r) => r && (r.status === 101 || r.status === 429) });
}
