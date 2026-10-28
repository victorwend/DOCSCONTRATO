'use client';

import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  permissions: string[];
}

const Ctx = createContext<User | null>(null);
export const useUser = () => useContext(Ctx)!;

export function can(user: User | null, perm: string) {
  return !!user && (user.permissions.includes('*') || user.permissions.includes(perm));
}

export function SessionProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    api<{ user: User }>('/auth/me', { signal: ctrl.signal })
      .then((r) => setUser(r.user))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) return; // api() já redireciona para /login
        setError(
          ctrl.signal.aborted
            ? 'A API não respondeu a tempo.'
            : `Não foi possível falar com a API (${e instanceof ApiError ? `erro ${e.status}` : (e as Error).message}).`,
        );
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, []);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md rounded-lg bg-white p-6 text-center shadow-card ring-1 ring-neutral-200">
          <p className="text-lg font-bold">Servidor indisponível</p>
          <p className="mt-2 text-sm text-neutral-600">{error}</p>
          <p className="mt-2 text-xs text-neutral-500">
            Verifique se a API está no ar e se a variável API_URL do site aponta para ela.
          </p>
          <button className="mt-4 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white" onClick={() => location.reload()}>
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }
  if (!user) return <>{fallback}</>;
  return <Ctx.Provider value={user}>{children}</Ctx.Provider>;
}
