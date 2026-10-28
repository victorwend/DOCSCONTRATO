'use client';

import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { api } from '@/lib/api';

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
  useEffect(() => {
    api<{ user: User }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => undefined); // 401 redireciona para /login
  }, []);
  if (!user) return <>{fallback}</>;
  return <Ctx.Provider value={user}>{children}</Ctx.Provider>;
}
