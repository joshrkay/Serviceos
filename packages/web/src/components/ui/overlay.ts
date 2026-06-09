import React, { useEffect, useRef } from 'react';

/**
 * Shared behavior for modal-style overlays (Modal, Sheet).
 *
 * Dependency-free replacements for the radix primitives the rest of the
 * design system avoids: a body scroll-lock, a focus trap that restores
 * focus to the previously-active element on close, and Escape-to-dismiss.
 * Keeping this in one place means every overlay behaves identically for
 * keyboard and screen-reader users.
 */

// Track active scroll locks globally so overlapping overlays (e.g. a Sheet
// plus a confirmation Modal) keep the body locked until the *last* one
// closes. A naive per-instance restore would unlock the background while a
// dialog is still open if the older overlay happened to close first.
let scrollLockCount = 0;
let savedBodyOverflow = '';

/** Locks body scroll while `active` is true, restoring once all locks clear. */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    if (scrollLockCount === 0) {
      savedBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    scrollLockCount += 1;
    return () => {
      scrollLockCount -= 1;
      if (scrollLockCount === 0) {
        document.body.style.overflow = savedBodyOverflow;
      }
    };
  }, [active]);
}

// Stack of active focus traps. Only the trap on top should restore focus
// when it closes — an older overlay closing beneath a newer dialog must not
// yank focus to an element behind the still-open top dialog.
const trapStack: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), ' +
  'input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Traps focus within `ref` while `active`, calls `onClose` on Escape, and
 * restores focus to whatever was focused before opening when it closes.
 */
export function useFocusTrap(
  ref: React.RefObject<HTMLElement>,
  active: boolean,
  onClose: () => void,
): void {
  // Keep the latest onClose without re-running the effect on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const node = ref.current;
    if (!node) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const token = Symbol('focus-trap');
    trapStack.push(token);

    // Move focus into the overlay (first focusable, else the container).
    const focusables = node.querySelectorAll<HTMLElement>(FOCUSABLE);
    (focusables[0] ?? node).focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = node!.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement;
      // Wrap focus back inside if it's on the container itself or has
      // somehow escaped the overlay, otherwise it can leak to the page.
      if (!node!.contains(activeEl) || activeEl === node) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && activeEl === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeEl === last) {
        event.preventDefault();
        first.focus();
      }
    }

    node.addEventListener('keydown', handleKeyDown);
    return () => {
      node.removeEventListener('keydown', handleKeyDown);
      // Only restore focus if this was the top-most trap; restoring from a
      // trap beneath a newer dialog would pull focus behind it.
      const wasTop = trapStack[trapStack.length - 1] === token;
      const idx = trapStack.lastIndexOf(token);
      if (idx !== -1) trapStack.splice(idx, 1);
      if (wasTop) previouslyFocused?.focus?.();
    };
  }, [active, ref]);
}
