/**
 * bench:latency — voice-parity latency gate (Features 1 and 2).
 *
 * Measures the server-controllable portions of the two headline competitive
 * metrics and fails (exit 1) if either budget is breached:
 *   - pickup p95 < 2000ms   (inbound → first greeting utterance assembly)
 *   - emergency handoff p95 < 5000ms (intent detected → dial decision +
 *     dispatcher context ready)
 *
 * Out-of-process costs (network transit, ElevenLabs/Twilio TTS synthesis) are
 * NOT included here; they are measured in staging load tests. This gate exists
 * to catch regressions in the code path we own. Deterministic, no I/O.
 */
import { buildTelephonyGreeting } from '../src/telephony/twilio-adapter';
import { shouldImmediatelyDialOnEmergency } from '../src/ai/skills/escalate-to-human';
import { buildEscalationSummary } from '../src/ai/agents/customer-calling/escalation-summary-builder';
import { summarize, type LatencyStats } from '../src/voice/parity/latency';

const PICKUP_BUDGET_MS = 2000;
const EMERGENCY_BUDGET_MS = 5000;
const N = 1000;

function clock(): number {
  return globalThis.performance ? globalThis.performance.now() : Date.now();
}

function benchPickup(): LatencyStats {
  const samples: number[] = [];
  const persona = { agentName: 'Alex' };
  const disclosure = 'This call may be recorded for quality.';
  for (let i = 0; i < N; i++) {
    const lang = i % 2 === 0 ? 'en' : 'es';
    const start = clock();
    buildTelephonyGreeting('Acme Plumbing', disclosure, persona, lang);
    samples.push(clock() - start);
  }
  return summarize(samples);
}

function benchEmergency(): LatencyStats {
  const samples: number[] = [];
  for (let i = 0; i < N; i++) {
    const start = clock();
    shouldImmediatelyDialOnEmergency({
      intent: 'emergency_dispatch',
      supervisorPresent: false,
      channel: 'telephony',
    });
    buildEscalationSummary({
      shopName: 'Acme Plumbing',
      tenantTimezone: 'America/New_York',
      caller: { phone: '+15125550142', name: 'Caller' },
      intent: { type: 'emergency_dispatch', entities: {}, confidence: 0.97 },
      reason: 'emergency_dispatch',
      transcriptSnapshot: [{ role: 'caller', text: 'I smell gas in the kitchen', ts: 0 }],
    });
    samples.push(clock() - start);
  }
  return summarize(samples);
}

function row(label: string, s: LatencyStats): string {
  const f = (n: number) => n.toFixed(3).padStart(9);
  return `${label.padEnd(20)} n=${s.count} p50=${f(s.p50)} p95=${f(s.p95)} p99=${f(s.p99)} max=${f(s.max)}`;
}

function main(): void {
  const pickup = benchPickup();
  const emergency = benchEmergency();
  process.stdout.write(`${row('pickup (ms)', pickup)}\n`);
  process.stdout.write(`${row('emergency (ms)', emergency)}\n`);

  const failures: string[] = [];
  if (pickup.p95 >= PICKUP_BUDGET_MS) failures.push(`pickup p95 ${pickup.p95.toFixed(2)}ms >= ${PICKUP_BUDGET_MS}ms`);
  if (emergency.p95 >= EMERGENCY_BUDGET_MS) failures.push(`emergency p95 ${emergency.p95.toFixed(2)}ms >= ${EMERGENCY_BUDGET_MS}ms`);

  if (failures.length > 0) {
    process.stderr.write(`FAIL: ${failures.join('; ')}\n`);
    process.exit(1);
  }
  process.stdout.write('PASS: pickup p95 < 2000ms, emergency handoff p95 < 5000ms\n');
}

main();
