import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/db/schema';

describe('portal_sessions RLS migration 107', () => {
  it('requires app.portal_token_lookup for token-hash reads', () => {
    const sql = MIGRATIONS['107_portal_sessions_system_lookup_rls'];
    expect(sql).toContain('app.portal_token_lookup');
    expect(sql).not.toContain('current_setting(\'app.current_tenant_id\', true) IS NULL');
  });
});
