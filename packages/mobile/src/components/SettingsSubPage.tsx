import type { ReactNode } from 'react';
import { ScreenShell } from './ScreenShell';

export function SettingsSubPage({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <ScreenShell title={title} subtitle={subtitle} backLabel="‹ Settings">
      {children}
    </ScreenShell>
  );
}
