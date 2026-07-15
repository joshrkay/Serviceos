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
    expect(nav.visibleTabs).toEqual(['today', 'customers', 'jobs']);
    expect(nav.showModeToggle).toBe(false);
    expect(nav.home).toMatchObject({
      showToday: true,
      showVoice: false,
      showApprovals: false,
      showMoney: false,
    });
    expect(nav.quickLinks.map((link) => link.route)).not.toContain('/invoices');
    expect(nav.visibleTabs).not.toContain('settings');
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
