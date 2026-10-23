import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { clerkPrimaryEmail } from '../../src/webhooks/clerk-primary-email';
import { clerkInviteeUserCreated } from '../../../../e2e/helpers/clerk-invitee';

/**
 * The Playwright journeys join an invited teammate through the real Clerk
 * `user.created` webhook, and that join only runs when the payload's PRIMARY
 * email is one Clerk reports as verified (clerkPrimaryEmail). A bare
 * `{ email_address }` invitee payload is read as unverified, so the API
 * bootstraps a separate tenant instead and every journey that needs the
 * technician in the owner's tenant fails.
 *
 * These tests pin the one e2e builder (e2e/helpers/clerk-invitee.ts) to the
 * parser the handler uses, and keep inline invitee payloads out of e2e/.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const E2E_DIR = join(REPO_ROOT, 'e2e');
const HELPER = join(E2E_DIR, 'helpers', 'clerk-invitee.ts');

function e2eSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : e2eSources(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('e2e Clerk invitee payloads', () => {
  it('an invitation sign-up carries a verified primary email the join accepts', () => {
    const event = clerkInviteeUserCreated({
      sub: 'user_e2e_tech',
      email: 'tech@serviceos-hermetic.test',
      invitation: { id: 'inv-1', tenantId: 'tenant-1', role: 'technician' },
    });

    expect(event.type).toBe('user.created');
    expect(event.data.id).toBe('user_e2e_tech');
    expect(clerkPrimaryEmail(event.data)).toEqual({
      address: 'tech@serviceos-hermetic.test',
      verified: true,
    });
    expect(event.data.public_metadata).toEqual({
      invitation_id: 'inv-1',
      tenant_id: 'tenant-1',
      role: 'technician',
    });
    const [address] = event.data.email_addresses as Array<{ id: string; verification: unknown }>;
    expect(event.data.primary_email_address_id).toBe(address.id);
    expect(address.verification).toMatchObject({ status: 'verified', strategy: 'ticket' });
  });

  it('an unverified sign-up with the invited address is read as unverified', () => {
    const event = clerkInviteeUserCreated({
      sub: 'user_e2e_unverified',
      email: 'tech@serviceos-hermetic.test',
      emailStatus: 'unverified',
    });

    expect(clerkPrimaryEmail(event.data)).toEqual({
      address: 'tech@serviceos-hermetic.test',
      verified: false,
    });
    expect(event.data.public_metadata).toEqual({});
  });

  it('no e2e file builds an invitee payload inline — they all go through the helper', () => {
    const inline = e2eSources(E2E_DIR)
      .filter((file) => file !== HELPER)
      .filter((file) => /\binvitation_id\s*:/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file));

    expect(inline).toEqual([]);
  });
});
