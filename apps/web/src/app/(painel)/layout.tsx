'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useState } from 'react';
import { api } from '@/lib/api';
import { can, SessionProvider, useUser } from '@/components/session';
import { cx, Spinner } from '@/components/ui';

function Shell({ children }: { children: ReactNode }) {
  const user = useUser();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const nav = [
    { href: '/', label: 'Painel', show: true },
    { href: '/solicitacoes/nova', label: 'Nova solicitação', show: can(user, 'requests.create') },
    { href: '/modelos', label: 'Modelos', show: can(user, 'models.read') },
    { href: '/usuarios', label: 'Usuários', show: can(user, 'users.manage') },
  ].filter((n) => n.show);

  const active = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace('/login');
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b-4 border-brand bg-ink text-white">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-2.5">
          <Link href="/" className="flex items-center gap-3">
            <span className="rounded bg-white px-2 py-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo-pavidez.png" alt="Pavidez" className="h-7 w-auto" />
            </span>
            <span className="hidden text-sm font-bold tracking-widest text-brand sm:inline">DOCS</span>
          </Link>
          <nav className="hidden flex-1 items-center gap-1 md:flex">
            {nav.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={cx('rounded px-3 py-1.5 text-sm font-medium', active(n.href) ? 'bg-brand text-ink' : 'text-neutral-200 hover:bg-white/10')}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto hidden items-center gap-3 md:flex">
            <span className="text-right text-xs leading-tight">
              <span className="block font-semibold">{user.name}</span>
              <span className="text-neutral-400">{user.role}</span>
            </span>
            <button onClick={logout} className="rounded px-2 py-1 text-xs text-neutral-300 ring-1 ring-white/20 hover:bg-white/10">
              Sair
            </button>
          </div>
          <button className="ml-auto rounded p-2 md:hidden" onClick={() => setOpen((v) => !v)} aria-label="Menu">
            ☰
          </button>
        </div>
        {open && (
          <nav className="space-y-1 border-t border-white/10 px-4 py-2 md:hidden">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} onClick={() => setOpen(false)} className={cx('block rounded px-3 py-2 text-sm', active(n.href) ? 'bg-brand text-ink' : 'text-neutral-200')}>
                {n.label}
              </Link>
            ))}
            <button onClick={logout} className="block w-full rounded px-3 py-2 text-left text-sm text-neutral-300">
              Sair ({user.name})
            </button>
          </nav>
        )}
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}

export default function PanelLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider
      fallback={
        <div className="flex min-h-screen items-center justify-center text-neutral-500">
          <Spinner />
        </div>
      }
    >
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
