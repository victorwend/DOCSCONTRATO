'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, upload } from '@/lib/api';
import { fmtBytes, fmtDate } from '@/lib/format';
import { QuestionInput } from '@/components/QuestionInput';
import { Alert, Button, cx, Modal, Spinner, Textarea, useToast } from '@/components/ui';

type Portal = any;
type Doc = any;

const STATUS_UI: Record<string, { icon: string; text: string; cls: string }> = {
  PENDENTE: { icon: '🟡', text: 'Pendente', cls: 'text-amber-700' },
  RECEBIDO: { icon: '🟢', text: 'Documento recebido', cls: 'text-emerald-700' },
  EM_ANALISE: { icon: '🔵', text: 'Em conferência', cls: 'text-sky-700' },
  APROVADO: { icon: '✅', text: 'Aprovado', cls: 'text-emerald-700' },
  REJEITADO: { icon: '❌', text: 'Rejeitado — envie novamente', cls: 'text-red-700' },
};

export default function PortalPage() {
  const { token } = useParams<{ token: string }>();
  const toast = useToast();
  const [data, setData] = useState<Portal | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<any | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showMsg, setShowMsg] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api(`/portal/${token}`));
    } catch (e) {
      setFatal((e as ApiError).message);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  async function submit() {
    setSubmitting(true);
    try {
      const r = await api(`/portal/${token}/submit`, { method: 'POST' });
      setSubmitResult(r);
      if (r.ok) window.scrollTo({ top: 0, behavior: 'smooth' });
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (fatal) {
    return (
      <Shell>
        <div className="rounded-xl bg-white p-6 text-center shadow-card">
          <p className="text-4xl">🔒</p>
          <p className="mt-3 text-lg font-bold">Não foi possível abrir este link</p>
          <p className="mt-2 text-neutral-600">{fatal}</p>
        </div>
      </Shell>
    );
  }
  if (!data) {
    return (
      <Shell>
        <div className="flex justify-center p-10">
          <Spinner className="h-8 w-8" />
        </div>
      </Shell>
    );
  }

  const done = ['APROVADO', 'FINALIZADO'].includes(data.status);
  const p = data.progress;
  const sections: Array<[string | null, Doc[]]> = [];
  for (const d of data.documents) {
    const last = sections[sections.length - 1];
    if (last && last[0] === (d.section ?? null)) last[1].push(d);
    else sections.push([d.section ?? null, [d]]);
  }
  const longMsg = (data.message ?? '').length > 420;

  return (
    <Shell title={data.title}>
      <div className="space-y-4">
        <section className="rounded-xl bg-white p-5 shadow-card">
          <p className="text-xl font-bold">Olá, {data.applicantName.split(' ')[0]}.</p>
          {data.message ? (
            <div className="mt-3">
              <div className="relative">
                <div className={cx('whitespace-pre-wrap text-[15px] leading-relaxed text-neutral-700', longMsg && !showMsg && 'max-h-48 overflow-hidden')}>{data.message}</div>
                {longMsg && !showMsg && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-white" />}
              </div>
              {longMsg && (
                <button className="mt-2 text-sm font-semibold underline" onClick={() => setShowMsg((v) => !v)}>
                  {showMsg ? 'Mostrar menos' : 'Ler mensagem completa'}
                </button>
              )}
            </div>
          ) : (
            <p className="mt-2 text-neutral-700">Para dar continuidade ao processo, precisamos dos documentos abaixo.</p>
          )}
          <div className="mt-4 rounded-lg bg-brand-50 p-3 text-sm text-neutral-800 ring-1 ring-brand-500/40">
            📷 Envie arquivos <b>completos, nítidos e legíveis</b> (PDF, JPG ou PNG, até {data.maxUploadMb} MB). Não envie fotos cortadas ou escuras.
          </div>
          {data.deadline && !done && <p className="mt-3 text-sm text-neutral-600">Prazo: <b>{fmtDate(data.deadline)}</b></p>}
        </section>

        {done && (
          <Alert kind="success">
            <b>Documentação conferida.</b> Obrigado! A Pavidez Engenharia entrará em contato com os próximos passos.
          </Alert>
        )}
        {submitResult?.ok && !done && (
          <Alert kind="success">
            <b>Envio finalizado!</b> Recebemos seus documentos. Se algum precisar de correção, avisaremos e ele aparecerá aqui como ❌ para reenviar.
          </Alert>
        )}

        <section className="rounded-xl bg-white p-5 shadow-card">
          <p className="text-xs font-bold uppercase tracking-wider text-neutral-500">Documentação</p>
          <div className="mt-2 h-4 w-full overflow-hidden rounded-full bg-neutral-200">
            <div className={cx('h-full rounded-full transition-all', p.received === p.total ? 'bg-emerald-500' : 'bg-ink')} style={{ width: `${p.total ? (p.received / p.total) * 100 : 0}%` }} />
          </div>
          <p className="mt-2 text-sm font-semibold">
            {p.received} de {p.total} documentos enviados
          </p>
          <p className="text-xs text-neutral-500">
            {p.approved} aprovados{p.rejected > 0 && <span className="font-semibold text-red-600"> · {p.rejected} para reenviar</span>}
          </p>
        </section>

        {data.questions.length > 0 && <Questions token={token} data={data} disabled={!data.accepting} onSaved={load} />}

        {sections.map(([section, docs]) => (
          <div key={section ?? '_'} className="space-y-3">
            {section && <h2 className="px-1 pt-2 text-sm font-bold uppercase tracking-wide text-neutral-600">{section}</h2>}
            {docs.map((d) => (
              <DocumentCard key={d.id} token={token} doc={d} accepting={data.accepting} maxMb={data.maxUploadMb} onChange={load} />
            ))}
          </div>
        ))}

        {data.accepting && (
          <section className="sticky bottom-0 -mx-4 border-t bg-white/95 px-4 py-3 backdrop-blur">
            {submitResult && !submitResult.ok && (
              <div className="mb-2">
                <Alert kind="warning">
                  Ainda falta:
                  <ul className="ml-4 list-disc">
                    {submitResult.unanswered?.map((x: string) => <li key={x}>{x}</li>)}
                    {submitResult.missing?.map((x: string) => <li key={x}>{x}</li>)}
                  </ul>
                </Alert>
              </div>
            )}
            <Button variant="dark" size="lg" className="w-full" onClick={submit} loading={submitting}>
              {data.submittedAt ? 'ATUALIZAR ENVIO' : 'FINALIZAR ENVIO'}
            </Button>
          </section>
        )}
        <p className="pb-6 text-center text-xs text-neutral-400">
          {data.company} · Protocolo {data.code}
          <br />
          Seus dados são usados somente para este processo, conforme a LGPD.
        </p>
      </div>
    </Shell>
  );
}

function Shell({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div className="min-h-screen bg-neutral-100">
      <header className="border-b-4 border-brand bg-white">
        <div className="mx-auto flex max-w-xl flex-col items-center px-4 py-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-pavidez.png" alt="Pavidez Engenharia" className="h-12 w-auto" />
          <p className="mt-2 text-xs font-bold tracking-[0.2em] text-neutral-700">PAVIDEZ ENGENHARIA</p>
          {title && <p className="mt-1 text-center text-sm font-bold uppercase text-ink">{title}</p>}
        </div>
      </header>
      <main className="mx-auto max-w-xl px-4 py-4">{children}</main>
    </div>
  );
}

function Questions({ token, data, disabled, onSaved }: { token: string; data: Portal; disabled: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [vals, setVals] = useState<Record<string, unknown>>(() => Object.fromEntries(data.questions.map((q: any) => [q.key, q.value])));
  const [saving, setSaving] = useState<string | null>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  function change(q: any, v: unknown) {
    setVals((x) => ({ ...x, [q.key]: v }));
    clearTimeout(timers.current[q.key]);
    timers.current[q.key] = setTimeout(
      async () => {
        setSaving(q.key);
        try {
          await api(`/portal/${token}/answers`, { method: 'PUT', body: { answers: { [q.key]: v === '' ? null : v } } });
          onSaved();
        } catch (e) {
          toast('error', (e as Error).message);
        } finally {
          setSaving(null);
        }
      },
      q.type === 'BOOLEAN' || q.type === 'SELECT' ? 0 : 700,
    );
  }

  let lastSection: string | null = null;
  return (
    <section className="space-y-4 rounded-xl bg-white p-5 shadow-card">
      <p className="text-xs font-bold uppercase tracking-wider text-neutral-500">Informações</p>
      {data.questions.map((q: any) => {
        const header = q.section && q.section !== lastSection ? q.section : null;
        lastSection = q.section ?? lastSection;
        return (
          <div key={q.key}>
            {header && <p className="mb-2 mt-2 text-sm font-bold text-neutral-700">{header}</p>}
            <p className="mb-1.5 text-[15px] font-medium">
              {q.label}
              {q.required && <span className="text-red-600"> *</span>}
              {saving === q.key && <span className="ml-2 text-xs text-neutral-400">salvando…</span>}
            </p>
            {q.helpText && <p className="mb-1.5 text-xs text-neutral-500">{q.helpText}</p>}
            <QuestionInput q={q} value={vals[q.key]} onChange={(v) => change(q, v)} large disabled={disabled} />
          </div>
        );
      })}
    </section>
  );
}

function DocumentCard({ token, doc, accepting, maxMb, onChange }: { token: string; doc: Doc; accepting: boolean; maxMb: number; onChange: () => Promise<void> | void }) {
  const toast = useToast();
  const [progress, setProgress] = useState<number | null>(null);
  const [text, setText] = useState(doc.textValue ?? '');
  const [naOpen, setNaOpen] = useState(false);
  const [naText, setNaText] = useState('');
  const [busy, setBusy] = useState(false);
  const camRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingSide, setPendingSide] = useState<'FRONT' | 'BACK' | null>(null);

  const ui = STATUS_UI[doc.status] ?? STATUS_UI.PENDENTE;
  const canSend = accepting && !doc.awaitingAnswer && ['PENDENTE', 'RECEBIDO', 'REJEITADO'].includes(doc.status);
  const front = doc.files.find((f: any) => f.side === 'FRONT');
  const back = doc.files.find((f: any) => f.side === 'BACK');
  const allowPhoto = doc.accept !== 'PDF';
  const allowPdf = doc.accept !== 'IMAGE';
  const acceptAttr = doc.accept === 'PDF' ? '.pdf,application/pdf' : doc.accept === 'IMAGE' ? '.jpg,.jpeg,.png,image/jpeg,image/png' : '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';

  async function send(files: File[], side: 'FRONT' | 'BACK' | null) {
    const tooBig = files.find((f) => f.size > maxMb * 1024 * 1024);
    const isPdf = (f: File) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
    if (doc.accept === 'PDF' && files.some((f) => !isPdf(f))) return toast('error', 'Este documento aceita somente arquivo PDF.');
    if (doc.accept === 'IMAGE' && files.some(isPdf)) return toast('error', 'Este documento aceita somente foto (JPG ou PNG).');
    if (tooBig) return toast('error', `"${tooBig.name}" é maior que ${maxMb} MB.`);
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f, f.name || 'foto.jpg'));
    if (side) fd.append('sides', JSON.stringify(files.map(() => side)));
    setProgress(0);
    try {
      await upload(`/portal/${token}/documents/${doc.id}/files`, fd, setProgress);
      toast('success', `${doc.name}: recebido.`);
      await onChange();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setProgress(null);
    }
  }

  function pick(kind: 'camera' | 'file', side: 'FRONT' | 'BACK' | null) {
    setPendingSide(side);
    (kind === 'camera' ? camRef : fileRef).current?.click();
  }

  function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length) send(files, pendingSide);
  }

  async function removeFile(fileId: string) {
    setBusy(true);
    try {
      await api(`/portal/${token}/documents/${doc.id}/files/${fileId}`, { method: 'DELETE' });
      await onChange();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveText() {
    setBusy(true);
    try {
      await api(`/portal/${token}/documents/${doc.id}/text`, { body: { value: text } });
      toast('success', 'Informação salva.');
      await onChange();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendNa() {
    setBusy(true);
    try {
      await api(`/portal/${token}/documents/${doc.id}/not-applicable`, { body: { justification: naText } });
      setNaOpen(false);
      await onChange();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={cx('rounded-xl bg-white p-4 shadow-card ring-1', doc.status === 'REJEITADO' ? 'ring-2 ring-red-400' : 'ring-neutral-200', doc.awaitingAnswer && 'opacity-60')}>
      <div className="flex items-start gap-3">
        <span className="text-xl leading-none" aria-hidden>
          {doc.awaitingAnswer ? '⚪' : ui.icon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold leading-snug">
            {doc.name}
            {!doc.required && <span className="ml-1 text-xs font-normal text-neutral-500">(se houver)</span>}
          </h3>
          {doc.description && <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-600">{doc.description}</p>}
          <p className={cx('mt-1 text-sm font-semibold', doc.awaitingAnswer ? 'text-neutral-500' : ui.cls)}>
            {doc.awaitingAnswer ? 'Responda as perguntas acima para saber se é necessário' : doc.naRequested && doc.status !== 'REJEITADO' ? '🟢 Informado: não se aplica' : ui.text}
          </p>
        </div>
      </div>

      {doc.rejection && (
        <div className="mt-3 rounded-lg bg-red-50 p-3 text-sm ring-1 ring-red-200">
          <p>
            <b>Motivo:</b> {doc.rejection.reason}
          </p>
          {doc.rejection.note && (
            <p className="mt-1">
              <b>Observação:</b> {doc.rejection.note}
            </p>
          )}
        </div>
      )}

      {doc.naRequested && doc.applicantNote && <p className="mt-2 text-sm text-neutral-600">Sua justificativa: “{doc.applicantNote}”</p>}

      {doc.files.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {doc.files.map((f: any) => (
            <li key={f.id} className="flex items-center justify-between gap-2 rounded-md bg-neutral-50 px-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                📎 {f.side === 'FRONT' ? 'Frente — ' : f.side === 'BACK' ? 'Verso — ' : ''}
                {f.name} <span className="text-xs text-neutral-500">({fmtBytes(f.size)})</span>
              </span>
              {accepting && doc.status === 'RECEBIDO' && (
                <button className="shrink-0 text-xs font-semibold text-red-700" disabled={busy} onClick={() => removeFile(f.id)}>
                  Remover
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {progress !== null && (
        <div className="mt-3">
          <div className="h-2 overflow-hidden rounded-full bg-neutral-200">
            <div className="h-full bg-brand-500 transition-all" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-1 text-xs text-neutral-500">Enviando… {progress}%</p>
        </div>
      )}

      {canSend && progress === null && doc.kind === 'TEXT' && (
        <div className="mt-3 space-y-2">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-[56px] text-base" placeholder="Digite aqui" />
          <Button variant="primary" size="lg" className="w-full" onClick={saveText} loading={busy} disabled={!text.trim()}>
            {doc.status === 'PENDENTE' ? 'ENVIAR' : 'ATUALIZAR'}
          </Button>
        </div>
      )}

      {canSend && progress === null && doc.kind === 'FILE' && doc.status === 'RECEBIDO' && !doc.allowMultiple && !doc.bothSides && (
        <div className="mt-2 text-center">
          <button className="text-sm font-semibold underline" onClick={() => pick('file', null)}>
            Substituir arquivo
          </button>
          <input ref={fileRef} type="file" accept={acceptAttr} className="hidden" onChange={onFiles} />
        </div>
      )}

      {canSend && progress === null && doc.kind === 'FILE' && !(doc.status === 'RECEBIDO' && !doc.allowMultiple && !doc.bothSides) && (
        <div className="mt-3 space-y-2">
          {doc.bothSides ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <SideButton label="FRENTE" done={!!front} camera={allowPhoto} fileLabel={allowPdf ? 'Arquivo' : 'Galeria'} onCamera={() => pick('camera', 'FRONT')} onFile={() => pick('file', 'FRONT')} />
                <SideButton label="VERSO" done={!!back} camera={allowPhoto} fileLabel={allowPdf ? 'Arquivo' : 'Galeria'} onCamera={() => pick('camera', 'BACK')} onFile={() => pick('file', 'BACK')} />
              </div>
              {allowPdf && (
                <button className="w-full text-center text-xs font-semibold text-neutral-600 underline" onClick={() => pick('file', null)}>
                  Tenho um PDF com frente e verso
                </button>
              )}
            </>
          ) : (
            <div className={cx('grid gap-2', allowPhoto ? 'grid-cols-2' : 'grid-cols-1')}>
              {allowPhoto && (
                <Button variant="primary" size="lg" onClick={() => pick('camera', null)}>
                  📷 Tirar foto
                </Button>
              )}
              <Button variant="dark" size="lg" onClick={() => pick('file', null)}>
                {doc.status === 'REJEITADO' ? 'REENVIAR' : doc.files.length && doc.allowMultiple ? '+ ARQUIVO' : 'ENVIAR'}
              </Button>
            </div>
          )}
          <p className="text-center text-xs text-neutral-500">
            {doc.accept === 'PDF' ? 'Envie somente arquivo PDF.' : doc.accept === 'IMAGE' ? 'Envie somente foto (JPG ou PNG).' : 'Foto (JPG/PNG) ou PDF.'}
            {doc.allowMultiple && !doc.bothSides && ` Você pode enviar vários arquivos (até ${doc.maxFiles}).`}
          </p>
          <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFiles} />
          <input ref={fileRef} type="file" accept={acceptAttr} multiple={doc.allowMultiple && !pendingSide} className="hidden" onChange={onFiles} />
        </div>
      )}

      {canSend && progress === null && !doc.isCombined && !doc.naRequested && doc.status !== 'RECEBIDO' && (
        <button className="mt-3 w-full text-center text-xs text-neutral-500 underline" onClick={() => setNaOpen(true)}>
          Não se aplica / não possuo este documento
        </button>
      )}

      <Modal
        open={naOpen}
        onClose={() => setNaOpen(false)}
        title={doc.name}
        footer={
          <>
            <Button onClick={() => setNaOpen(false)}>Voltar</Button>
            <Button variant="dark" onClick={sendNa} loading={busy} disabled={naText.trim().length < 3}>
              Enviar
            </Button>
          </>
        }
      >
        <p className="mb-2 text-sm text-neutral-600">Explique por que este documento não se aplica. A Pavidez vai conferir.</p>
        <Textarea value={naText} onChange={(e) => setNaText(e.target.value)} className="text-base" placeholder='Ex.: "Não possuo inscrição estadual"' />
      </Modal>
    </article>
  );
}

function SideButton({ label, done, camera, fileLabel, onCamera, onFile }: { label: string; done: boolean; camera: boolean; fileLabel: string; onCamera: () => void; onFile: () => void }) {
  return (
    <div className={cx('rounded-lg p-2 ring-1 ring-inset', done ? 'bg-emerald-50 ring-emerald-300' : 'bg-neutral-50 ring-neutral-200')}>
      <p className="mb-2 text-center text-xs font-bold">
        {label} {done && '✓'}
      </p>
      <div className="grid gap-1.5">
        {camera && (
          <Button variant="primary" onClick={onCamera}>
            📷 Foto
          </Button>
        )}
        <Button onClick={onFile}>{fileLabel}</Button>
      </div>
    </div>
  );
}
