import { loadConfig } from '../config';
import { CommandBus } from '../core/commands';
import { createDb } from '../core/db';
import { createCustomerCommand } from '../modules/crm/customers';
import { createInvoiceCommand, sendInvoiceCommand } from '../modules/money/invoices';
import { createJobCommand } from '../modules/money/jobs';
import { createTenant } from '../modules/platform/tenants';
import { runMigrations } from './migrate';

/** Dev seed: one tenant, an owner, sample customers and an invoice. */
async function seed(): Promise<void> {
  const config = loadConfig();
  await runMigrations(config.databaseAdminUrl);
  const db = createDb(config.databaseUrl, config.databaseAdminUrl);
  const bus = new CommandBus(db);

  const existing = await db.admin.query(`SELECT id FROM tenants WHERE phone = '+15550100'`);
  if (existing.rows[0]) {
    console.log('seed already applied; tenant', existing.rows[0].id);
    await db.close();
    return;
  }

  const { tenantId, ownerUserId } = await createTenant(db, {
    name: 'Acme HVAC',
    phone: '+15550100',
    owner: { name: 'Mike Rivera', phone: '+15550199', email: 'mike@acmehvac.test' },
  });
  await db.admin.query(
    `UPDATE tenants SET default_tax_rate_bps = 825 WHERE id = $1`,
    [tenantId],
  );

  const scope = { tenantId, actor: { type: 'user' as const, id: ownerUserId } };
  const johnson = await bus.execute(createCustomerCommand, scope, {
    name: 'Sarah Johnson',
    phone: '+15550111',
    address: '12 Oak Lane',
  });
  const patel = await bus.execute(createCustomerCommand, scope, {
    name: 'Dev Patel',
    phone: '+15550112',
    address: '88 Birch Road',
  });
  await bus.execute(createJobCommand, scope, {
    customerId: patel.id,
    title: 'Furnace tune-up',
  });
  const invoice = await bus.execute(createInvoiceCommand, scope, {
    customerId: johnson.id,
    lineItems: [
      { description: 'Capacitor replacement', quantityHundredths: 100, unitPriceCents: 24_500 },
      { description: 'Labor', quantityHundredths: 150, unitPriceCents: 12_000 },
    ],
  });
  await bus.execute(sendInvoiceCommand, scope, { invoiceId: invoice.id });

  console.log(JSON.stringify({ tenantId, ownerUserId, customers: [johnson.id, patel.id], invoiceId: invoice.id }, null, 2));
  await db.close();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
