/**
 * #1398 — mobile bar (CLAUDE.md): the job activity timeline's add-entry
 * actions and parts expanders are ≥44×44 tap targets. jsdom can't measure
 * layout, so this pins the class contract; e2e/page-tap-targets-mobile.spec.ts
 * measures the real job page at 320/375px.
 */
import { render } from '@testing-library/react';
import { describe, it, vi } from 'vitest';
import { ActivityTimeline } from './ActivityTimeline';
import type { JobActivity } from '../../types/job-ui';
import { expectAllTapTargets } from '../../test-utils/tap-target';

describe('#1398 — ActivityTimeline mobile bar', () => {
  it('the empty state "Add first entry" action is a ≥44×44 tap target', () => {
    const { container } = render(<ActivityTimeline activities={[]} onAddEntry={vi.fn()} />);
    expectAllTapTargets(container, 'ActivityTimeline (empty)');
  });

  it('"Add entry" and a parts expander are ≥44×44 tap targets', () => {
    const activities = [
      {
        id: 'a1',
        type: 'parts',
        content: 'Used parts',
        time: '9:00 AM',
        parts: [{ id: 'p1', name: 'Capacitor', qty: 1, unitCost: 25 }],
      },
      { id: 'a2', type: 'note', content: 'Checked the unit', time: '9:05 AM' },
    ] as unknown as JobActivity[];
    const { container } = render(<ActivityTimeline activities={activities} onAddEntry={vi.fn()} />);
    expectAllTapTargets(container, 'ActivityTimeline (with entries)');
  });
});
