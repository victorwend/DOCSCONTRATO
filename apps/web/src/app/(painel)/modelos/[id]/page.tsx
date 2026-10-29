'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { can, useUser } from '@/components/session';
import { AcceptSelect } from '@/components/AcceptSelect';
import { Alert, Badge, Button, Card, Checkbox, cx, Field, Input, Select, Spinner, Textarea, useToast } from '@/components/ui';

interface Item {
  id?: string;
  ref: string;
  section: string;
  name: string;
  description: string;
  kind: 'FILE' | 'TEXT';
  required: boolean;
  allowMultiple: boolean;
  maxFiles: number;
  bothSides: boolean;
  accept: 'ANY' | 'IMAGE' | 'PDF';
}
interface Question {
  id?: string;
  ref: string;
  key: string;
  label: string;
  helpText: string;
  type: 'BOOLEAN' | 'SELECT' | 'TEXT' | 'NUMBER' | 'DATE';
  options: any[];
  required: boolean;
  answeredBy: 'INTERNAL' | 'APPLICANT';
  section: string;
  mapsTo: string | null;
}
interface Rule {
  questionRef: string;
  operator: 'EQUALS' | 'NOT_EQUALS' | 'IN' | 'NOT_IN' | 'ANSWERED';
  value: any;
  action: 'SHOW_ITEM' | 'HIDE_ITEM' | 'REQUIRE_ITEM';
  targetRef: string;
}

const MAPS_TO = [
  ['', '—'],
  ['request.person_type', 'Tipo de pessoa da solicitação (PF/PJ)'],
  ['vehicle.plate', 'Veículo: placa'],
  ['vehicle.renavam', 'Veículo: Renavam'],
  ['vehicle.brand_model', 'Veículo: marca/modelo'],
  ['vehicle.year', 'Veículo: ano'],
  ['vehicle.color', 'Veículo: cor'],
  ['vehicle.body_type', 'Veículo: carroceria'],
  ['vehicle.axles', 'Veículo: eixos'],
  ['vehicle.load_capacity', 'Veículo: capacidade'],
  ['vehicle.pbt', 'Veículo: PBT/PBTC'],
  ['driver.name', 'Motorista: nome'],
  ['driver.cpf', 'Motorista: CPF'],
  ['driver.phone', 'Motorista: telefone'],
  ['driver.email', 'Motorista: e-mail'],
  ['driver.address', 'Motorista: endereço'],
];

const newRef = () => `new-${Math.random().toString(36).slice(2, 10)}`;
const slugKey = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'q_$1').slice(0, 50) || 'pergunta';

export default function ModelEditorPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'novo';
  const router = useRouter();
  const user = useUser();
  const toast = useToast();
  const readOnly = !can(user, 'models.manage');
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [m, setM] = useState({
    name: '',
    description: '',
    category: 'OUTRO',
    portalTitle: 'DOCUMENTAÇÃO PARA CONTRATAÇÃO',
    defaultMessage: 'Olá, [NOME].\n\nPara dar continuidade ao processo com a Pavidez Engenharia, precisamos dos documentos abaixo.\n\nEnvie arquivos completos, nítidos e legíveis.',
    defaultDeadlineDays: 7 as number | null,
    submissionMode: 'SEPARATE' as 'SEPARATE' | 'SINGLE_FILE',
    singleFileLabel: 'Documentação completa (PDF único)',
    outputFilePattern: 'DOCS_[NOME]',
    active: true,
  });
  const [items, setItems] = useState<Item[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);

  useEffect(() => {
    if (isNew) return;
    api(`/models/${id}`)
      .then((d) => {
        setM({
          name: d.name,
          description: d.description ?? '',
          category: d.category,
          portalTitle: d.portal_title,
          defaultMessage: d.default_message ?? '',
          defaultDeadlineDays: d.default_deadline_days,
          submissionMode: d.submission_mode,
          singleFileLabel: d.single_file_label,
          outputFilePattern: d.output_file_pattern,
          active: d.active,
        });
        setItems(
          d.items.map((i: any) => ({
            id: i.id, ref: i.id, section: i.section ?? '', name: i.name, description: i.description ?? '', kind: i.kind, required: i.required,
            allowMultiple: i.allow_multiple, maxFiles: i.max_files, bothSides: i.both_sides, accept: i.accept ?? 'ANY',
          })),
        );
        setQuestions(
          d.questions.map((q: any) => ({
            id: q.id, ref: q.id, key: q.key, label: q.label, helpText: q.help_text ?? '', type: q.type, options: q.options ?? [], required: q.required,
            answeredBy: q.answered_by, section: q.section ?? '', mapsTo: q.maps_to,
          })),
        );
        setRules(d.rules.map((r: any) => ({ questionRef: r.question_id, operator: r.operator, value: r.value, action: r.action, targetRef: r.target_item_id })));
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id, isNew]);

  const patchItem = (i: number, p: Partial<Item>) => setItems((l) => l.map((x, n) => (n === i ? { ...x, ...p } : x)));
  const patchQ = (i: number, p: Partial<Question>) => setQuestions((l) => l.map((x, n) => (n === i ? { ...x, ...p } : x)));
  const patchRule = (i: number, p: Partial<Rule>) => setRules((l) => l.map((x, n) => (n === i ? { ...x, ...p } : x)));
  const move = <T,>(list: T[], set: (v: T[]) => void, i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const c = [...list];
    [c[i], c[j]] = [c[j], c[i]];
    set(c);
  };

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const body = {
        ...m,
        description: m.description || null,
        defaultMessage: m.defaultMessage || null,
        defaultDeadlineDays: m.defaultDeadlineDays || null,
        items: items.map((i) => ({ ...i, section: i.section || null, description: i.description || null })),
        questions: questions.map((q) => ({ ...q, helpText: q.helpText || null, section: q.section || null, mapsTo: q.mapsTo || null })),
        rules: rules.map((r) => ({ ...r, value: r.operator === 'ANSWERED' ? null : r.value })),
      };
      if (isNew) {
        const r = await api('/models', { body });
        toast('success', 'Modelo criado.');
        router.replace(`/modelos/${r.id}`);
      } else {
        await api(`/models/${id}`, { method: 'PUT', body });
        toast('success', 'Modelo salvo.');
      }
    } catch (e) {
      setError((e as Error).message);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner />;

  const ruleValueInput = (r: Rule, i: number) => {
    const q = questions.find((x) => x.ref === r.questionRef);
    if (r.operator === 'ANSWERED') return <span className="text-xs text-neutral-500">(qualquer resposta)</span>;
    if (q?.type === 'BOOLEAN') {
      return (
        <Select value={r.value === true ? 'true' : r.value === false ? 'false' : ''} onChange={(e) => patchRule(i, { value: e.target.value === 'true' })} disabled={readOnly}>
          <option value="">—</option>
          <option value="true">Sim</option>
          <option value="false">Não</option>
        </Select>
      );
    }
    if (q?.type === 'SELECT') {
      return (
        <Select value={String(r.value ?? '')} onChange={(e) => patchRule(i, { value: e.target.value })} disabled={readOnly}>
          <option value="">—</option>
          {q.options.map((o: any) => (
            <option key={String(o.value ?? o)} value={String(o.value ?? o)}>
              {o.label ?? o}
            </option>
          ))}
        </Select>
      );
    }
    return <Input value={Array.isArray(r.value) ? r.value.join(', ') : String(r.value ?? '')} onChange={(e) => patchRule(i, { value: r.operator === 'IN' || r.operator === 'NOT_IN' ? e.target.value.split(',').map((s) => s.trim()) : e.target.value })} disabled={readOnly} />;
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/modelos" className="text-xs text-neutral-500 hover:underline">
            ← Modelos
          </Link>
          <h1 className="text-2xl font-bold">{isNew ? 'Novo modelo' : m.name}</h1>
        </div>
        {!readOnly && (
          <Button variant="primary" size="lg" onClick={save} loading={saving}>
            Salvar modelo
          </Button>
        )}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {!isNew && <Alert kind="info">Alterações valem para novas solicitações. Processos já criados mantêm o checklist e as regras do momento da criação.</Alert>}

      <Card title="Informações">
        <fieldset disabled={readOnly} className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome" required>
            <Input value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} placeholder="Ex.: Contrato de aluguel de veículo" />
          </Field>
          <Field label="Categoria">
            <Select value={m.category} onChange={(e) => setM({ ...m, category: e.target.value })}>
              <option value="ADMISSAO">Admissão</option>
              <option value="TRANSPORTE">Transporte</option>
              <option value="LOCACAO">Locação</option>
              <option value="PRESTADOR">Prestador / fornecedor</option>
              <option value="OUTRO">Outro</option>
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Descrição">
              <Input value={m.description} onChange={(e) => setM({ ...m, description: e.target.value })} />
            </Field>
          </div>
          <Field label="Título exibido ao solicitante">
            <Input value={m.portalTitle} onChange={(e) => setM({ ...m, portalTitle: e.target.value })} />
          </Field>
          <Field label="Prazo padrão (dias)">
            <Input type="number" min={1} max={365} value={m.defaultDeadlineDays ?? ''} onChange={(e) => setM({ ...m, defaultDeadlineDays: e.target.value ? Number(e.target.value) : null })} />
          </Field>
          <Field label="Forma de envio padrão">
            <Select value={m.submissionMode} onChange={(e) => setM({ ...m, submissionMode: e.target.value as any })}>
              <option value="SEPARATE">Documentos separados</option>
              <option value="SINGLE_FILE">Um único PDF</option>
            </Select>
          </Field>
          <Field label="Nome do arquivo final" hint="Use [NOME], [TIPO] ou chaves de perguntas, ex.: LOCACAO_[EQUIPAMENTO]_[NOME]">
            <Input value={m.outputFilePattern} onChange={(e) => setM({ ...m, outputFilePattern: e.target.value })} />
          </Field>
          {m.submissionMode === 'SINGLE_FILE' && (
            <Field label="Nome do item “PDF único”">
              <Input value={m.singleFileLabel} onChange={(e) => setM({ ...m, singleFileLabel: e.target.value })} />
            </Field>
          )}
          <div className="sm:col-span-2">
            <Field label="Mensagem padrão ao solicitante" hint="Editável em cada solicitação antes de gerar o link.">
              <Textarea value={m.defaultMessage} onChange={(e) => setM({ ...m, defaultMessage: e.target.value })} className="min-h-[180px]" />
            </Field>
          </div>
          <Checkbox checked={m.active} onChange={(v) => setM({ ...m, active: v })} label="Modelo ativo (aparece em Nova solicitação)" />
        </fieldset>
      </Card>

      <Card
        title={`Documentos (${items.length})`}
        actions={
          !readOnly && (
            <Button size="sm" onClick={() => setItems((l) => [...l, { ref: newRef(), section: '', name: '', description: '', kind: 'FILE', required: true, allowMultiple: false, maxFiles: 10, bothSides: false, accept: 'ANY' }])}>
              + Documento
            </Button>
          )
        }
        bodyClass="p-0"
      >
        {items.length === 0 && <p className="p-4 text-sm text-neutral-500">Nenhum documento. Adicione os itens do checklist na ordem em que devem aparecer no PDF final.</p>}
        <ul className="divide-y">
          {items.map((it, i) => (
            <li key={it.ref} className="px-4 py-3">
              <fieldset disabled={readOnly} className="flex gap-3">
                <span className="w-6 pt-2 text-xs font-bold text-neutral-400">{String(i + 1).padStart(2, '0')}</span>
                <div className="grid flex-1 gap-2 sm:grid-cols-6">
                  <Input className="sm:col-span-3" placeholder="Nome do documento" value={it.name} onChange={(e) => patchItem(i, { name: e.target.value })} />
                  <Input className="sm:col-span-2" placeholder="Seção (opcional)" value={it.section} onChange={(e) => patchItem(i, { section: e.target.value })} />
                  <Select value={it.kind} onChange={(e) => patchItem(i, { kind: e.target.value as any })}>
                    <option value="FILE">Arquivo</option>
                    <option value="TEXT">Texto</option>
                  </Select>
                  <Input className="sm:col-span-6" placeholder="Instruções ao solicitante (opcional)" value={it.description} onChange={(e) => patchItem(i, { description: e.target.value })} />
                  <div className="flex flex-wrap gap-4 sm:col-span-6">
                    <Checkbox checked={it.required} onChange={(v) => patchItem(i, { required: v })} label="Obrigatório" disabled={readOnly} />
                    {it.kind === 'FILE' && <Checkbox checked={it.bothSides} onChange={(v) => patchItem(i, { bothSides: v })} label="Frente e verso" disabled={readOnly} />}
                    {it.kind === 'FILE' && !it.bothSides && <Checkbox checked={it.allowMultiple} onChange={(v) => patchItem(i, { allowMultiple: v })} label="Vários arquivos" disabled={readOnly} />}
                    {it.kind === 'FILE' && <AcceptSelect value={it.accept} onChange={(v) => patchItem(i, { accept: v })} disabled={readOnly} />}
                    {rules.some((r) => r.targetRef === it.ref) && <Badge className="bg-sky-50 text-sky-800 ring-sky-200">Condicional</Badge>}
                  </div>
                </div>
                {!readOnly && (
                  <div className="flex flex-col gap-1">
                    <Button size="sm" variant="ghost" onClick={() => move(items, setItems, i, -1)} aria-label="Subir">▲</Button>
                    <Button size="sm" variant="ghost" onClick={() => move(items, setItems, i, 1)} aria-label="Descer">▼</Button>
                    <Button size="sm" variant="ghost" className="text-red-700" aria-label="Remover" onClick={() => { setItems((l) => l.filter((_, n) => n !== i)); setRules((l) => l.filter((r) => r.targetRef !== it.ref)); }}>✕</Button>
                  </div>
                )}
              </fieldset>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title={`Perguntas (${questions.length})`}
        actions={
          !readOnly && (
            <Button size="sm" onClick={() => setQuestions((l) => [...l, { ref: newRef(), key: '', label: '', helpText: '', type: 'BOOLEAN', options: [], required: false, answeredBy: 'APPLICANT', section: '', mapsTo: null }])}>
              + Pergunta
            </Button>
          )
        }
        bodyClass="p-0"
      >
        {questions.length === 0 && <p className="p-4 text-sm text-neutral-500">Perguntas coletam dados (ex.: placa) ou controlam regras (ex.: “O veículo está em nome de outra pessoa?”).</p>}
        <ul className="divide-y">
          {questions.map((q, i) => (
            <li key={q.ref} className="px-4 py-3">
              <fieldset disabled={readOnly} className="flex gap-3">
                <div className="grid flex-1 gap-2 sm:grid-cols-6">
                  <Input className="sm:col-span-4" placeholder="Pergunta" value={q.label} onChange={(e) => patchQ(i, { label: e.target.value, key: q.id ? q.key : slugKey(e.target.value) })} />
                  <Input className="sm:col-span-2 font-mono text-xs" placeholder="chave" value={q.key} onChange={(e) => patchQ(i, { key: e.target.value })} title="Chave usada em regras e variáveis [CHAVE]" />
                  <Select value={q.type} onChange={(e) => patchQ(i, { type: e.target.value as any, options: e.target.value === 'SELECT' && !q.options.length ? [{ value: 'OPCAO_1', label: 'Opção 1' }] : q.options })}>
                    <option value="BOOLEAN">Sim/Não</option>
                    <option value="SELECT">Seleção</option>
                    <option value="TEXT">Texto</option>
                    <option value="NUMBER">Número</option>
                    <option value="DATE">Data</option>
                  </Select>
                  <Select value={q.answeredBy} onChange={(e) => patchQ(i, { answeredBy: e.target.value as any })}>
                    <option value="APPLICANT">Respondida pelo solicitante</option>
                    <option value="INTERNAL">Respondida pelo RH</option>
                  </Select>
                  <Input className="sm:col-span-2" placeholder="Seção (opcional)" value={q.section} onChange={(e) => patchQ(i, { section: e.target.value })} />
                  <Select className="sm:col-span-2" value={q.mapsTo ?? ''} onChange={(e) => patchQ(i, { mapsTo: e.target.value || null })} title="Grava a resposta no cadastro de veículo/motorista">
                    {MAPS_TO.map(([v, l]) => (
                      <option key={v} value={v}>
                        {v ? `Cadastro → ${l}` : 'Não vincular a cadastro'}
                      </option>
                    ))}
                  </Select>
                  <Input className="sm:col-span-4" placeholder="Ajuda (opcional)" value={q.helpText} onChange={(e) => patchQ(i, { helpText: e.target.value })} />
                  {(q.type === 'SELECT' || q.type === 'TEXT') && (
                    <OptionsInput type={q.type} options={q.options} onChange={(options) => patchQ(i, { options })} />
                  )}
                  <div className="sm:col-span-6">
                    <Checkbox checked={q.required} onChange={(v) => patchQ(i, { required: v })} label="Resposta obrigatória" disabled={readOnly} />
                  </div>
                </div>
                {!readOnly && (
                  <div className="flex flex-col gap-1">
                    <Button size="sm" variant="ghost" onClick={() => move(questions, setQuestions, i, -1)}>▲</Button>
                    <Button size="sm" variant="ghost" onClick={() => move(questions, setQuestions, i, 1)}>▼</Button>
                    <Button size="sm" variant="ghost" className="text-red-700" onClick={() => { setQuestions((l) => l.filter((_, n) => n !== i)); setRules((l) => l.filter((r) => r.questionRef !== q.ref)); }}>✕</Button>
                  </div>
                )}
              </fieldset>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title={`Regras condicionais (${rules.length})`}
        actions={
          !readOnly && questions.length > 0 && items.length > 0 && (
            <Button size="sm" onClick={() => setRules((l) => [...l, { questionRef: questions[0].ref, operator: 'EQUALS', value: true, action: 'SHOW_ITEM', targetRef: items[0].ref }])}>
              + Regra
            </Button>
          )
        }
      >
        <p className="mb-3 text-xs text-neutral-500">
          <b>Solicitar documento</b>: o documento só aparece quando a condição for verdadeira (se a resposta for outra, fica N/A). <b>Não solicitar</b>: esconde o documento. <b>Tornar obrigatório</b>: o documento passa a ser obrigatório.
        </p>
        {rules.length === 0 && <p className="text-sm text-neutral-500">Nenhuma regra.</p>}
        <ul className="space-y-2">
          {rules.map((r, i) => (
            <li key={i} className={cx('grid items-center gap-2 rounded-md bg-neutral-50 p-2 ring-1 ring-neutral-200 sm:grid-cols-12')}>
              <span className="text-xs font-bold sm:col-span-1">SE</span>
              <Select className="sm:col-span-4" value={r.questionRef} onChange={(e) => patchRule(i, { questionRef: e.target.value, value: null })} disabled={readOnly}>
                {questions.map((q) => (
                  <option key={q.ref} value={q.ref}>
                    {q.label || q.key || '(pergunta sem título)'}
                  </option>
                ))}
              </Select>
              <Select className="sm:col-span-2" value={r.operator} onChange={(e) => patchRule(i, { operator: e.target.value as any })} disabled={readOnly}>
                <option value="EQUALS">for igual a</option>
                <option value="NOT_EQUALS">for diferente de</option>
                <option value="IN">for um de</option>
                <option value="NOT_IN">não for um de</option>
                <option value="ANSWERED">for respondida</option>
              </Select>
              <div className="sm:col-span-2">{ruleValueInput(r, i)}</div>
              <span className="text-xs font-bold sm:col-span-1">ENTÃO</span>
              <Select className="sm:col-span-2" value={r.action} onChange={(e) => patchRule(i, { action: e.target.value as any })} disabled={readOnly}>
                <option value="SHOW_ITEM">Solicitar</option>
                <option value="HIDE_ITEM">Não solicitar</option>
                <option value="REQUIRE_ITEM">Tornar obrigatório</option>
              </Select>
              <Select className="sm:col-span-11" value={r.targetRef} onChange={(e) => patchRule(i, { targetRef: e.target.value })} disabled={readOnly}>
                {items.map((it, n) => (
                  <option key={it.ref} value={it.ref}>
                    {String(n + 1).padStart(2, '0')} — {it.name || '(documento sem nome)'}
                  </option>
                ))}
              </Select>
              {!readOnly && (
                <Button size="sm" variant="ghost" className="text-red-700 sm:col-span-1" onClick={() => setRules((l) => l.filter((_, n) => n !== i))}>
                  ✕
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>

      {!readOnly && (
        <div className="flex justify-end">
          <Button variant="primary" size="lg" onClick={save} loading={saving}>
            Salvar modelo
          </Button>
        </div>
      )}
    </div>
  );
}

/** Opções digitadas como texto ("PF=Pessoa física; PJ=Pessoa jurídica"), aplicadas ao sair do campo. */
function OptionsInput({ type, options, onChange }: { type: 'SELECT' | 'TEXT'; options: any[]; onChange: (o: any[]) => void }) {
  const toText = (opts: any[]) => opts.map((o: any) => (typeof o === 'string' ? o : String(o.value) === o.label ? o.label : `${o.value}=${o.label}`)).join('; ');
  const [text, setText] = useState(toText(options));
  useEffect(() => setText(toText(options)), [options]);
  const commit = () =>
    onChange(
      text
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          if (type === 'TEXT') return s;
          const [v, ...l] = s.split('=');
          return { value: v.trim(), label: (l.join('=') || v).trim() };
        }),
    );
  return (
    <Input
      className="sm:col-span-6"
      placeholder={type === 'SELECT' ? 'Opções separadas por ; (ex.: PF=Pessoa física; PJ=Pessoa jurídica)' : 'Sugestões separadas por ; (opcional)'}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
    />
  );
}

