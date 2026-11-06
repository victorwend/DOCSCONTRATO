'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { api, downloadFile } from '@/lib/api';
import { markingLabel } from '@/lib/format';
import { can, useUser } from '@/components/session';
import { Alert, Badge, Button, Card, Checkbox, cx, Field, Input, Select, Spinner, Textarea, useToast } from '@/components/ui';

type FieldDef = { key: string; label: string; type: string; required: boolean; group?: string | null; help?: string | null; source?: string | null; format?: string | null };
type Slot = {
  id: string;
  part: string;
  text: string;
  type: 'PLACEHOLDER' | 'CHECKBOX' | 'GUIDE' | 'MARKED_TEXT';
  marked: boolean;
  marking: string | null;
  before: string;
  after: string;
  label: string;
  action: 'FIELD' | 'KEEP' | 'CLEAR';
  field: string | null;
};
type Source = { path: string; label: string; group: string };

const TYPES = [
  { value: 'TEXT', label: 'Texto' },
  { value: 'LONGTEXT', label: 'Texto longo' },
  { value: 'DATE', label: 'Data' },
  { value: 'MONEY', label: 'Valor (R$)' },
  { value: 'NUMBER', label: 'Número' },
  { value: 'CHECK', label: 'Marcação ( X )' },
];
const SLOT_TYPE: Record<Slot['type'], string> = { PLACEHOLDER: 'Marcador', CHECKBOX: 'Caixa ( )', GUIDE: 'Texto-guia', MARKED_TEXT: 'Texto destacado' };

type Filter = 'mapped' | 'marked' | 'unmarked' | 'all';

function partLabel(part: string) {
  if (part.includes('header')) return 'Cabeçalho';
  if (part.includes('footer')) return 'Rodapé';
  if (part.includes('note')) return 'Notas';
  return 'Corpo';
}

function slugKey(label: string) {
  const s = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\bn[o]?\s*[º°]|\bn\.(?=\s)/g, 'numero')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return /^[a-z]/.test(s) ? s : `campo_${s || 'x'}`;
}

export default function ContractTemplatePage() {
  const { id } = useParams<{ id: string }>();
  const user = useUser();
  const toast = useToast();
  const manage = can(user, 'models.manage');
  const [loaded, setLoaded] = useState<any | null>(null);
  const [meta, setMeta] = useState({ name: '', description: '', modelId: '', active: true, removeMarking: false, outputPattern: 'CONTRATO_[NOME]' });
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [filter, setFilter] = useState<Filter>('mapped');
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  async function load() {
    try {
      const d = await api(`/contract-templates/${id}`);
      setLoaded(d);
      const t = d.template;
      setMeta({
        name: t.name,
        description: t.description ?? '',
        modelId: t.model_id ?? '',
        active: t.active,
        removeMarking: t.remove_marking,
        outputPattern: t.output_pattern,
      });
      setFields(t.fields);
      setSlots(d.slots);
      setDirty(false);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  useEffect(() => {
    load();
    api('/models').then(setModels).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of slots) if (s.action === 'FIELD' && s.field) m.set(s.field, (m.get(s.field) ?? 0) + 1);
    return m;
  }, [slots]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return slots.filter((s) => {
      if (filter === 'mapped' && s.action !== 'FIELD') return false;
      if (filter === 'marked' && !(s.marked && s.action !== 'FIELD')) return false;
      if (filter === 'unmarked' && (s.marked || s.action === 'FIELD')) return false;
      if (q && !`${s.before} ${s.text} ${s.after} ${s.label}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [slots, filter, query]);

  if (!loaded) {
    return (
      <div className="flex justify-center p-10">
        <Spinner />
      </div>
    );
  }

  const sources: Source[] = loaded.sources;
  const formats: Array<{ value: string; label: string }> = loaded.formats;
  const sourceGroups = [...new Set(sources.map((s) => s.group))];

  const touch = () => setDirty(true);
  const updateField = (key: string, patch: Partial<FieldDef>) => {
    setFields((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)));
    touch();
  };
  const updateSlot = (sid: string, patch: Partial<Slot>) => {
    setSlots((ss) => ss.map((s) => (s.id === sid ? { ...s, ...patch } : s)));
    touch();
  };
  const newField = (label: string, slot?: Slot): string => {
    const base = slugKey(label);
    let key = base;
    let n = 2;
    const keys = new Set(fields.map((f) => f.key));
    while (keys.has(key)) key = `${base}_${n++}`;
    setFields((fs) => [...fs, { key, label, type: slot?.type === 'CHECKBOX' ? 'CHECK' : 'TEXT', required: slot?.type !== 'CHECKBOX', group: null, source: null, format: null }]);
    touch();
    return key;
  };
  const removeField = (key: string) => {
    if ((usage.get(key) ?? 0) > 0 && !confirm('Este campo está ligado a trechos do contrato. Remover o campo e manter esses trechos como estão?')) return;
    setFields((fs) => fs.filter((f) => f.key !== key));
    setSlots((ss) => ss.map((s) => (s.field === key ? { ...s, action: 'KEEP', field: null } : s)));
    touch();
  };

  async function save() {
    setSaving(true);
    try {
      const used = new Set(slots.filter((s) => s.action === 'FIELD').map((s) => s.field));
      const orphan = fields.filter((f) => !used.has(f.key));
      await api(`/contract-templates/${id}`, {
        method: 'PUT',
        body: {
          ...meta,
          modelId: meta.modelId || null,
          description: meta.description || null,
          fields: fields.map((f) => ({ ...f, group: f.group || null, source: f.source || null, format: f.format || null, help: f.help || null })),
          slots: slots.map((s) => ({ id: s.id, action: s.action, field: s.action === 'FIELD' ? s.field : null })),
        },
      });
      toast('success', orphan.length ? `Salvo. ${orphan.length} campo(s) não estão ligados a nenhum trecho.` : 'Modelo de contrato salvo.');
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function dl(path: string, name: string) {
    if (dirty && path.includes('preview')) toast('info', 'Salve antes para testar as alterações mais recentes.');
    try {
      await downloadFile(path, name);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  const counts = {
    mapped: slots.filter((s) => s.action === 'FIELD').length,
    marked: slots.filter((s) => s.marked && s.action !== 'FIELD').length,
    unmarked: slots.filter((s) => !s.marked && s.action !== 'FIELD').length,
    all: slots.length,
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/contratos" className="text-xs text-neutral-500 hover:underline">
            ← Modelos de contrato
          </Link>
          <h1 className="text-2xl font-bold">{meta.name || 'Modelo de contrato'}</h1>
          <p className="text-sm text-neutral-500">
            {loaded.template.original_name} · {markingLabel(loaded.template.marking)} · {slots.length} trechos encontrados
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => dl(`/contract-templates/${id}/original`, loaded.template.original_name)}>Baixar original</Button>
          <Button onClick={() => dl(`/contract-templates/${id}/preview`, 'TESTE.docx')}>Baixar teste preenchido</Button>
          {manage && (
            <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>
              Salvar
            </Button>
          )}
        </div>
      </div>

      {dirty && <Alert kind="warning">Há alterações não salvas.</Alert>}

      <Card title="Dados do modelo">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Nome" required>
            <Input value={meta.name} disabled={!manage} onChange={(e) => (setMeta({ ...meta, name: e.target.value }), touch())} />
          </Field>
          <Field label="Processo (modelo de documentação)" hint="Libera as respostas desse processo como origem dos dados.">
            <Select value={meta.modelId} disabled={!manage} onChange={(e) => (setMeta({ ...meta, modelId: e.target.value }), touch())}>
              <option value="">— Nenhum —</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Nome do arquivo gerado" hint="[NOME] = nome do solicitante. Ex.: CONTRATO_LOCACAO_[NOME]">
            <Input value={meta.outputPattern} disabled={!manage} onChange={(e) => (setMeta({ ...meta, outputPattern: e.target.value }), touch())} />
          </Field>
          <Field label="Descrição">
            <Textarea className="min-h-[42px]" value={meta.description} disabled={!manage} onChange={(e) => (setMeta({ ...meta, description: e.target.value }), touch())} />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-5">
          <Checkbox checked={meta.active} disabled={!manage} onChange={(v) => (setMeta({ ...meta, active: v }), touch())} label="Ativo (aparece nas solicitações)" />
          <Checkbox
            checked={meta.removeMarking}
            disabled={!manage}
            onChange={(v) => (setMeta({ ...meta, removeMarking: v }), touch())}
            label="Tirar o destaque/cor dos campos preenchidos (o restante da formatação é mantido)"
          />
        </div>
      </Card>

      <Card
        title={`Campos (${fields.length})`}
        actions={
          manage ? (
            <Button size="sm" onClick={() => newField('Novo campo')}>
              + Campo
            </Button>
          ) : null
        }
        bodyClass="p-0"
      >
        <p className="px-4 pt-3 text-xs text-neutral-500">
          Um campo é um dado (ex.: CPF do locador). Ligue o mesmo campo a vários trechos para preencher todas as ocorrências. “Origem” sugere o valor a
          partir da solicitação; o RH sempre confere antes de gerar.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase text-neutral-500">
              <tr>
                <th className="px-3 py-2">Rótulo</th>
                <th className="px-3 py-2">Grupo</th>
                <th className="px-3 py-2">Tipo</th>
                <th className="px-3 py-2">Formato</th>
                <th className="px-3 py-2">Origem dos dados</th>
                <th className="px-3 py-2 text-center">Obrig.</th>
                <th className="px-3 py-2 text-center">Trechos</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {fields.map((f) => {
                const [srcPath, srcEq] = (f.source ?? '').split('=');
                return (
                  <tr key={f.key} className={cx(!usage.get(f.key) && 'bg-amber-50/50')}>
                    <td className="px-3 py-2">
                      <Input value={f.label} disabled={!manage} onChange={(e) => updateField(f.key, { label: e.target.value })} />
                      <span className="text-[10px] text-neutral-400">{f.key}</span>
                    </td>
                    <td className="px-3 py-2">
                      <Input value={f.group ?? ''} placeholder="Ex.: Locador" disabled={!manage} onChange={(e) => updateField(f.key, { group: e.target.value })} />
                    </td>
                    <td className="px-3 py-2">
                      <Select value={f.type} disabled={!manage} onChange={(e) => updateField(f.key, { type: e.target.value })}>
                        {TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-3 py-2">
                      <Select value={f.format ?? ''} disabled={!manage || f.type === 'CHECK'} onChange={(e) => updateField(f.key, { format: e.target.value || null })}>
                        <option value="">Como digitado</option>
                        {formats.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <Select
                          value={srcPath}
                          disabled={!manage}
                          onChange={(e) => updateField(f.key, { source: e.target.value ? (srcEq !== undefined ? `${e.target.value}=${srcEq}` : e.target.value) : null })}
                        >
                          <option value="">— Digitado pelo RH —</option>
                          {sourceGroups.map((g) => (
                            <optgroup key={g} label={g}>
                              {sources
                                .filter((s) => s.group === g)
                                .map((s) => (
                                  <option key={s.path} value={s.path}>
                                    {s.label}
                                  </option>
                                ))}
                            </optgroup>
                          ))}
                          {srcPath && !sources.some((s) => s.path === srcPath) && <option value={srcPath}>{srcPath}</option>}
                        </Select>
                        {f.type === 'CHECK' && srcPath && (
                          <Input
                            className="w-28"
                            placeholder="= valor"
                            title="Marcar quando a resposta for igual a este valor (ex.: PJ, SIM)"
                            value={srcEq ?? ''}
                            disabled={!manage}
                            onChange={(e) => updateField(f.key, { source: e.target.value ? `${srcPath}=${e.target.value}` : srcPath })}
                          />
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <input type="checkbox" className="h-4 w-4 accent-ink" checked={f.required} disabled={!manage || f.type === 'CHECK'} onChange={(e) => updateField(f.key, { required: e.target.checked })} />
                    </td>
                    <td className="px-3 py-2 text-center text-xs">{usage.get(f.key) ?? 0}</td>
                    <td className="px-3 py-2 text-right">
                      {manage && (
                        <button className="text-xs text-red-600 hover:underline" onClick={() => removeField(f.key)}>
                          Remover
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Trechos do contrato" bodyClass="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          {(
            [
              ['mapped', 'Preenchidos'],
              ['marked', 'Destacados não preenchidos'],
              ['unmarked', 'Sem destaque'],
              ['all', 'Todos'],
            ] as Array<[Filter, string]>
          ).map(([k, l]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={cx('rounded-full px-3 py-1 text-xs font-semibold ring-1', filter === k ? 'bg-ink text-white ring-ink' : 'bg-white text-neutral-700 ring-neutral-300')}
            >
              {l} ({counts[k]})
            </button>
          ))}
          <Input className="ml-auto w-56" placeholder="Buscar no texto…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <p className="px-4 pt-3 text-xs text-neutral-500">
          “Sem destaque” mostra marcadores (XXXX, ____, ( )) fora do destaque. Eles ficam como estão, a menos que você decida preencher. Textos
          destacados que não são marcadores (ex.: “Diversos municípios de Minas Gerais”) também ficam como estão por padrão.
        </p>
        {shown.length === 0 ? (
          <p className="p-4 text-sm text-neutral-500">Nenhum trecho neste filtro.</p>
        ) : (
          <ul className="divide-y">
            {shown.map((s) => (
              <li key={s.id} className="grid gap-2 px-4 py-3 md:grid-cols-[1fr_420px] md:items-center">
                <div className="min-w-0">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <Badge className="bg-neutral-100 text-neutral-600 ring-neutral-300">{partLabel(s.part)}</Badge>
                    <Badge className="bg-neutral-100 text-neutral-600 ring-neutral-300">{SLOT_TYPE[s.type]}</Badge>
                    {s.marked ? (
                      <Badge className="bg-yellow-50 text-yellow-900 ring-yellow-300">{markingLabel(s.marking)}</Badge>
                    ) : (
                      <Badge className="bg-white text-neutral-500 ring-neutral-300">sem destaque</Badge>
                    )}
                  </div>
                  <p className="truncate font-mono text-xs text-neutral-700" title={`${s.before}${s.text}${s.after}`}>
                    <span className="text-neutral-400">…{s.before.slice(-60)}</span>
                    <mark className={cx('rounded px-0.5 font-bold', s.action === 'FIELD' ? 'bg-yellow-200' : s.action === 'CLEAR' ? 'bg-red-100 line-through' : 'bg-neutral-200')}>{s.text}</mark>
                    <span className="text-neutral-400">{s.after.slice(0, 40)}…</span>
                  </p>
                </div>
                <div className="flex gap-2">
                  <Select
                    className="w-40"
                    value={s.action}
                    disabled={!manage}
                    onChange={(e) => {
                      const action = e.target.value as Slot['action'];
                      if (action === 'FIELD' && !s.field) updateSlot(s.id, { action, field: newField(s.label, s) });
                      else updateSlot(s.id, { action });
                    }}
                  >
                    <option value="FIELD">Preencher com</option>
                    <option value="KEEP">Manter como está</option>
                    <option value="CLEAR">Apagar o texto</option>
                  </Select>
                  {s.action === 'FIELD' && (
                    <Select
                      value={s.field ?? ''}
                      disabled={!manage}
                      onChange={(e) => {
                        if (e.target.value === '__new') updateSlot(s.id, { field: newField(s.label, s) });
                        else updateSlot(s.id, { field: e.target.value });
                      }}
                    >
                      {fields.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.group ? `${f.group} – ` : ''}
                          {f.label}
                        </option>
                      ))}
                      <option value="__new">+ Novo campo “{s.label}”</option>
                    </Select>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {manage && (
        <div className="flex justify-end">
          <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>
            Salvar
          </Button>
        </div>
      )}
    </div>
  );
}
