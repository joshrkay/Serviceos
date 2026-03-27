'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { MessageCircle, Users, Settings } from 'lucide-react';

const TABS = [
  { href: '/', label: 'Conversation', icon: MessageCircle },
  { href: '/customers', label: 'Customers', icon: Users },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const;

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex flex-col min-h-dvh max-w-lg mx-auto w-full">
      {/* Main content area — fills available space */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {children}
      </main>

      {/* Bottom tab nav — fixed at bottom */}
      <nav className="shrink-0 border-t border-slate-200 bg-white/95 backdrop-blur-sm px-2 pb-[env(safe-area-inset-bottom)]">
        <div className="flex">
          {TABS.map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-xs transition-colors ${
                  active ? 'text-blue-600' : 'text-slate-400 hover:text-slate-600'
                }`}
              >
                <Icon size={20} strokeWidth={active ? 2.2 : 1.8} />
                <span className={active ? 'font-medium' : ''}>{label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
