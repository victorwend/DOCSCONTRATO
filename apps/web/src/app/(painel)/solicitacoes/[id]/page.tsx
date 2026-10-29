'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, upload } from '@/lib/api';
import { answerText, AUDIT_LABELS, fmtBytes, fmtDate, fmtDateTime, maskDocInput, maskPhone, REJECTION_REASONS, REQUEST_STATUS } from '@/lib/format';
import { can, useUser } from '@/components/session';
import { FileViewer } from '@/components/FileViewer';
import { QuestionInput } from '@/components/QuestionInput';
import { AcceptSelect } from '@/components/AcceptSelect';
import { ShareLink } from '@/components/ShareLink';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  cx,
  DocStatusBadge,
  Field,
  Input,
  Modal,
  ProgressBar,
  RequestStatusBadge,
  Select,
  Spinner,
  Textarea,
  useToast,
} from '@/components/ui';

type Detail = any;

const OPEN = ['RASCUNHO', 'AGUARDANDO_DOCUMENTOS', 'EM_CONFERENCIA', 'PENDENCIA', 'APROVADO', 'EXPIRADO'];

export default function RequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const user = useUser();
  const toast = useToast();
  const [d, setD] = useState<Detail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [viewDoc, setViewDoc] = useState<any | null>(null);
  const [rejectDoc, setRejectDoc] = useState<any | null>(null);
  const [rejectForm, setRejectForm] = useState({ reason: 'ILEGIVEL', note: '', notifyApplicant: true });
  const [editOpen, setEditOpen] = useState(false);
  const [answersOpen, setAnswersOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [sendFinalEmail, setSendFinalEmail] = useState(true);
  const [waNotice, setWaNotice] = useState<{ link: string; doc: string } | null>(null);
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);

  const load = useCallback(async () => {
    try {
      setD(await api(`/requests/${id}`));
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }, [id, toast]);

  useEffect(() => {
    load();
    api('/users/options').then(setUsers).catch(() => undefined);
  }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    try {
      await fn();
      if (ok) toast('success', ok);
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!d) {
    return (
      <div className="flex justify-center p-10">
        <Spinner />
      </div>
    );
  }

  const r = d.request;
  const isOpen = OPEN.includes(r.status);
  const canReview = can(user, 'documents.review') && isOpen && r.status !== 'RASCUNHO';
  const canManage = can(user, 'requests.manage') && isOpen;
  const p = d.progress;

  async function openViewer(doc: any) {
    setViewDoc(doc);
    if (canReview && doc.status === 'RECEBIDO') {
      api(`/requests/${id}/documents/${doc.id}/review/start`, { method: 'POST' }).then(load).catch(() => undefined);
    }
  }

  async function docPdf(doc: any, disposition: 'inline' | 'attachment') {
    try {
      const { url } = await api(`/requests/${id}/documents/${doc.id}/pdf?disposition=${disposition}`);
      if (disposition === 'inline') window.open(url, '_blank', 'noopener');
      else window.location.href = url;
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function finalDownload(disposition: 'inline' | 'attachment') {
    try {
      const { url } = await api(`/files/${d.finalFile.id}/url?disposition=${disposition}`);
      if (disposition === 'inline') window.open(url, '_blank', 'noopener');
      else window.location.href = url;
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  const sections = groupBySection(d.documents);

  return (
    <div className="space-y-5">
      {/* Cabeçalho */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/" className="text-xs text-neutral-500 hover:underline">
            ← Painel
          </Link>
          <h1 className="text-2xl font-bold">{r.applicant_name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-neutral-600">
            <RequestStatusBadge status={r.status} />
            <span>{r.model_name}</span>
            <span>·</span>
            <span>{r.code}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage && (
            <Button
              variant="ghost"
              className="text-red-700"
              onClick={() => {
                const reason = window.prompt('Motivo do cancelamento (opcional):');
                if (reason !== null) run('cancel', () => api(`/requests/${id}/cancel`, { body: { reason } }), 'Solicitação cancelada.');
              }}
            >
              Cancelar solicitação
            </Button>
          )}
          {r.status === 'CANCELADO' && can(user, 'requests.manage') && (
            <Button onClick={() => run('reopen', () => api(`/requests/${id}/reopen`, { method: 'POST' }), 'Solicitação reaberta.')}>Reabrir</Button>
          )}
        </div>
      </div>

      {r.status === 'CANCELADO' && <Alert kind="warning">Solicitação cancelada{r.cancel_reason ? `: ${r.cancel_reason}` : '.'}</Alert>}
      {r.status === 'EXPIRADO' && <Alert kind="warning">O prazo do link expirou. Altere a expiração do link em “Editar dados” para reabrir o envio.</Alert>}

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Coluna lateral */}
        <div className="space-y-5 lg:order-2">
          <Card title="Progresso">
            <ProgressBar value={p.approved} total={p.total} />
            <p className="mt-2 text-sm font-semibold">
              {p.approved} de {p.total} documentos aprovados
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <Stat label="Recebidos" v={p.received} />
              <Stat label="Pendentes" v={p.pending} />
              <Stat label="Em conferência" v={p.inReview} />
              <Stat label="Rejeitados" v={p.rejected} danger={p.rejected > 0} />
              <Stat label="Aprovados" v={p.approved} />
              <Stat label="N/A" v={p.notApplicable} />
            </dl>
          </Card>

          <Card title="PDF final">
            {d.finalFile ? (
              <div className="space-y-2">
                <p className="text-sm">
                  <span className="font-semibold">{d.finalFile.original_name}</span>
                  <br />
                  <span className="text-xs text-neutral-500">
                    {d.finalFile.page_count} páginas · {fmtBytes(d.finalFile.size_bytes)} · {fmtDateTime(d.finalFile.created_at)}
                  </span>
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="dark" onClick={() => finalDownload('attachment')}>
                    Baixar PDF
                  </Button>
                  <Button size="sm" onClick={() => finalDownload('inline')}>
                    Visualizar
                  </Button>
                  {can(user, 'email.send') && (
                    <Button size="sm" loading={busy === 'resend'} onClick={() => run('resend', () => api(`/requests/${id}/final-pdf/email`, { method: 'POST' }), 'E-mail enviado.')}>
                      Reenviar e-mail
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-neutral-500">Ainda não gerado.</p>
            )}
            {d.blockingReason && r.status !== 'FINALIZADO' && <p className="mt-3 text-xs text-neutral-600">⏳ {d.blockingReason}</p>}
            {can(user, 'pdf.generate') && ['APROVADO', 'FINALIZADO'].includes(r.status) && (
              <div className="mt-3 space-y-2">
                <Button
                  variant="primary"
                  className="w-full"
                  disabled={!d.canGeneratePdf}
                  loading={busy === 'pdf'}
                  onClick={() =>
                    run(
                      'pdf',
                      async () => {
                        const res = await api(`/requests/${id}/final-pdf`, { body: { sendEmail: sendFinalEmail } });
                        if (res.email && !res.email.ok) toast('error', `PDF gerado, mas o e-mail falhou: ${res.email.error}`);
                        else toast('success', `PDF gerado (${res.pages} páginas)${res.email?.ok ? ' e enviado por e-mail' : ''}.`);
                      },
                    )
                  }
                >
                  {d.finalFile ? 'GERAR NOVAMENTE' : 'JUNTAR TUDO EM UM PDF'}
                </Button>
                <p className="text-xs text-neutral-500">Converte as fotos em PDF, junta tudo na ordem do checklist e salva como DOCS_NOME_DO_SOLICITANTE.pdf.</p>
                <Checkbox checked={sendFinalEmail} onChange={setSendFinalEmail} label={`Enviar por e-mail para ${r.notify_email ?? 'o e-mail padrão'}`} />
                {r.status === 'APROVADO' && d.finalFile && (
                  <Button size="sm" className="w-full" onClick={() => run('fin', () => api(`/requests/${id}/finalize`, { method: 'POST' }), 'Processo finalizado.')}>
                    Finalizar sem enviar e-mail
                  </Button>
                )}
              </div>
            )}
          </Card>

          <Card
            title="Link exclusivo"
            actions={
              d.link && canManage && !['FINALIZADO', 'CANCELADO'].includes(r.status) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm('Gerar um novo link? O link atual deixará de funcionar.'))
                      run('regen', () => api(`/requests/${id}/link`, { body: { regenerate: true } }), 'Novo link gerado.');
                  }}
                >
                  Gerar novo
                </Button>
              ) : null
            }
          >
            {d.link && ['FINALIZADO', 'CANCELADO'].includes(r.status) ? (
              <p className="text-sm text-neutral-500">Link encerrado ({r.status === 'FINALIZADO' ? 'processo finalizado' : 'solicitação cancelada'}). O solicitante ainda pode abrir para consultar{r.status === 'CANCELADO' ? ' após reabrir' : ''}.</p>
            ) : d.link ? (
              <div className="space-y-3">
                {!r.link_active && <Alert kind="warning">Link desativado.</Alert>}
                <ShareLink requestId={id} link={d.link} message={d.renderedMessage} phone={r.applicant_phone} compact />
                <dl className="space-y-1 text-xs text-neutral-600">
                  <div>Expira em: {fmtDateTime(r.link_expires_at)}</div>
                  <div>Enviado: {r.link_sent_at ? fmtDateTime(r.link_sent_at) : 'não registrado'}</div>
                  <div>Último acesso: {r.last_accessed_at ? fmtDateTime(r.last_accessed_at) : 'nunca'}</div>
                  {r.submitted_at && <div>Solicitante finalizou em {fmtDateTime(r.submitted_at)}</div>}
                </dl>
                {canManage && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => run('act', () => api(`/requests/${id}/link/active`, { body: { active: !r.link_active } }), r.link_active ? 'Link desativado.' : 'Link reativado.')}>
                      {r.link_active ? 'Desativar link' : 'Reativar link'}
                    </Button>
                    {r.applicant_email && (
                      <Button size="sm" loading={busy === 'mail'} onClick={() => run('mail', () => api(`/requests/${id}/link/email`, { method: 'POST' }), 'Link enviado por e-mail.')}>
                        Enviar por e-mail
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-neutral-500">Rascunho — o link ainda não foi gerado.</p>
                {canManage && (
                  <Button variant="primary" className="w-full" loading={busy === 'gen'} onClick={() => run('gen', () => api(`/requests/${id}/link`, { body: {} }), 'Link gerado.')}>
                    GERAR LINK
                  </Button>
                )}
              </div>
            )}
          </Card>

          <Card title="Dados" actions={canManage ? <Button size="sm" onClick={() => setEditOpen(true)}>Editar dados</Button> : null}>
            <dl className="space-y-2 text-sm">
              <Row k="Nome / Razão social" v={r.applicant_name} />
              <Row k="CPF/CNPJ" v={r.applicant_document_formatted || '—'} />
              <Row k="Tipo de pessoa" v={r.person_type === 'PJ' ? 'Pessoa jurídica' : 'Pessoa física'} />
              <Row k="Telefone" v={r.applicant_phone ?? '—'} />
              <Row k="E-mail" v={r.applicant_email ?? '—'} />
              <hr />
              <Row k="Tipo de processo" v={r.model_name} />
              <Row k="Status" v={REQUEST_STATUS[r.status]?.label ?? r.status} />
              <Row k="Responsável" v={r.responsible?.name ?? '—'} />
              <Row k="Criado em" v={fmtDateTime(r.created_at)} />
              <Row k="Prazo" v={fmtDate(r.deadline)} />
              <Row k="PDF final para" v={r.notify_email ?? 'padrão do sistema'} />
              {r.notes && <Row k="Observações" v={r.notes} />}
            </dl>
          </Card>
        </div>

        {/* Coluna principal */}
        <div className="space-y-5 lg:col-span-2">
          <Card title="Documentos" actions={canManage ? <Button size="sm" onClick={() => setAddOpen(true)}>+ Adicionar documento</Button> : null} bodyClass="p-0">
            {sections.map(([section, docs]) => (
              <div key={section ?? '_'}>
                {section && <p className="border-b bg-neutral-50 px-4 py-2 text-xs font-bold uppercase tracking-wide text-neutral-600">{section}</p>}
                <ul className="divide-y">
                  {docs.map((doc: any) => (
                    <DocRow
                      key={doc.id}
                      doc={doc}
                      canReview={canReview}
                      canManage={canManage}
                      busy={busy}
                      onView={() => openViewer(doc)}
                      onPdf={(disp) => docPdf(doc, disp)}
                      onApprove={() => run(`ap-${doc.id}`, () => api(`/requests/${id}/documents/${doc.id}/approve`, { body: {} }), `${doc.name}: aprovado.`)}
                      onReject={() => {
                        setRejectForm({ reason: 'ILEGIVEL', note: '', notifyApplicant: true });
                        setRejectDoc(doc);
                      }}
                      onToggleNa={() => {
                        if (doc.is_applicable) {
                          const reason = window.prompt(`Marcar "${doc.name}" como N/A. Motivo:`, 'Não se aplica');
                          if (reason !== null) run(`na-${doc.id}`, () => api(`/requests/${id}/documents/${doc.id}`, { method: 'PATCH', body: { notApplicable: true, naReason: reason } }));
                        } else {
                          run(`na-${doc.id}`, () => api(`/requests/${id}/documents/${doc.id}`, { method: 'PATCH', body: { notApplicable: false } }));
                        }
                      }}
                      onToggleRequired={() => run(`rq-${doc.id}`, () => api(`/requests/${id}/documents/${doc.id}`, { method: 'PATCH', body: { required: !doc.base_required } }))}
                      onRemove={() => {
                        if (window.confirm(`Remover "${doc.name}" do checklist?`)) run(`rm-${doc.id}`, () => api(`/requests/${id}/documents/${doc.id}`, { method: 'DELETE' }), 'Documento removido.');
                      }}
                      onUpload={(files, side) =>
                        run(`up-${doc.id}`, async () => {
                          const fd = new FormData();
                          files.forEach((f) => fd.append('files', f));
                          if (side) fd.append('sides', JSON.stringify(files.map(() => side)));
                          await upload(`/requests/${id}/documents/${doc.id}/files`, fd);
                        }, 'Arquivo anexado.')
                      }
                      onText={(value) => run(`tx-${doc.id}`, () => api(`/requests/${id}/documents/${doc.id}/text`, { body: { value } }), 'Informação salva.')}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </Card>

          {d.questions.length > 0 && (
            <Card title="Respostas e dados informados" actions={(canManage || canReview) ? <Button size="sm" onClick={() => setAnswersOpen(true)}>Editar respostas</Button> : null}>
              {d.unansweredQuestions.length > 0 && (
                <div className="mb-3">
                  <Alert kind="warning">Perguntas obrigatórias sem resposta: {d.unansweredQuestions.join(', ')}</Alert>
                </div>
              )}
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                {d.questions.map((q: any) => {
                  const a = d.answers.find((x: any) => x.key === q.key);
                  return (
                    <div key={q.key}>
                      <dt className="text-xs text-neutral-500">
                        {q.label} {q.answeredBy === 'INTERNAL' && <span className="text-[10px] uppercase text-neutral-400">(interno)</span>}
                      </dt>
                      <dd className="font-medium">{answerText(q, a?.value)}</dd>
                    </div>
                  );
                })}
              </dl>
            </Card>
          )}

          <Card title="Histórico">
            <ol className="relative space-y-3 border-l border-neutral-200 pl-4">
              {d.timeline.map((t: any) => (
                <li key={t.id} className="text-sm">
                  <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full bg-brand ring-2 ring-white" />
                  <p className="font-semibold">
                    {AUDIT_LABELS[t.action] ?? t.action}
                    {t.details?.name && <span className="font-normal"> — {t.details.name}</span>}
                    {t.action === 'STATUS_CHANGED' && (
                      <span className="font-normal">
                        : {REQUEST_STATUS[t.details.from]?.label ?? t.details.from} → {REQUEST_STATUS[t.details.to]?.label ?? t.details.to}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-neutral-500">
                    {fmtDateTime(t.created_at)} · {t.actor_name}
                    {t.details?.reason && ` · Motivo: ${t.details.reason}`}
                    {t.details?.note && ` · ${t.details.note}`}
                    {t.details?.to && t.action.startsWith('EMAIL') && ` · para ${t.details.to}`}
                    {t.details?.error && <span className="text-red-600"> · {t.details.error}</span>}
                    {t.details?.channel && ` · via ${t.details.channel}`}
                    {t.details?.fileName && ` · ${t.details.fileName}`}
                  </p>
                </li>
              ))}
            </ol>
          </Card>

          {d.emails.length > 0 && (
            <Card title="E-mails" bodyClass="p-0">
              <table className="min-w-full text-sm">
                <tbody className="divide-y">
                  {d.emails.map((e: any) => (
                    <tr key={e.id}>
                      <td className="px-4 py-2">
                        <p className="font-medium">{e.subject}</p>
                        <p className="text-xs text-neutral-500">
                          {e.recipient} · {fmtDateTime(e.sent_at ?? e.created_at)}
                          {e.attachments?.length ? ` · anexo: ${e.attachments.map((a: any) => a.filename).join(', ')}` : ''}
                        </p>
                        {e.error && <p className="text-xs text-red-600">{e.error}</p>}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Badge className={e.status === 'SENT' ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : e.status === 'FAILED' ? 'bg-red-50 text-red-800 ring-red-200' : 'bg-neutral-100 ring-neutral-300'}>
                          {e.status === 'SENT' ? 'Enviado' : e.status === 'FAILED' ? 'Falhou' : 'Pendente'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      </div>

      {/* Visualizar documento */}
      <Modal open={!!viewDoc} onClose={() => setViewDoc(null)} title={viewDoc?.name ?? ''} wide
        footer={
          viewDoc && canReview && ['RECEBIDO', 'EM_ANALISE'].includes(current(d, viewDoc)?.status) ? (
            <>
              <Button variant="danger" onClick={() => { setRejectForm({ reason: 'ILEGIVEL', note: '', notifyApplicant: true }); setRejectDoc(viewDoc); setViewDoc(null); }}>
                REJEITAR
              </Button>
              <Button variant="success" loading={busy === `ap-${viewDoc.id}`} onClick={() => run(`ap-${viewDoc.id}`, () => api(`/requests/${id}/documents/${viewDoc.id}/approve`, { body: {} }), `${viewDoc.name}: aprovado.`).then(() => setViewDoc(null))}>
                APROVAR
              </Button>
            </>
          ) : undefined
        }
      >
        {viewDoc && (
          <div className="space-y-3">
            {viewDoc.na_requested && <Alert kind="info">O solicitante informou que este documento não se aplica: “{viewDoc.applicant_note}”</Alert>}
            {viewDoc.kind === 'TEXT' && <Alert kind="info">Informação: {viewDoc.text_value ?? '—'}</Alert>}
            {viewDoc.applicant_note && !viewDoc.na_requested && <p className="text-sm text-neutral-600">Observação do solicitante: {viewDoc.applicant_note}</p>}
            {viewDoc.kind === 'FILE' && <FileViewer files={viewDoc.files.filter((f: any) => f.is_current)} />}
            {viewDoc.files.some((f: any) => !f.is_current) && (
              <details className="text-sm">
                <summary className="cursor-pointer text-neutral-600">Envios anteriores (histórico)</summary>
                <div className="mt-2">
                  <FileViewer files={viewDoc.files.filter((f: any) => !f.is_current)} />
                </div>
              </details>
            )}
          </div>
        )}
      </Modal>

      {/* Rejeitar */}
      <Modal
        open={!!rejectDoc}
        onClose={() => setRejectDoc(null)}
        title={`Rejeitar: ${rejectDoc?.name ?? ''}`}
        footer={
          <>
            <Button onClick={() => setRejectDoc(null)}>Voltar</Button>
            <Button
              variant="danger"
              loading={busy === 'reject'}
              onClick={() =>
                run('reject', async () => {
                  const docName = rejectDoc.name;
                  const res = await api(`/requests/${id}/documents/${rejectDoc.id}/reject`, { body: { ...rejectForm, note: rejectForm.note || null } });
                  if (res.whatsapp?.sent) toast('success', 'Documento rejeitado. Candidato avisado pelo WhatsApp.');
                  else {
                    toast('success', 'Documento rejeitado. O solicitante poderá reenviar.');
                    if (res.whatsapp && !res.whatsapp.sent) toast('error', `WhatsApp automático falhou: ${res.whatsapp.error}`);
                    if (res.whatsappLink) setWaNotice({ link: res.whatsappLink, doc: docName });
                  }
                }).then(() => setRejectDoc(null))
              }
            >
              REJEITAR
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Motivo" required>
            <div className="grid grid-cols-2 gap-2">
              {REJECTION_REASONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setRejectForm((f) => ({ ...f, reason: o.value }))}
                  className={cx('rounded-md px-3 py-2 text-left text-sm ring-1 ring-inset', rejectForm.reason === o.value ? 'bg-red-600 text-white ring-red-600' : 'bg-white ring-neutral-300')}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Observação para o solicitante" required={rejectForm.reason === 'OUTRO'}>
            <Textarea value={rejectForm.note} placeholder="Ex.: Envie uma nova foto com melhor qualidade." onChange={(e) => setRejectForm((f) => ({ ...f, note: e.target.value }))} />
          </Field>
          {r.applicant_phone ? (
            <p className="text-xs text-neutral-500">O candidato será avisado pelo WhatsApp ({r.applicant_phone}).</p>
          ) : (
            <p className="text-xs text-amber-700">Sem telefone cadastrado: cadastre em “Editar dados” para avisar pelo WhatsApp.</p>
          )}
          {r.applicant_email && <Checkbox checked={rejectForm.notifyApplicant} onChange={(v) => setRejectForm((f) => ({ ...f, notifyApplicant: v }))} label={`Avisar ${r.applicant_email} por e-mail`} />}
        </div>
      </Modal>

      <Modal
        open={!!waNotice}
        onClose={() => setWaNotice(null)}
        title="Avisar o candidato pelo WhatsApp"
        footer={
          <>
            <Button onClick={() => setWaNotice(null)}>Agora não</Button>
            <a
              href={waNotice?.link}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setWaNotice(null)}
              className="inline-flex items-center justify-center rounded-md bg-emerald-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
            >
              Abrir WhatsApp
            </a>
          </>
        }
      >
        <p className="text-sm text-neutral-700">
          O WhatsApp vai abrir com a mensagem pronta para {r.applicant_name}, avisando que “{waNotice?.doc}” precisa ser reenviado, com o motivo e o link. É só tocar em enviar.
        </p>
      </Modal>

      <EditRequestModal open={editOpen} onClose={() => setEditOpen(false)} r={r} users={users} onSave={(body) => run('edit', () => api(`/requests/${id}`, { method: 'PATCH', body }), 'Dados atualizados.').then(() => setEditOpen(false))} />
      <AnswersModal open={answersOpen} onClose={() => setAnswersOpen(false)} questions={d.questions} answers={d.answers} onSave={(answers) => run('ans', () => api(`/requests/${id}/answers`, { method: 'PUT', body: { answers } }), 'Respostas salvas.').then(() => setAnswersOpen(false))} />
      <AddDocumentModal open={addOpen} onClose={() => setAddOpen(false)} onSave={(body) => run('add', () => api(`/requests/${id}/documents`, { body }), 'Documento adicionado.').then(() => setAddOpen(false))} />
    </div>
  );
}

function current(d: Detail, doc: any) {
  return d.documents.find((x: any) => x.id === doc.id);
}

function groupBySection(docs: any[]): Array<[string | null, any[]]> {
  const out: Array<[string | null, any[]]> = [];
  for (const doc of docs) {
    const last = out[out.length - 1];
    if (last && last[0] === (doc.section ?? null)) last[1].push(doc);
    else out.push([doc.section ?? null, [doc]]);
  }
  return out;
}

function Stat({ label, v, danger }: { label: string; v: number; danger?: boolean }) {
  return (
    <div className="rounded-md bg-neutral-50 px-2 py-1.5">
      <dt className="text-[11px] uppercase text-neutral-500">{label}</dt>
      <dd className={cx('text-lg font-bold', danger && 'text-red-600')}>{v}</dd>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-neutral-500">{k}</dt>
      <dd className="text-right font-medium">{v}</dd>
    </div>
  );
}

function DocRow(props: {
  doc: any;
  canReview: boolean;
  canManage: boolean;
  busy: string | null;
  onView: () => void;
  onPdf: (d: 'inline' | 'attachment') => void;
  onApprove: () => void;
  onReject: () => void;
  onToggleNa: () => void;
  onToggleRequired: () => void;
  onRemove: () => void;
  onUpload: (files: File[], side: 'FRONT' | 'BACK' | null) => void;
  onText: (v: string) => void;
}) {
  const { doc, canReview, canManage, busy } = props;
  const fileRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState(false);
  const currentFiles = doc.files.filter((f: any) => f.is_current);
  const hasContent = currentFiles.length > 0 || doc.text_value || doc.na_requested;
  const reviewable = canReview && doc.is_applicable && ['RECEBIDO', 'EM_ANALISE'].includes(doc.status);

  return (
    <li className={cx('px-4 py-3', !doc.is_applicable && 'bg-neutral-50')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-neutral-400">{String(doc.position).padStart(2, '0')}</span>
            <span className={cx('font-semibold', !doc.is_applicable && 'text-neutral-400 line-through')}>{doc.name}</span>
            <DocStatusBadge status={doc.status} na={!doc.is_applicable} />
            {!doc.required && doc.is_applicable && <Badge className="bg-white text-neutral-500 ring-neutral-300">Opcional</Badge>}
            {doc.both_sides && <Badge className="bg-white text-neutral-500 ring-neutral-300">Frente e verso</Badge>}
            {doc.kind === 'FILE' && doc.accept === 'PDF' && <Badge className="bg-white text-neutral-500 ring-neutral-300">Somente PDF</Badge>}
            {doc.kind === 'FILE' && doc.accept === 'IMAGE' && <Badge className="bg-white text-neutral-500 ring-neutral-300">Somente foto</Badge>}
            {doc.kind === 'TEXT' && <Badge className="bg-violet-50 text-violet-800 ring-violet-200">Texto</Badge>}
            {doc.is_custom && <Badge className="bg-brand-100 text-ink ring-brand-500">Adicionado</Badge>}
            {doc.na_requested && <Badge className="bg-amber-50 text-amber-800 ring-amber-300">Solicitante: não se aplica</Badge>}
          </div>
          {!doc.is_applicable && doc.na_reason && <p className="mt-0.5 text-xs text-neutral-500">{doc.na_reason}</p>}
          {doc.kind === 'TEXT' && doc.text_value && <p className="mt-1 text-sm">“{doc.text_value}”</p>}
          {doc.na_requested && <p className="mt-1 text-sm text-amber-800">Justificativa: {doc.applicant_note}</p>}
          {currentFiles.length > 0 && (
            <p className="mt-1 text-xs text-neutral-500">
              {currentFiles.map((f: any) => `${f.side === 'FRONT' ? 'Frente: ' : f.side === 'BACK' ? 'Verso: ' : ''}${f.original_name}`).join(' · ')}
            </p>
          )}
          <p className="mt-0.5 text-xs text-neutral-500">
            {doc.submitted_at && <>Enviado {fmtDateTime(doc.submitted_at)}</>}
            {doc.submission_count > 1 && <> · {doc.submission_count}º envio</>}
            {doc.reviewed_at && (
              <>
                {' '}
                · Conferido {fmtDateTime(doc.reviewed_at)} por {doc.reviewed_by_name}
              </>
            )}
          </p>
          {doc.status === 'REJEITADO' && (
            <p className="mt-1 text-xs text-red-700">
              Rejeitado: {REJECTION_REASONS.find((x) => x.value === doc.rejection_reason)?.label}
              {doc.rejection_note && ` — ${doc.rejection_note}`}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {(hasContent || doc.files.length > 0) && (
            <Button size="sm" variant="dark" onClick={props.onView}>
              Visualizar
            </Button>
          )}
          {doc.kind === 'FILE' && currentFiles.length > 0 && (
            <Button size="sm" onClick={() => props.onPdf('attachment')} title="PDF do documento (frente e verso juntos)">
              Baixar
            </Button>
          )}
          {reviewable && (
            <>
              <Button size="sm" variant="success" loading={busy === `ap-${doc.id}`} onClick={props.onApprove}>
                Aprovar
              </Button>
              <Button size="sm" variant="danger" onClick={props.onReject}>
                Rejeitar
              </Button>
            </>
          )}
          {canReview && doc.status === 'APROVADO' && (
            <Button size="sm" variant="ghost" className="text-red-700" onClick={props.onReject}>
              Rejeitar
            </Button>
          )}
          {canManage && (
            <div className="relative">
              <Button size="sm" variant="ghost" onClick={() => setMenu((v) => !v)} aria-label="Mais ações">
                ⋯
              </Button>
              {menu && (
                <div className="absolute right-0 z-20 mt-1 w-56 rounded-md bg-white py-1 text-sm shadow-lg ring-1 ring-neutral-200" onMouseLeave={() => setMenu(false)}>
                  {doc.kind === 'FILE' && doc.is_applicable && doc.status !== 'APROVADO' && (
                    <MenuItem onClick={() => { setMenu(false); fileRef.current?.click(); }}>Anexar arquivo (recebido por outro canal)</MenuItem>
                  )}
                  {doc.kind === 'TEXT' && doc.is_applicable && doc.status !== 'APROVADO' && (
                    <MenuItem onClick={() => { setMenu(false); const v = window.prompt(doc.name, doc.text_value ?? ''); if (v) props.onText(v); }}>Preencher informação</MenuItem>
                  )}
                  <MenuItem onClick={() => { setMenu(false); props.onToggleRequired(); }}>{doc.base_required ? 'Tornar opcional' : 'Tornar obrigatório'}</MenuItem>
                  <MenuItem onClick={() => { setMenu(false); props.onToggleNa(); }}>{doc.is_applicable ? 'Marcar como N/A' : 'Voltar a solicitar'}</MenuItem>
                  {!hasContent && doc.files.length === 0 && <MenuItem danger onClick={() => { setMenu(false); props.onRemove(); }}>Remover do checklist</MenuItem>}
                </div>
              )}
              <input
                ref={fileRef}
                type="file"
                multiple={doc.allow_multiple}
                accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  if (files.length) props.onUpload(files, null);
                }}
              />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={cx('block w-full px-3 py-2 text-left hover:bg-neutral-50', danger && 'text-red-700')}>
      {children}
    </button>
  );
}

function EditRequestModal({ open, onClose, r, users, onSave }: { open: boolean; onClose: () => void; r: any; users: any[]; onSave: (b: any) => void }) {
  const [f, setF] = useState<any>(null);
  useEffect(() => {
    if (open)
      setF({
        name: r.applicant_name,
        document: maskDocInput(r.applicant_document ?? ''),
        phone: r.applicant_phone ?? '',
        email: r.applicant_email ?? '',
        notifyEmail: r.notify_email ?? '',
        notes: r.notes ?? '',
        responsibleUserId: r.responsible_user_id ?? '',
        deadline: r.deadline ?? '',
        message: r.message ?? '',
        linkExpiresAt: r.link_expires_at ? new Date(r.link_expires_at).toISOString().slice(0, 10) : '',
      });
  }, [open, r]);
  if (!f) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Editar dados da solicitação"
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="dark"
            onClick={() =>
              onSave({
                applicant: { name: f.name, document: f.document || null, phone: f.phone || null, email: f.email || null },
                notifyEmail: f.notifyEmail || null,
                notes: f.notes || null,
                responsibleUserId: f.responsibleUserId || null,
                deadline: f.deadline || null,
                message: f.message || null,
                ...(r.link_generated_at ? { linkExpiresAt: f.linkExpiresAt ? new Date(`${f.linkExpiresAt}T23:59:59-03:00`).toISOString() : null } : {}),
              })
            }
          >
            Salvar
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nome / Razão social">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="CPF/CNPJ">
          <Input value={f.document} onChange={(e) => setF({ ...f, document: maskDocInput(e.target.value) })} />
        </Field>
        <Field label="Telefone">
          <Input value={f.phone} onChange={(e) => setF({ ...f, phone: maskPhone(e.target.value) })} />
        </Field>
        <Field label="E-mail do solicitante">
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label="E-mail para o PDF final">
          <Input type="email" value={f.notifyEmail} onChange={(e) => setF({ ...f, notifyEmail: e.target.value })} />
        </Field>
        <Field label="Responsável">
          <Select value={f.responsibleUserId} onChange={(e) => setF({ ...f, responsibleUserId: e.target.value })}>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Prazo">
          <Input type="date" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} />
        </Field>
        {r.link_generated_at && (
          <Field label="Link expira em" hint="Vazio = sem expiração">
            <Input type="date" value={f.linkExpiresAt} onChange={(e) => setF({ ...f, linkExpiresAt: e.target.value })} />
          </Field>
        )}
        <div className="sm:col-span-2">
          <Field label="Observações internas">
            <Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Mensagem ao solicitante">
            <Textarea value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} className="min-h-[160px]" />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function AnswersModal({ open, onClose, questions, answers, onSave }: { open: boolean; onClose: () => void; questions: any[]; answers: any[]; onSave: (a: Record<string, unknown>) => void }) {
  const [vals, setVals] = useState<Record<string, unknown>>({});
  useEffect(() => {
    if (open) setVals(Object.fromEntries(answers.map((a) => [a.key, a.value])));
  }, [open, answers]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Respostas"
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="dark"
            onClick={() => {
              const out: Record<string, unknown> = {};
              for (const q of questions) {
                const before = answers.find((a) => a.key === q.key)?.value ?? null;
                const now = vals[q.key] === '' ? null : vals[q.key] ?? null;
                if (JSON.stringify(before) !== JSON.stringify(now)) out[q.key] = now;
              }
              onSave(out);
            }}
          >
            Salvar
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {questions.map((q) => (
          <Field key={q.key} label={q.label} hint={q.helpText} required={q.required}>
            <QuestionInput q={q} value={vals[q.key]} onChange={(v) => setVals((x) => ({ ...x, [q.key]: v }))} />
          </Field>
        ))}
      </div>
    </Modal>
  );
}

function AddDocumentModal({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (b: any) => void }) {
  const [f, setF] = useState<any>({ name: '', description: '', kind: 'FILE', required: true, bothSides: false, allowMultiple: false, accept: 'ANY' });
  useEffect(() => {
    if (open) setF({ name: '', description: '', kind: 'FILE', required: true, bothSides: false, allowMultiple: false, accept: 'ANY' });
  }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Adicionar documento"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="dark" disabled={!f.name.trim()} onClick={() => onSave({ ...f, description: f.description || null })}>
            Adicionar
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Nome" required>
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
        </Field>
        <Field label="Instruções (opcional)">
          <Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Tipo">
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="FILE">Arquivo</option>
            <option value="TEXT">Informação (texto)</option>
          </Select>
        </Field>
        <div className="flex flex-wrap gap-4">
          <Checkbox checked={f.required} onChange={(v) => setF({ ...f, required: v })} label="Obrigatório" />
          {f.kind === 'FILE' && <Checkbox checked={f.bothSides} onChange={(v) => setF({ ...f, bothSides: v })} label="Frente e verso" />}
          {f.kind === 'FILE' && <AcceptSelect value={f.accept} onChange={(v) => setF({ ...f, accept: v })} />}
          {f.kind === 'FILE' && <Checkbox checked={f.allowMultiple} onChange={(v) => setF({ ...f, allowMultiple: v })} label="Vários arquivos" />}
        </div>
      </div>
    </Modal>
  );
}
