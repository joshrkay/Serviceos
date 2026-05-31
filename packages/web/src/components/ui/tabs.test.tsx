import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Tabs, TabPanel, type TabItem } from './tabs';

const items: TabItem[] = [
  { value: 'chat', label: 'Assistant' },
  { value: 'inbox', label: 'Inbox', badge: 2 },
  { value: 'history', label: 'History', disabled: true },
];

describe('Tabs', () => {
  it('marks the selected tab and exposes roving tabindex', () => {
    render(<Tabs items={items} value="chat" onValueChange={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
  });

  it('omits aria-controls when no explicit id is given (no panel to point at)', () => {
    render(<Tabs items={items} value="chat" onValueChange={() => {}} />);
    // Without a shared id, a paired TabPanel cannot render the matching panel
    // element, so the tab must not advertise a dangling aria-controls.
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab).not.toHaveAttribute('aria-controls');
    }
  });

  it('renders a badge', () => {
    render(<Tabs items={items} value="chat" onValueChange={() => {}} />);
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('fires onValueChange on click', () => {
    const onChange = vi.fn();
    render(<Tabs items={items} value="chat" onValueChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: /Inbox/ }));
    expect(onChange).toHaveBeenCalledWith('inbox');
  });

  it('navigates with ArrowRight skipping disabled tabs', () => {
    const onChange = vi.fn();
    render(<Tabs items={items} value="inbox" onValueChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('tab', { name: /Inbox/ }), {
      key: 'ArrowRight',
    });
    // history is disabled, so it wraps back to chat
    expect(onChange).toHaveBeenCalledWith('chat');
  });

  it('wires aria-controls to the matching panel id when ids are shared', () => {
    function Harness() {
      const [v, setV] = useState('chat');
      return (
        <>
          <Tabs id="t1" items={items} value={v} onValueChange={setV} />
          <TabPanel tabsId="t1" value="chat" activeValue={v}>
            chat-panel
          </TabPanel>
        </>
      );
    }
    render(<Harness />);
    const selectedTab = screen.getByRole('tab', { name: 'Assistant' });
    const controls = selectedTab.getAttribute('aria-controls');
    const panel = screen.getByRole('tabpanel');
    expect(controls).toBe('t1-panel-chat');
    expect(panel).toHaveAttribute('id', 't1-panel-chat');
    expect(panel).toHaveAttribute('aria-labelledby', 't1-tab-chat');
    expect(selectedTab).toHaveAttribute('id', 't1-tab-chat');
  });

  it('TabPanel only renders the active panel', () => {
    function Harness() {
      const [v, setV] = useState('chat');
      return (
        <>
          <Tabs items={items} value={v} onValueChange={setV} />
          <TabPanel value="chat" activeValue={v}>
            chat-panel
          </TabPanel>
          <TabPanel value="inbox" activeValue={v}>
            inbox-panel
          </TabPanel>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByText('chat-panel')).toBeInTheDocument();
    expect(screen.queryByText('inbox-panel')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Inbox/ }));
    expect(screen.getByText('inbox-panel')).toBeInTheDocument();
    expect(screen.queryByText('chat-panel')).toBeNull();
  });
});
