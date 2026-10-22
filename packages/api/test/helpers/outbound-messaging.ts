import type { Pool } from 'pg';
import type { CustomerRepository } from '../../src/customers/customer';
import type { DncRepository } from '../../src/compliance/dnc';
import type { MessageDeliveryProvider } from '../../src/notifications/delivery-provider';
import type { DispatchRepository } from '../../src/notifications/dispatch-repository';
import type { ConsentLedgerLookup } from '../../src/notifications/gated-message-delivery';
import {
  createOutboundMessaging,
  type OutboundMessaging,
} from '../../src/notifications/outbound-messaging';

/**
 * Real outbound messaging over a test's own delivery, customers and dispatch
 * rows: what `SendService` texts through (D-045). Nothing on the DNC list, no
 * marketing grants, and no dedupe claim unless the test passes a pool.
 */
export function outboundFor(deps: {
  delivery: MessageDeliveryProvider;
  customerRepo: Pick<CustomerRepository, 'findById'>;
  dispatchRepo: Pick<DispatchRepository, 'recordOutcome'>;
  pool?: Pool | null;
  dncRepo?: Pick<DncRepository, 'isOnDnc'>;
  consentLedger?: ConsentLedgerLookup;
}): OutboundMessaging {
  return createOutboundMessaging({
    delivery: deps.delivery,
    customerRepo: deps.customerRepo,
    dispatchRepo: deps.dispatchRepo,
    pool: deps.pool ?? null,
    dncRepo: deps.dncRepo ?? { isOnDnc: async () => false },
    consentLedger: deps.consentLedger ?? { listByPhone: async () => [] },
    logger: { info: () => {}, warn: () => {} },
  });
}

/** `SendService` deps with `outbound` built over the same delivery, customers and dispatch rows. */
export function withOutbound<
  D extends {
    delivery: MessageDeliveryProvider;
    customerRepo: Pick<CustomerRepository, 'findById'>;
    dispatchRepo: Pick<DispatchRepository, 'recordOutcome'>;
  },
>(deps: D, pool?: Pool | null): D & { outbound: OutboundMessaging } {
  return { ...deps, outbound: outboundFor({ ...deps, pool }) };
}
