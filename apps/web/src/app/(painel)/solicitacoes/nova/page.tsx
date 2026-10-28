'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { maskDocInput, maskPhone, todayPlus } from '@/lib/format';
import { useUser } from '@/components/session';
import { QuestionInput } from '@/components/QuestionInput';
import { ShareLink } from '@/components/ShareLink';
import { Alert, Badge, Button, Card, Checkbox, cx, EmptyState, Field, Input, Select, Spinner, Textarea, useToast } from '@/components/ui';

interface ModelSummary {
  id: string;
  name: string;
  description: string | null;
  category: string;
  items_count: number;
  active: boolean;
}

interface ChecklistItem {
  key: string;
  modelItemId: string | null;
  section: string | null;
  name: string;
  description: string | null;
  kind: 'FILE' | 'TEXT';
  required: boolean;
  allowMultiple: boolean;
  bothSides: boolean;
  maxFiles: number;
  included: boolean;
  evaluation?: { applicable: boolean; awaitingAnswer: boolean; conditional: boolean; reason: string | null; required: boolean };
  conditions?: string[];
}

const CATEGORY_ICON: Record<string, string> = { ADMISSAO: '👷', TRANSPORTE: '🚚', LOCACAO: '🚜', PRESTADOR: '🛠️', OUTRO: '📄' };

function renderPreview(tpl: string, vars: Record<string, string>) {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  const map = new Map(Object.entries(vars).filter(([, v]) => v).map(([k, v]) => [norm(k), v]));
  return tpl.replace(/\[([A-Za-zÀ-ú0-9_ ]+)\]/g, (w, n: string) => map.get(norm(n)) ?? w);
}

export default function NewRequestPage() {
  const user = useUser();
  const toast = useToast();
  const [step, setStep] = useState(1);
  const [models, setModels] = useState<ModelSummary[] | null>(null);
  const [model, setModel] = useState<any | null>(null);
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [form, setForm] = useState({
    name: '',
    document: '',
    phone: '',
    email: '',
    notifyEmail: '',
    notes: '',
    responsibleUserId: user.id,
    deadline: '',
  });
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<'SEPARATE' | 'SINGLE_FILE'>('SEPARATE');
  const [sendEmail, setSendEmail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; code: string; link: string | null } | null>(null);
  const previewSeq = useRef(0);

  useEffect(() => {
    api<ModelSummary[]>('/models?active=true').then(setModels).catch((e) => toast('error', e.message));
    api('/users/options').then(setUsers).catch(() => undefined);
  }, [toast]);

  async function chooseModel(id: string) {
    const prev = await api('/requests/preview', { body: { modelId: id, answers: {} } });
    const m = prev.model;
    setModel(m);
    setMode(m.submission_mode);
    setMessage(m.default_message ?? '');
    setAnswers({});
    setForm((f) => ({ ...f, deadline: m.default_deadline_days ? todayPlus(m.default_deadline_days) : '' }));
    setItems(
      prev.items.map((it: any) => ({
        key: it.id,
        modelItemId: it.id,
        section: it.section,
        name: it.name,
        description: it.description,
        kind: it.kind,
        required: it.required,
        allowMultiple: it.allow_multiple,
        bothSides: it.both_sides,
        maxFiles: it.max_files,
        included: true,
        evaluation: it.evaluation,
        conditions: it.conditions,
      })),
    );
    setStep(2);
  }

  // reavalia regras condicionais no servidor quando as respostas mudam
  useEffect(() => {
    if (!model) return;
    const seq = ++previewSeq.current;
    const t = setTimeout(async () => {
      try {
        const clean = Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== '' && v !== null && v !== undefined));
        const prev = await api('/requests/preview', { body: { modelId: model.id, answers: clean } });
        if (seq !== previewSeq.current) return;
        const byId = new Map<string, any>(prev.items.map((i: any) => [i.id, i]));
        setItems((list) => list.map((it) => (it.modelItemId && byId.has(it.modelItemId) ? { ...it, evaluation: byId.get(it.modelItemId).evaluation } : it)));
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [answers, model]);

  const internalQs = useMemo(() => (model?.questions ?? []).filter((q: any) => q.answered_by === 'INTERNAL'), [model]);
  const ruleQuestionIds = useMemo(() => new Set((model?.rules ?? []).map((r: any) => r.question_id)), [model]);
  const applicantRuleQs = useMemo(() => (model?.questions ?? []).filter((q: any) => q.answered_by === 'APPLICANT' && ruleQuestionIds.has(q.id)), [model, ruleQuestionIds]);

  const vars = useMemo(() => {
    const v: Record<string, string> = { nome: form.name, tipo: model?.name ?? '' };
    for (const q of model?.questions ?? []) {
      const a = answers[q.key];
      if (a !== undefined && a !== null && a !== '') {
        const opt = (q.options ?? []).find((o: any) => typeof o === 'object' && String(o.value) === String(a));
        v[q.key] = opt ? opt.label : typeof a === 'boolean' ? (a ? 'Sim' : 'Não') : String(a);
      }
    }
    return v;
  }, [form.name, answers, model]);

  function move(i: number, d: -1 | 1) {
    setItems((list) => {
      const j = i + d;
      if (j < 0 || j >= list.length) return list;
      const copy = [...list];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }

  function patchItem(i: number, p: Partial<ChecklistItem>) {
    setItems((list) => list.map((it, n) => (n === i ? { ...it, ...p } : it)));
  }

  function addCustom() {
    setItems((list) => [
      ...list,
      { key: `custom-${Date.now()}`, modelItemId: null, section: null, name: '', description: null, kind: 'FILE', required: true, allowMultiple: false, bothSides: false, maxFiles: 10, included: true },
    ]);
  }

  function validateData() {
    if (form.name.trim().length < 2) return 'Informe o nome / razão social.';
    for (const q of internalQs) {
      if (q.required && (answers[q.key] === undefined || answers[q.key] === null || answers[q.key] === '')) return `Responda: ${q.label}`;
    }
    return null;
  }

  async function submit(generateLink: boolean) {
    setError(null);
    const included = items.filter((i) => i.included);
    if (!included.length) return setError('Inclua ao menos um documento no checklist.');
    if (included.some((i) => !i.name.trim())) return setError('Há documento sem nome no checklist.');
    setSaving(true);
    try {
      const clean = Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== '' && v !== undefined));
      const res = await api('/requests', {
        body: {
          modelId: model.id,
          applicant: { name: form.name, document: form.document || null, phone: form.phone || null, email: form.email || null },
          notifyEmail: form.notifyEmail || null,
          notes: form.notes || null,
          responsibleUserId: form.responsibleUserId || null,
          deadline: form.deadline || null,
          message,
          submissionMode: mode,
          answers: clean,
          items: included.map((i) => ({
            modelItemId: i.modelItemId,
            section: i.section,
            name: i.name.trim(),
            description: i.description,
            kind: i.kind,
            required: i.required,
            allowMultiple: i.allowMultiple,
            bothSides: i.bothSides,
            maxFiles: i.maxFiles,
          })),
          generateLink,
          sendEmailToApplicant: generateLink && sendEmail,
        },
      });
      setResult(res);
      setStep(4);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const Steps = (
    <ol className="mb-6 flex flex-wrap gap-2 text-sm">
      {['Modelo', 'Solicitante', 'Checklist', 'Link'].map((s, i) => (
        <li key={s} className={cx('flex items-center gap-2 rounded-full px-3 py-1 font-semibold', step === i + 1 ? 'bg-ink text-brand' : step > i + 1 ? 'bg-brand text-ink' : 'bg-white text-neutral-500 ring-1 ring-neutral-200')}>
          <span>{i + 1}</span> {s}
        </li>
      ))}
    </ol>
  );

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 text-2xl font-bold">Nova solicitação</h1>
      <p className="mb-4 text-sm text-neutral-500">Escolha o modelo, informe o solicitante, confira o checklist e gere o link exclusivo.</p>
      {Steps}
      {error && (
        <div className="mb-4">
          <Alert kind="error">{error}</Alert>
        </div>
      )}

      {step === 1 && (
        <div>
          {!models ? (
            <Spinner />
          ) : models.length === 0 ? (
            <EmptyState title="Nenhum modelo ativo">
              <Link href="/modelos" className="underline">
                Cadastre um modelo
              </Link>
            </EmptyState>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {models.map((m) => (
                <button key={m.id} onClick={() => chooseModel(m.id).catch((e) => toast('error', e.message))} className="rounded-lg bg-white p-4 text-left shadow-card ring-1 ring-neutral-200 transition hover:ring-2 hover:ring-ink">
                  <div className="text-2xl">{CATEGORY_ICON[m.category] ?? '📄'}</div>
                  <p className="mt-2 font-bold">{m.name}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-neutral-500">{m.description}</p>
                  <p className="mt-2 text-xs font-semibold text-neutral-700">{m.items_count} documento(s)</p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {step === 2 && model && (
        <div className="space-y-4">
          <Card title={`Solicitante — ${model.name}`}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nome / Razão social" required>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
              </Field>
              <Field label="CPF/CNPJ">
                <Input value={form.document} inputMode="numeric" onChange={(e) => setForm({ ...form, document: maskDocInput(e.target.value) })} />
              </Field>
              <Field label="Telefone (WhatsApp)">
                <Input value={form.phone} inputMode="tel" onChange={(e) => setForm({ ...form, phone: maskPhone(e.target.value) })} />
              </Field>
              <Field label="E-mail do solicitante">
                <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
              <Field label="Responsável">
                <Select value={form.responsibleUserId} onChange={(e) => setForm({ ...form, responsibleUserId: e.target.value })}>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Prazo">
                <Input type="date" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
              </Field>
              <Field label="E-mail para receber o PDF final" hint="Se vazio, usa o e-mail padrão configurado no sistema.">
                <Input type="email" value={form.notifyEmail} onChange={(e) => setForm({ ...form, notifyEmail: e.target.value })} />
              </Field>
              <Field label="Observações internas">
                <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="min-h-[42px]" />
              </Field>
            </div>
          </Card>

          {internalQs.length > 0 && (
            <Card title="Dados do processo">
              <div className="grid gap-4 sm:grid-cols-2">
                {internalQs.map((q: any) => (
                  <Field key={q.key} label={q.label} hint={q.help_text} required={q.required}>
                    <QuestionInput q={q} value={answers[q.key]} onChange={(v) => setAnswers((a) => ({ ...a, [q.key]: v }))} />
                  </Field>
                ))}
              </div>
            </Card>
          )}

          {applicantRuleQs.length > 0 && (
            <Card title="Perguntas condicionais (opcional)">
              <p className="mb-3 text-sm text-neutral-500">
                Estas perguntas alteram os documentos solicitados. Se você já souber as respostas, preencha agora; caso contrário, o solicitante responderá pelo link.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                {applicantRuleQs.map((q: any) => (
                  <Field key={q.key} label={q.label} hint={q.help_text}>
                    <QuestionInput q={q} value={answers[q.key]} onChange={(v) => setAnswers((a) => ({ ...a, [q.key]: v }))} />
                  </Field>
                ))}
              </div>
            </Card>
          )}

          <div className="flex justify-between">
            <Button onClick={() => setStep(1)}>Voltar</Button>
            <Button
              variant="dark"
              onClick={() => {
                const err = validateData();
                if (err) return setError(err);
                setError(null);
                setStep(3);
              }}
            >
              Continuar
            </Button>
          </div>
        </div>
      )}

      {step === 3 && model && (
        <div className="space-y-4">
          <Card
            title={`Checklist (${items.filter((i) => i.included).length} itens)`}
            actions={
              <Button size="sm" onClick={addCustom}>
                + Adicionar documento
              </Button>
            }
            bodyClass="p-0"
          >
            <div className="border-b bg-neutral-50 px-4 py-3">
              <p className="mb-2 text-xs font-bold uppercase text-neutral-500">Forma de envio</p>
              <div className="flex flex-wrap gap-2">
                {[
                  { v: 'SEPARATE', l: 'Documentos separados (conferência item a item)' },
                  { v: 'SINGLE_FILE', l: 'Um único PDF com todos os documentos' },
                ].map((o) => (
                  <button
                    key={o.v}
                    onClick={() => setMode(o.v as any)}
                    className={cx('rounded-md px-3 py-2 text-sm font-semibold ring-1 ring-inset', mode === o.v ? 'bg-ink text-white ring-ink' : 'bg-white ring-neutral-300')}
                  >
                    {o.l}
                  </button>
                ))}
              </div>
              {mode === 'SINGLE_FILE' && (
                <p className="mt-2 text-xs text-neutral-600">
                  O solicitante enviará um único arquivo &quot;{model.single_file_label}&quot; contendo os documentos abaixo, nesta ordem. Itens de texto (ex.: telefone) continuam separados.
                </p>
              )}
            </div>
            {items.length === 0 && (
              <div className="p-4">
                <EmptyState title="Checklist vazio">Adicione os documentos que devem ser solicitados.</EmptyState>
              </div>
            )}
            <ul className="divide-y">
              {items.map((it, i) => {
                const ev = it.evaluation;
                return (
                  <li key={it.key} className={cx('px-4 py-3', !it.included && 'bg-neutral-50 opacity-60')}>
                    <div className="flex items-start gap-3">
                      <div className="pt-1">
                        <Checkbox checked={it.included} onChange={(v) => patchItem(i, { included: v })} />
                      </div>
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="w-6 text-xs font-bold text-neutral-400">{String(i + 1).padStart(2, '0')}</span>
                          {it.modelItemId ? (
                            <span className="font-semibold">{it.name}</span>
                          ) : (
                            <Input value={it.name} placeholder="Nome do documento" onChange={(e) => patchItem(i, { name: e.target.value })} className="max-w-sm" />
                          )}
                          {it.kind === 'TEXT' && <Badge className="bg-violet-50 text-violet-800 ring-violet-200">Texto</Badge>}
                          {!it.modelItemId && <Badge className="bg-brand-100 text-ink ring-brand-500">Adicionado</Badge>}
                          {ev?.conditional && (
                            <Badge className={ev.applicable ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-neutral-100 text-neutral-600 ring-neutral-300'}>
                              {ev.applicable ? 'Condicional: será solicitado' : ev.awaitingAnswer ? 'Condicional: depende de resposta' : 'Condicional: N/A'}
                            </Badge>
                          )}
                        </div>
                        {it.section && <p className="text-xs text-neutral-500">{it.section}</p>}
                        {ev?.conditional && ev.reason && <p className="text-xs text-neutral-500">{ev.reason}</p>}
                        {it.included && (
                          <div className="flex flex-wrap gap-x-4 gap-y-1">
                            <Checkbox checked={it.required} onChange={(v) => patchItem(i, { required: v })} label="Obrigatório" />
                            {it.kind === 'FILE' && mode === 'SEPARATE' && (
                              <>
                                <Checkbox checked={it.bothSides} onChange={(v) => patchItem(i, { bothSides: v })} label="Frente e verso" />
                                {!it.bothSides && <Checkbox checked={it.allowMultiple} onChange={(v) => patchItem(i, { allowMultiple: v })} label="Vários arquivos" />}
                              </>
                            )}
                            {!it.modelItemId && (
                              <Select value={it.kind} onChange={(e) => patchItem(i, { kind: e.target.value as any })} className="w-auto py-1 text-xs">
                                <option value="FILE">Arquivo</option>
                                <option value="TEXT">Texto</option>
                              </Select>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col gap-1">
                        <Button size="sm" variant="ghost" onClick={() => move(i, -1)} aria-label="Subir" disabled={i === 0}>
                          ▲
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => move(i, 1)} aria-label="Descer" disabled={i === items.length - 1}>
                          ▼
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card title="Mensagem ao solicitante">
            <div className="grid gap-4 lg:grid-cols-2">
              <Field label="Texto (editável)" hint="Variáveis: [NOME], [TIPO] e as chaves das perguntas, ex.: [EQUIPAMENTO].">
                <Textarea value={message} onChange={(e) => setMessage(e.target.value)} className="min-h-[260px] font-mono text-xs" />
              </Field>
              <div>
                <p className="mb-1 text-sm font-medium">Pré-visualização</p>
                <div className="min-h-[260px] whitespace-pre-wrap rounded-md bg-neutral-50 p-3 text-sm ring-1 ring-neutral-200">{renderPreview(message, vars)}</div>
              </div>
            </div>
            {form.email && (
              <div className="mt-3">
                <Checkbox checked={sendEmail} onChange={setSendEmail} label={`Enviar também o link por e-mail para ${form.email}`} />
              </div>
            )}
          </Card>

          <div className="flex flex-wrap justify-between gap-2">
            <Button onClick={() => setStep(2)}>Voltar</Button>
            <div className="flex gap-2">
              <Button onClick={() => submit(false)} loading={saving}>
                Salvar rascunho
              </Button>
              <Button variant="primary" size="lg" onClick={() => submit(true)} loading={saving}>
                GERAR LINK
              </Button>
            </div>
          </div>
        </div>
      )}

      {step === 4 && result && (
        <Card title={`Solicitação ${result.code} criada`}>
          {result.link ? (
            <div className="space-y-4">
              <Alert kind="success">Link exclusivo gerado. Envie para {form.name} pelo WhatsApp ou e-mail.</Alert>
              <ShareLink requestId={result.id} link={result.link} message={renderPreview(message, vars)} phone={form.phone} />
            </div>
          ) : (
            <Alert kind="info">Rascunho salvo. Gere o link quando quiser na tela do processo.</Alert>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href={`/solicitacoes/${result.id}`}>
              <Button variant="dark">Abrir processo</Button>
            </Link>
            <Button
              onClick={() => {
                setResult(null);
                setModel(null);
                setStep(1);
                setForm({ name: '', document: '', phone: '', email: '', notifyEmail: '', notes: '', responsibleUserId: user.id, deadline: '' });
              }}
            >
              Nova solicitação
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
