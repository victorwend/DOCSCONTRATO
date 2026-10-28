'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { can, useUser } from '@/components/session';
import { Badge, Button, Card, EmptyState, Spinner, useToast } from '@/components/ui';

export default function ModelsPage() {
  const user = useUser();
  const toast = useToast();
  const router = useRouter();
  const [models, setModels] = useState<any[] | null>(null);
  const manage = can(user, 'models.manage');

  const load = () => api('/models').then(setModels).catch((e) => toast('error', e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function duplicate(id: string) {
    try {
      const r = await api(`/models/${id}/duplicate`, { method: 'POST' });
      toast('success', 'Modelo duplicado (inativo). Revise e ative.');
      router.push(`/modelos/${r.id}`);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function toggle(m: any) {
    try {
      await api(`/models/${m.id}/active`, { method: 'PATCH', body: { active: !m.active } });
      load();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Modelos de documentação</h1>
          <p className="text-sm text-neutral-500">Cada modelo define documentos, ordem, perguntas e regras. Novos modelos ficam disponíveis em “Nova solicitação”.</p>
        </div>
        {manage && (
          <Link href="/modelos/novo">
            <Button variant="primary">+ Novo modelo</Button>
          </Link>
        )}
      </div>
      {!models ? (
        <Spinner />
      ) : models.length === 0 ? (
        <EmptyState title="Nenhum modelo cadastrado" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {models.map((m) => (
            <Card key={m.id}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Link href={`/modelos/${m.id}`} className="font-bold hover:underline">
                    {m.name}
                  </Link>
                  <p className="mt-0.5 text-xs text-neutral-500">{m.description}</p>
                </div>
                <Badge className={m.active ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-neutral-100 text-neutral-500 ring-neutral-300'}>{m.active ? 'Ativo' : 'Inativo'}</Badge>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-neutral-600">
                <span>{m.items_count} documentos</span>·<span>{m.questions_count} perguntas</span>·<span>{m.rules_count} regras</span>·<span>{m.requests_count} solicitações</span>·
                <span>{m.submission_mode === 'SINGLE_FILE' ? 'PDF único' : 'Docs separados'}</span>
              </div>
              <p className="mt-1 text-[11px] text-neutral-400">Atualizado em {fmtDateTime(m.updated_at)}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href={`/modelos/${m.id}`}>
                  <Button size="sm" variant="dark">
                    {manage ? 'Editar' : 'Ver'}
                  </Button>
                </Link>
                {manage && (
                  <>
                    <Button size="sm" onClick={() => duplicate(m.id)}>
                      Duplicar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggle(m)}>
                      {m.active ? 'Desativar' : 'Ativar'}
                    </Button>
                  </>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
