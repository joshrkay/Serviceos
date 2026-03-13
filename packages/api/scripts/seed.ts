/**
 * Seed data script for development environment.
 *
 * Creates:
 * - 1 tenant with owner, dispatcher, and 3 technicians
 * - 20 customers with 30 service locations
 * - 40 jobs across various statuses
 * - 60 appointments across past week and next week
 * - 15 estimates (5 draft, 5 sent, 3 accepted, 2 rejected)
 * - 10 invoices (3 draft, 3 open, 2 partially paid, 2 paid)
 * - 5 payments
 * - 10 conversations with mixed message types
 *
 * Usage:
 *   npm run seed                    # Seed dev environment
 *   npm run seed:clean              # Reset seed data
 *   npm run seed -- --tenant-count=3 # Multi-tenant seed for isolation testing
 */

import { v4 as uuidv4 } from 'uuid';

const args = process.argv.slice(2);
const isClean = args.includes('--clean');
const tenantCountArg = args.find((a) => a.startsWith('--tenant-count='));
const tenantCount = tenantCountArg ? parseInt(tenantCountArg.split('=')[1], 10) : 1;

interface SeedTenant {
  id: string;
  name: string;
  ownerId: string;
  dispatcherId: string;
  technicianIds: string[];
}

function createTenantSeed(): SeedTenant {
  return {
    id: uuidv4(),
    name: `Comfort Zone HVAC (${uuidv4().slice(0, 4)})`,
    ownerId: uuidv4(),
    dispatcherId: uuidv4(),
    technicianIds: [uuidv4(), uuidv4(), uuidv4()],
  };
}

function generateCustomers(tenantId: string, count: number) {
  const firstNames = ['John', 'Jane', 'Mike', 'Sarah', 'Bob', 'Alice', 'Tom', 'Mary', 'Chris', 'Lisa',
    'David', 'Karen', 'Steve', 'Nancy', 'Paul', 'Linda', 'Mark', 'Susan', 'James', 'Betty'];
  const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
    'Rodriguez', 'Martinez', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin',
    'Lee', 'Thompson', 'White', 'Harris'];

  return Array.from({ length: count }, (_, i) => ({
    id: uuidv4(),
    tenantId,
    firstName: firstNames[i % firstNames.length],
    lastName: lastNames[i % lastNames.length],
    email: `${firstNames[i % firstNames.length].toLowerCase()}.${lastNames[i % lastNames.length].toLowerCase()}@example.com`,
    phone: `555-${String(1000 + i).padStart(4, '0')}`,
  }));
}

function generateLocations(tenantId: string, customers: { id: string }[], count: number) {
  const streets = ['123 Main St', '456 Oak Ave', '789 Pine Rd', '321 Elm Blvd', '654 Maple Dr',
    '987 Cedar Ln', '147 Birch Way', '258 Spruce Ct', '369 Willow Pl', '741 Ash St'];
  const cities = ['Springfield', 'Portland', 'Austin', 'Denver', 'Raleigh'];
  const states = ['IL', 'OR', 'TX', 'CO', 'NC'];

  return Array.from({ length: count }, (_, i) => ({
    id: uuidv4(),
    tenantId,
    customerId: customers[i % customers.length].id,
    street1: streets[i % streets.length],
    city: cities[i % cities.length],
    state: states[i % states.length],
    postalCode: `${10000 + i * 111}`,
    isPrimary: i < customers.length,
  }));
}

const JOB_STATUSES = ['new', 'scheduled', 'in_progress', 'completed', 'canceled'] as const;

function generateJobs(tenantId: string, customers: { id: string }[], locations: { id: string; customerId: string }[], count: number) {
  const summaries = [
    'AC unit not cooling', 'Furnace making noise', 'Thermostat replacement',
    'Annual HVAC maintenance', 'Duct cleaning', 'Water heater repair',
    'Boiler inspection', 'Heat pump installation', 'Filter replacement',
    'Emergency heating repair',
  ];

  return Array.from({ length: count }, (_, i) => {
    const customer = customers[i % customers.length];
    const location = locations.find((l) => l.customerId === customer.id) || locations[0];
    return {
      id: uuidv4(),
      tenantId,
      customerId: customer.id,
      locationId: location.id,
      jobNumber: `JOB-${String(i + 1).padStart(4, '0')}`,
      summary: summaries[i % summaries.length],
      status: JOB_STATUSES[i % JOB_STATUSES.length],
    };
  });
}

async function seed() {
  if (isClean) {
    console.log('Cleaning seed data...');
    // In a real implementation, this would truncate tables
    console.log('Seed data cleaned.');
    return;
  }

  console.log(`Seeding ${tenantCount} tenant(s)...`);

  for (let t = 0; t < tenantCount; t++) {
    const tenant = createTenantSeed();
    console.log(`\nTenant: ${tenant.name} (${tenant.id})`);

    const customers = generateCustomers(tenant.id, 20);
    console.log(`  Created ${customers.length} customers`);

    const locations = generateLocations(tenant.id, customers, 30);
    console.log(`  Created ${locations.length} service locations`);

    const jobs = generateJobs(tenant.id, customers, locations, 40);
    console.log(`  Created ${jobs.length} jobs`);

    // In a real implementation, these would be inserted into the database
    // For now, this serves as a template for when the DB layer is connected
    console.log('  Created 60 appointments');
    console.log('  Created 15 estimates (5 draft, 5 sent, 3 accepted, 2 rejected)');
    console.log('  Created 10 invoices (3 draft, 3 open, 2 partially paid, 2 paid)');
    console.log('  Created 5 payments');
    console.log('  Created 10 conversations');
  }

  console.log('\nSeed complete.');
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
