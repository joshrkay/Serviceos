import React, { useId, useRef } from 'react';
import { cn } from './utils';

export interface TabItem {
  /** Stable identifier for the tab. */
  value: string;
  label: React.ReactNode;
  /** Optional trailing count/badge. */
  badge?: React.ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  /** Visual treatment. `underline` for page-level, `pill` for compact. */
  variant?: 'underline' | 'pill';
  className?: string;
  'aria-label'?: string;
  /**
   * Explicit base id for tab/panel ARIA wiring. Pass the same value to the
   * paired `TabPanel`s (as `tabsId`) so `aria-controls`/`aria-labelledby`
   * resolve to real elements. Defaults to an auto-generated id.
   */
  id?: string;
}

/**
 * Accessible tablist with roving tabindex and arrow-key navigation.
 * Controlled — pair it with separate panels keyed on `value`. Used to
 * consolidate navigation surfaces (e.g. folding Inbox into Assistant)
 * without adding routes.
 */
export function Tabs({
  items,
  value,
  onValueChange,
  variant = 'underline',
  className,
  'aria-label': ariaLabel,
  id,
}: TabsProps) {
  const autoId = useId();
  const baseId = id ?? autoId;
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function focusByIndex(index: number) {
    const enabled = items.filter((i) => !i.disabled);
    if (enabled.length === 0) return;
    const next = enabled[(index + enabled.length) % enabled.length];
    refs.current[next.value]?.focus();
    onValueChange(next.value);
  }

  function handleKeyDown(event: React.KeyboardEvent, current: string) {
    const enabled = items.filter((i) => !i.disabled);
    const idx = enabled.findIndex((i) => i.value === current);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      focusByIndex(idx + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusByIndex(idx - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusByIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusByIndex(enabled.length - 1);
    }
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        variant === 'underline'
          ? 'flex gap-1 border-b border-slate-200'
          : 'inline-flex gap-1 rounded-xl bg-slate-100 p-1',
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(el) => {
              refs.current[item.value] = el;
            }}
            id={`${baseId}-tab-${item.value}`}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={`${baseId}-panel-${item.value}`}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onValueChange(item.value)}
            onKeyDown={(e) => handleKeyDown(e, item.value)}
            className={cn(
              'inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
              'disabled:cursor-not-allowed disabled:opacity-40',
              variant === 'underline'
                ? cn(
                    '-mb-px border-b-2 px-3 py-2',
                    selected
                      ? 'border-slate-900 text-slate-900'
                      : 'border-transparent text-slate-500 hover:text-slate-700',
                  )
                : cn(
                    'rounded-lg px-3 py-1.5',
                    selected
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-500 hover:text-slate-700',
                  ),
            )}
          >
            {item.label}
            {item.badge != null && (
              <span
                className={cn(
                  'ml-0.5 inline-flex min-w-4 items-center justify-center rounded-full px-1 text-xs',
                  selected
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-200 text-slate-600',
                )}
              >
                {item.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Must match the corresponding tab's `value`. */
  value: string;
  /** The currently selected tab value. */
  activeValue: string;
  /**
   * The parent `Tabs`' `id`. When provided, the panel renders the matching
   * `id`/`aria-labelledby` so the tab's `aria-controls` resolves correctly.
   */
  tabsId?: string;
}

/** Panel paired with a `Tabs` item; renders only when active. */
export function TabPanel({
  value,
  activeValue,
  tabsId,
  className,
  children,
  id,
  'aria-labelledby': ariaLabelledby,
  ...rest
}: TabPanelProps) {
  if (value !== activeValue) return null;
  return (
    <div
      role="tabpanel"
      id={id ?? (tabsId ? `${tabsId}-panel-${value}` : undefined)}
      aria-labelledby={ariaLabelledby ?? (tabsId ? `${tabsId}-tab-${value}` : undefined)}
      tabIndex={0}
      className={cn('outline-none', className)}
      {...rest}
    >
      {children}
    </div>
  );
}
