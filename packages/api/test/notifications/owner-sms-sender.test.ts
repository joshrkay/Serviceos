/**
 * The owner-class `{ to, body }` SMS seam app.ts hands the voice processor,
 * the E2 emergency page ladder and the vulnerable-caller patch-through — bound
 * to the real gate with the outbound kill switch OFF (TELEPHONY_ENABLED=false),
 * the documented launch posture. Life-safety pages must still go; every other
 * owner text stays switched off exactly as before.
 */
import { describe, it, expect } from 'vitest';
import { ownerSmsSender } from '../../src/notifications/owner-sms-sender';
import { GatedMessageDelivery, SmsSuppressedError } from '../../src/notifications/gated-message-delivery';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDncRepository } from '../../src/compliance/dnc';

const OWNER = '+15125550111';

function switchedOffGate() {
  const base = new InMemoryDeliveryProvider(true);
  const gate = new GatedMessageDelivery({
    base,
    dnc: new InMemoryDncRepository(),
    auditRepo: new InMemoryAuditRepository(),
    enforcement: 'block',
    env: { TELEPHONY_ENABLED: 'false' },
    logger: { info: () => undefined },
  });
  return { gate, base };
}

describe('ownerSmsSender — kill switch off', () => {
  it('a sender bound to life-safety (E2 ladder, patch-through miss) still pages the owner', async () => {
    const { gate, base } = switchedOffGate();

    await ownerSmsSender(gate, { alertClass: 'life_safety' })({ to: OWNER, body: 'EMERGENCY page 1/3' });

    expect(base.sentSms).toHaveLength(1);
    expect(base.sentSms[0]).toMatchObject({ to: OWNER, recipientClass: 'owner', alertClass: 'life_safety' });
  });

  it('an unbound sender forwards a per-message life-safety tag (the voice E1 alert)', async () => {
    const { gate, base } = switchedOffGate();

    await ownerSmsSender(gate)({ to: OWNER, body: 'EMERGENCY (E1 life-safety)', alertClass: 'life_safety' });

    expect(base.sentSms).toHaveLength(1);
  });

  it('an untagged owner text (transfer context, digest) stays switched off', async () => {
    const { gate, base } = switchedOffGate();

    await expect(ownerSmsSender(gate)({ to: OWNER, body: 'Transfer: caller asking about invoice' })).rejects.toBeInstanceOf(
      SmsSuppressedError,
    );
    expect(base.sentSms).toHaveLength(0);
  });
});
