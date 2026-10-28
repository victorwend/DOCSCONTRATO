'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDate, fmtDoc, REQUEST_STATUS } from '@/lib/format';
import { can, useUser } from '@/components/session';
import { Button, Card, cx, DocStatusBadge, EmptyState, Input, Modal, ProgressBar, RequestStatusBadge, Select, Spinner, useToast } from '@/components/ui';

interface Row {
  id: string;
  code: string;
  applicant_name: string;
  applicant_document: string | null;
  model_name: string;
  model_id: string;
  status: string;
  created_at: string;
  deadline: string | null;
  responsible_name: string | null;
  final_file_id: string | null;
  has_link: boolean;
  docs_total: number;
  docs_approved: number;
  docs_received: number;
  docs_rejected: number;
  docs_pending: number;
}

const CARDS = [
  { key: '', label: 'Total de processos' },
  { key: 'AGUARDANDO_DOCUMENTOS', label: 'Aguardando documentos' },
  { key: 'EM_CONFERENCIA', label: 'Em conferência' },
  { key: 'PENDENCIA', label: 'Com pendência' },
  { key: 'APROVADO', label: 'Aprovados' },
  { key: 'FINALIZADO', label: 'Finalizados' },
];

export default function Dashboard() {
  const user = useUser();
  const toast = useToast();
  const [stats, setStats] = useState<{ total: number; byStatus: Record<string, number> } | null>(null);
  const [data, setData] = useState<{ total: number; rows: Row[] } | null>(null);
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [filters, setFilters] = useState({ status: '', modelId: '', responsibleUserId: '', from: '', to: '', q: '', document: '' });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [quick, setQuick] = useState<any | null>(null);

  const pageSize = 20;

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    Object.entries(filters).forEach(([k, v]) => v && qs.set(k, v));
    try {
      const [s, d] = await Promise.all([api('/requests/stats'), api(`/requests?${qs}`)]);
      setStats(s);
      setData(d);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters, page, toast]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    api('/models').then(setModels).catch(() => undefined);
    api('/users/options').then(setUsers).catch(() => undefined);
  }, []);

  const set = (k: keyof typeof filters, v: string) => {
    setPage(1);
    setFilters((f) => ({ ...f, [k]: v }));
  };

  async function copyLink(r: Row) {
    try {
      const { link } = await api(`/requests/${r.id}/link`, { body: { regenerate: false } });
      await navigator.clipboard.writeText(link);
      await api(`/requests/${r.id}/link/sent`, { body: { channel: 'copy' } });
      toast('success', 'Link copiado.');
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function downloadPdf(r: Row) {
    try {
      const { url } = await api(`/files/${r.final_file_id}/url?disposition=attachment`);
      window.location.href = url;
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function cancel(r: Row) {
    const reason = window.prompt(`Cancelar a solicitação de ${r.applicant_name}?\nMotivo (opcional):`);
    if (reason === null) return;
    try {
      await api(`/requests/${r.id}/cancel`, { body: { reason } });
      toast('success', 'Solicitação cancelada.');
      load();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function openQuick(r: Row) {
    setQuick({ loading: true, row: r });
    try {
      setQuick({ row: r, detail: await api(`/requests/${r.id}`) });
    } catch (e) {
      setQuick(null);
      toast('error', (e as Error).message);
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Painel de processos</h1>
          <p className="text-sm text-neutral-500">Solicitações de documentos da Pavidez Engenharia</p>
        </div>
        {can(user, 'requests.create') && (
          <Link href="/solicitacoes/nova">
            <Button variant="primary" size="lg">
              + Nova solicitação
            </Button>
          </Link>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {CARDS.map((c) => {
          const n = c.key ? stats?.byStatus[c.key] ?? 0 : stats?.total ?? 0;
          const activeCard = filters.status === c.key;
          return (
            <button
              key={c.label}
              onClick={() => set('status', c.key)}
              className={cx(
                'rounded-lg bg-white p-4 text-left shadow-card ring-1 transition hover:ring-ink',
                activeCard ? 'ring-2 ring-ink' : 'ring-neutral-200',
              )}
            >
              <p className="text-[11px] font-bold uppercase tracking-wide text-neutral-500">{c.label}</p>
              <p className="mt-1 text-3xl font-bold">{stats ? n : '…'}</p>
            </button>
          );
        })}
      </div>

      <Card bodyClass="p-0">
        <div className="grid gap-2 border-b border-neutral-200 p-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <Input placeholder="Nome ou protocolo" value={filters.q} onChange={(e) => set('q', e.target.value)} className="lg:col-span-2" />
          <Input placeholder="CPF/CNPJ" value={filters.document} onChange={(e) => set('document', e.target.value)} />
          <Select value={filters.modelId} onChange={(e) => set('modelId', e.target.value)} aria-label="Tipo">
            <option value="">Todos os tipos</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          <Select value={filters.status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
            <option value="">Todos os status</option>
            {Object.entries(REQUEST_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
          <Select value={filters.responsibleUserId} onChange={(e) => set('responsibleUserId', e.target.value)} aria-label="Responsável">
            <option value="">Todos os responsáveis</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
          <div className="flex gap-1 sm:col-span-2 xl:col-span-2">
            <Input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} aria-label="De" title="De" />
            <Input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} aria-label="Até" title="Até" />
          </div>
        </div>

        {loading && !data ? (
          <div className="flex justify-center p-10">
            <Spinner />
          </div>
        ) : data && data.rows.length === 0 ? (
          <div className="p-6">
            <EmptyState title="Nenhum processo encontrado">Ajuste os filtros ou crie uma nova solicitação.</EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-3 py-2">Nome</th>
                  <th className="px-3 py-2">Tipo</th>
                  <th className="px-3 py-2">CPF/CNPJ</th>
                  <th className="px-3 py-2">Data</th>
                  <th className="px-3 py-2">Progresso</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Responsável</th>
                  <th className="px-3 py-2 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {data?.rows.map((r) => (
                  <tr key={r.id} className="hover:bg-brand-50/50">
                    <td className="px-3 py-2">
                      <Link href={`/solicitacoes/${r.id}`} className="font-semibold hover:underline">
                        {r.applicant_name}
                      </Link>
                      <div className="text-xs text-neutral-500">{r.code}</div>
                    </td>
                    <td className="px-3 py-2">{r.model_name}</td>
                    <td className="whitespace-nowrap px-3 py-2">{fmtDoc(r.applicant_document) || '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {fmtDate(r.created_at)}
                      {r.deadline && <div className="text-xs text-neutral-500">prazo {fmtDate(r.deadline)}</div>}
                    </td>
                    <td className="min-w-[140px] px-3 py-2">
                      <ProgressBar value={r.docs_approved} total={r.docs_total} />
                      <div className="mt-1 text-xs text-neutral-500">
                        {r.docs_approved}/{r.docs_total} aprovados
                        {r.docs_rejected > 0 && <span className="text-red-600"> · {r.docs_rejected} rejeitado(s)</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <RequestStatusBadge status={r.status} />
                    </td>
                    <td className="px-3 py-2">{r.responsible_name ?? '—'}</td>
                    <td className="min-w-[230px] px-3 py-2">
                      <div className="flex flex-wrap justify-end gap-1">
                        <Link href={`/solicitacoes/${r.id}`}>
                          <Button size="sm" variant="dark">
                            Abrir
                          </Button>
                        </Link>
                        <Button size="sm" onClick={() => openQuick(r)}>
                          Visualizar
                        </Button>
                        {r.final_file_id && (
                          <Button size="sm" onClick={() => downloadPdf(r)}>
                            Baixar PDF
                          </Button>
                        )}
                        {r.has_link && !['CANCELADO', 'FINALIZADO'].includes(r.status) && (
                          <Button size="sm" onClick={() => copyLink(r)}>
                            Copiar link
                          </Button>
                        )}
                        {can(user, 'requests.manage') && !['CANCELADO', 'FINALIZADO'].includes(r.status) && (
                          <Button size="sm" variant="ghost" className="text-red-700" onClick={() => cancel(r)}>
                            Cancelar
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > pageSize && (
          <div className="flex items-center justify-between border-t px-3 py-2 text-sm">
            <span className="text-neutral-500">
              {data.total} processos · página {page} de {pages}
            </span>
            <div className="flex gap-1">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Anterior
              </Button>
              <Button size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Próxima
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Modal open={!!quick} onClose={() => setQuick(null)} title={quick ? `${quick.row.applicant_name} — ${quick.row.model_name}` : ''}>
        {quick?.detail ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <RequestStatusBadge status={quick.detail.request.status} />
              <span className="text-sm text-neutral-500">
                {quick.detail.progress.approved} de {quick.detail.progress.total} aprovados
              </span>
            </div>
            <ProgressBar value={quick.detail.progress.approved} total={quick.detail.progress.total} />
            <ul className="divide-y text-sm">
              {quick.detail.documents.map((d: any) => (
                <li key={d.id} className="flex items-center justify-between gap-2 py-1.5">
                  <span className={cx(!d.is_applicable && 'text-neutral-400 line-through')}>{d.name}</span>
                  <DocStatusBadge status={d.status} na={!d.is_applicable} />
                </li>
              ))}
            </ul>
            <Link href={`/solicitacoes/${quick.row.id}`}>
              <Button variant="dark" className="w-full">
                Abrir processo
              </Button>
            </Link>
          </div>
        ) : (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        )}
      </Modal>
    </div>
  );
}
