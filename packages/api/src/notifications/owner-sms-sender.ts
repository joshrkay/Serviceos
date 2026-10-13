/**
 * The owner-class `{ to, body }` SMS seam that the voice processor, the E2
 * emergency page ladder and the vulnerable-caller patch-through take, bound to
 * the one gated delivery object.
 *
 * `alertClass` (bound here, or carried per message by a caller that sends both
 * kinds — the voice processor tags only its E1 alert) is what lets a
 * life-safety page through the customer-facing TELEPHONY_ENABLED=false kill
 * switch; an untagged owner text stays switched off with everything else.
 */
import type { MessageDeliveryProvider, SmsAlertClass } from './delivery-provider';

export interface OwnerSmsArgs {
  to: string;
  body: string;
  alertClass?: SmsAlertClass;
}

export function ownerSmsSender(
  delivery: MessageDeliveryProvider,
  bound: { alertClass?: SmsAlertClass } = {},
): (args: OwnerSmsArgs) => Promise<unknown> {
  return (args) => {
    const alertClass = args.alertClass ?? bound.alertClass;
    return delivery.sendSms({
      to: args.to,
      body: args.body,
      recipientClass: 'owner',
      ...(alertClass ? { alertClass } : {}),
    });
  };
}
