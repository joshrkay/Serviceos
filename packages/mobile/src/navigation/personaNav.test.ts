import { describe, expect, it } from 'vitest';
import { navModelFor } from './personaNav';

describe('navModelFor', () => {
  it('keeps a technician role locked to Today even if the stored mode is stale', () => {
    const nav = navModelFor({
      role: 'technician',
      currentMode: 'both',
      canFieldServe: true,
    });

    expect(nav.persona).toBe('tech');
    expect(nav.landingTab).toBe('today');
    // #1603 — technicians get the Voice entry in their tab set (the memo
    // screen that now speaks its answers), still no Home/Settings.
    expect(nav.visibleTabs).toEqual(['today', 'voice', 'customers', 'jobs']);
    expect(nav.showModeToggle).toBe(false);
    expect(nav.home).toMatchObject({
      showToday: true,
      showVoice: false,
      showApprovals: false,
      showMoney: false,
    });
    expect(nav.quickLinks.map((link) => link.route)).not.toContain('/invoices');
    expect(nav.visibleTabs).not.toContain('settings');
    // #1603 — technicians hold `ai:run` (auth/rbac.ts, owner decision
    // 2026-07-27), so the Assistant entry rides with them; the server's own
    // permissions scope what it answers (own day; no proposals:approve on
    // this role, and no in-app voice-approval path exists).
    expect(nav.quickLinks).toContainEqual({ label: 'Assistant', route: '/assistant' });
  });

  it('emphasizes voice, approvals, and money in supervisor mode', () => {
    const nav = navModelFor({
      role: 'owner',
      currentMode: 'supervisor',
      canFieldServe: false,
    });

    expect(nav.persona).toBe('supervisor');
    expect(nav.landingTab).toBe('index');
    expect(nav.home).toEqual({
      showToday: false,
      showVoice: true,
      showApprovals: true,
      showMoney: true,
    });
    expect(nav.visibleTabs).toEqual(['index', 'voice', 'customers', 'jobs', 'settings']);
    expect(nav.showModeToggle).toBe(true);
    // U13 — supervisors hold ai:run, so the assistant entry is present.
    expect(nav.quickLinks.map((link) => link.route)).toContain('/assistant');
  });

  it('blends Today and approvals in both mode', () => {
    const nav = navModelFor({
      role: 'dispatcher',
      currentMode: 'both',
      canFieldServe: true,
    });

    expect(nav.persona).toBe('both');
    expect(nav.landingTab).toBe('today');
    expect(nav.home).toMatchObject({
      showToday: true,
      showVoice: true,
      showApprovals: true,
      showMoney: false,
    });
    expect(nav.visibleTabs).toEqual(['today', 'index', 'voice', 'jobs', 'settings']);
    expect(nav.quickLinks.map((link) => link.route)).toContain('/approvals');
    // U13 — "both" holds ai:run, so the assistant entry is present.
    expect(nav.quickLinks.map((link) => link.route)).toContain('/assistant');
    expect(nav.showModeToggle).toBe(true);
  });

  it('only exposes the mode toggle to owners or field-capable non-technicians', () => {
    expect(
      navModelFor({
        role: 'dispatcher',
        currentMode: 'supervisor',
        canFieldServe: false,
      }).showModeToggle,
    ).toBe(false);
    expect(
      navModelFor({
        role: 'supervisor',
        currentMode: 'supervisor',
        canFieldServe: true,
      }).showModeToggle,
    ).toBe(true);
  });
});
