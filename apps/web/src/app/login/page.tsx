'use client';

import { FormEvent, Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Alert, Button, Field, Input } from '@/components/ui';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api('/auth/login', { body: { email, password } });
      const next = params.get('next');
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert kind="error">{error}</Alert>}
      <Field label="E-mail">
        <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      </Field>
      <Field label="Senha">
        <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Button type="submit" variant="dark" size="lg" className="w-full" loading={loading}>
        Entrar
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-ink px-4">
      <div className="w-full max-w-sm overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="border-b-4 border-brand bg-white px-6 pb-4 pt-6 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-pavidez.png" alt="Pavidez Engenharia" className="mx-auto h-14 w-auto" />
          <p className="mt-3 text-sm font-bold tracking-widest text-neutral-700">PAVIDEZ DOCS</p>
          <p className="text-xs text-neutral-500">Portal de Documentos</p>
        </div>
        <div className="p-6">
          <Suspense>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
