import type { Mode } from '@ai-service-os/shared';

export type Persona = Mode;
export type TabName = 'index' | 'today' | 'voice' | 'customers' | 'jobs' | 'settings';

export interface PersonaNavInput {
  role: string;
  currentMode: Mode;
  canFieldServe: boolean;
}

export interface PersonaQuickLink {
  label: string;
  route: '/messages' | '/schedule' | '/estimates' | '/invoices' | '/approvals' | '/jobs';
}

export interface PersonaNavModel {
  persona: Persona;
  landingTab: 'index' | 'today';
  visibleTabs: readonly TabName[];
  showModeToggle: boolean;
  home: {
    showToday: boolean;
    showVoice: boolean;
    showApprovals: boolean;
    showMoney: boolean;
  };
  quickLinks: readonly PersonaQuickLink[];
}

const SUPERVISOR_LINKS: readonly PersonaQuickLink[] = [
  { label: 'Messages', route: '/messages' },
  { label: 'Schedule', route: '/schedule' },
  { label: 'Estimates', route: '/estimates' },
  { label: 'Invoices', route: '/invoices' },
  { label: 'Approvals', route: '/approvals' },
];

const BOTH_LINKS: readonly PersonaQuickLink[] = [
  { label: 'Messages', route: '/messages' },
  { label: 'Schedule', route: '/schedule' },
  { label: 'Approvals', route: '/approvals' },
];

const TECH_LINKS: readonly PersonaQuickLink[] = [
  { label: 'Jobs', route: '/jobs' },
  { label: 'Messages', route: '/messages' },
];

function isTechnicianRole(role: string): boolean {
  return role === 'technician' || role === 'tech';
}

export function navModelFor(input: PersonaNavInput): PersonaNavModel {
  const technicianRole = isTechnicianRole(input.role);
  const persona: Persona = technicianRole ? 'tech' : input.currentMode;
  const showModeToggle =
    !technicianRole && (input.role === 'owner' || input.canFieldServe);

  if (persona === 'tech') {
    return {
      persona,
      landingTab: 'today',
      visibleTabs: ['today', 'customers', 'jobs'],
      showModeToggle,
      home: {
        showToday: true,
        showVoice: false,
        showApprovals: false,
        showMoney: false,
      },
      quickLinks: TECH_LINKS,
    };
  }

  if (persona === 'both') {
    return {
      persona,
      landingTab: 'today',
      visibleTabs: ['today', 'index', 'voice', 'jobs', 'settings'],
      showModeToggle,
      home: {
        showToday: true,
        showVoice: true,
        showApprovals: true,
        showMoney: false,
      },
      quickLinks: BOTH_LINKS,
    };
  }

  return {
    persona,
    landingTab: 'index',
    visibleTabs: ['index', 'voice', 'customers', 'jobs', 'settings'],
    showModeToggle,
    home: {
      showToday: false,
      showVoice: true,
      showApprovals: true,
      showMoney: true,
    },
    quickLinks: SUPERVISOR_LINKS,
  };
}
